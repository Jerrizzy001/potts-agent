import type { Clock } from '../core/clock.ts';
import { hashCanonical } from '../core/hash.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { withTransaction, type Db } from '../store/db.ts';
import { addDays, localDateKey, localDateOf, localHhmm, dateKey } from '../jobs/tz.ts';
import type { SiteStatus } from '../monitoring/monitor.ts';
import { sanitizeDisplay, type TaskDeadlineInfo, type PriorityMailItem } from './deadlines.ts';
import type { Outbox } from './outbox.ts';
import type { Summarizer } from './summarizer.ts';
import type { UrgentEventStore } from './urgent.ts';

export type BriefingKind = 'morning' | 'evening' | 'night';

export interface BriefingItem {
  text: string;
  ref?: string;
}

export interface PendingApprovalInfo {
  id: string;
  summary: string;
  expiresAt: string;
}

export interface BriefingContext {
  kind: BriefingKind;
  slotKey: string;
  nowIso: string;
  sinceIso: string;
  timezone: string;
  localDate: string;
}

/**
 * Deterministic data providers. Each is optional; a missing provider means the
 * section is omitted, a failing one shows "(source unavailable)".
 */
export interface BriefingProviders {
  priorities?(ctx: BriefingContext): Promise<BriefingItem[]>;
  tasks?(ctx: BriefingContext): Promise<TaskDeadlineInfo[]>;
  /** Priority-category mail since ctx.sinceIso (interview, business, client, job). */
  messages?(ctx: BriefingContext): Promise<PriorityMailItem[]>;
  approvals?(ctx: BriefingContext): Promise<PendingApprovalInfo[]>;
  progress?(ctx: BriefingContext): Promise<BriefingItem[]>;
  unfinished?(ctx: BriefingContext): Promise<BriefingItem[]>;
  tomorrow?(ctx: BriefingContext): Promise<BriefingItem[]>;
}

export interface BriefingSection {
  title: string;
  lines: string[];
  unavailable?: boolean;
  emptyText?: string;
  /** Concise presentation; full evidence stays in lines. */
  ownerLines?: string[];
  recoveryIds?: string[];
  incidentEventIds?: string[];
}

export interface BriefingDraft {
  kind: BriefingKind;
  slotKey: string;
  sections: BriefingSection[];
  itemCount: number;
  materialHash: string;
  hasNewMaterial: boolean;
  routineIds: string[];
  text: string;
  summarized: boolean;
}

export interface ComposeOptions {
  late?: boolean;
  scheduledAt?: string;
  folded?: string[];
  signal?: AbortSignal;
}

export interface BriefingComposerOptions {
  db: Db;
  clock: Clock;
  timezone: string;
  providers: BriefingProviders;
  outbox: Outbox;
  urgent?: UrgentEventStore;
  monitor?: { status(sinceIso: string): SiteStatus[] };
  summarizer?: Summarizer;
  logger?: Logger;
}

export interface BriefingComposer {
  compose(kind: BriefingKind, slotKey: string, o?: ComposeOptions): Promise<BriefingDraft>;
  /** Composes and enqueues (dedup "briefing:<id>:<slot>"), folding routine items. Idempotent per slot. */
  deliver(briefingId: string, kind: BriefingKind, slotKey: string, o?: ComposeOptions): Promise<{ draft: BriefingDraft | null; duplicate: boolean }>;
}

const GREETINGS: Record<BriefingKind, string> = { morning: 'Hey, here’s what’s up this morning.', evening: 'Hey, here’s how things are looking.', night: 'Hey, a quick update before tonight’s done.' };
const RELEVANT_MAIL = new Set(['interview_invitation', 'business_enquiry', 'client_opportunity', 'job_opportunity']);
const MAIL_LABEL: Record<string, string> = {
  interview_invitation: 'Interview',
  business_enquiry: 'Business',
  client_opportunity: 'Client',
  job_opportunity: 'Job',
};

export function createBriefingComposer(o: BriefingComposerOptions): BriefingComposer {
  const { db, clock, timezone, providers } = o;
  const log = o.logger ?? nullLogger;

  const sinceDefault = () => {
    const r = db.prepare('SELECT created_at FROM briefing_log ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;
    return r?.created_at ?? new Date(clock.nowMs() - 24 * 3600_000).toISOString();
  };
  const fmtLocal = (iso: string) => {
    const ms = Date.parse(iso);
    return `${localDateKey(ms, timezone)} ${localHhmm(ms, timezone)}`;
  };

  async function section<T>(title: string, fn: (() => Promise<T[]>) | undefined, render: (x: T) => string | null, empty = 'Nothing new.'): Promise<BriefingSection | null> {
    if (!fn) return null;
    try {
      const items = await fn();
      const lines = items.map(render).filter((x): x is string => x !== null);
      return lines.length ? { title, lines } : { title, lines: [], emptyText: empty };
    } catch (e) {
      log.warn('briefing: provider failed', { section: title, error: (e as Error).message });
      return { title, lines: [], unavailable: true };
    }
  }

  async function compose(kind: BriefingKind, slotKey: string, co: ComposeOptions = {}): Promise<BriefingDraft> {
    const now = clock.nowMs();
    const ctx: BriefingContext = { kind, slotKey, nowIso: new Date(now).toISOString(), sinceIso: sinceDefault(), timezone, localDate: localDateKey(now, timezone) };
    const today = localDateOf(now, timezone);
    const tomorrowKey = dateKey(addDays(today, 1));
    const sections: (BriefingSection | null)[] = [];
    const tasks = providers.tasks ? () => providers.tasks!(ctx) : undefined;
    const openTasks = tasks
      ? async () => (await tasks()).filter((a) => !a.completed && Number.isFinite(Date.parse(a.dueAt))).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      : undefined;
    const renderTask = (a: TaskDeadlineInfo) => `${Date.parse(a.dueAt) <= now ? 'Overdue: ' : ''}${fmtLocal(a.dueAt)} — ${sanitizeDisplay(a.project, 40)}: ${sanitizeDisplay(a.title, 90)}${a.completionStatusKnown === false ? ' (completion unverified)' : ''}`;
    const urgentLines = () => (o.urgent?.listOpen() ?? []).map((e) => e.title);

    // Routine items held for the briefing (overnight notes, recoveries, monitoring gaps).
    const routine = o.outbox.pendingRoutine();
    const routineSection: BriefingSection = { title: kind === 'morning' ? 'Overnight and since last briefing' : 'Since last briefing', lines: routine.map((n) => sanitizeDisplay(n.text, 300)) };

    if (kind === 'morning') {
      sections.push(routine.length ? routineSection : null);
      sections.push(await section('Priorities', providers.priorities ? () => providers.priorities!(ctx) : undefined, (i) => sanitizeDisplay(i.text, 200)));
      const ug = urgentLines();
      if (ug.length) sections.push({ title: 'Needs attention', lines: ug });
      sections.push(
        await section('Deadlines (next 48h)', openTasks ? async () => (await openTasks()).filter((a) => Date.parse(a.dueAt) - now <= 48 * 3600_000) : undefined, renderTask),
      );
      sections.push(
        await section(
          'Relevant messages',
          providers.messages ? async () => (await providers.messages!(ctx)).filter((m) => RELEVANT_MAIL.has(m.category)) : undefined,
          (m) => `${MAIL_LABEL[m.category] ?? 'Mail'}: ${sanitizeDisplay(m.from, 50)} — ${sanitizeDisplay(m.subject, 90)}`,
        ),
      );
      sections.push(websiteSection(ctx, true));
    } else if (kind === 'evening') {
      sections.push(await section('Progress today', providers.progress ? () => providers.progress!(ctx) : undefined, (i) => sanitizeDisplay(i.text, 200)));
      sections.push(await section('Unfinished work', providers.unfinished ? () => providers.unfinished!(ctx) : undefined, (i) => sanitizeDisplay(i.text, 200)));
      sections.push(
        await section('Approval requests', providers.approvals ? () => providers.approvals!(ctx) : undefined, (a) => `${sanitizeDisplay(a.summary, 150)} (expires ${fmtLocal(a.expiresAt)}, ref ${a.id})`, 'None pending.'),
      );
      sections.push(routine.length ? routineSection : null);
      sections.push(websiteSection(ctx, false));
    } else {
      sections.push(
        await section(
          "Tomorrow's prep",
          providers.tomorrow || openTasks
            ? async () => {
                const items: BriefingItem[] = providers.tomorrow ? await providers.tomorrow(ctx) : [];
                if (openTasks) for (const a of await openTasks()) if (localDateKey(Date.parse(a.dueAt), timezone) === tomorrowKey) items.push({ text: `Due tomorrow: ${renderTask(a)}` });
                return items;
              }
            : undefined,
          (i) => sanitizeDisplay(i.text, 220),
        ),
      );
      const ug = urgentLines();
      sections.push(
        await section(
          'Remaining urgent work',
          openTasks || o.urgent
            ? async () => {
                const lines = [...ug];
                if (openTasks) for (const a of await openTasks()) if (Date.parse(a.dueAt) - now <= 24 * 3600_000) lines.push(`${Date.parse(a.dueAt) > now ? 'Due within 24h: ' : ''}${renderTask(a)}`);
                return lines;
              }
            : undefined,
          (s) => s,
          'Nothing urgent.',
        ),
      );
      sections.push(await section('Approval requests', providers.approvals ? () => providers.approvals!(ctx) : undefined, (a) => `${sanitizeDisplay(a.summary, 150)} (ref ${a.id})`, 'None pending.'));
      sections.push(routine.length ? routineSection : null);
      sections.push(websiteSection(ctx, false));
    }

    const finalSections = sections.filter((s): s is BriefingSection => s !== null);
    const recoveryIds = new Set(finalSections.flatMap(s => s.recoveryIds ?? []));
    const incidentEventIds = new Set(finalSections.flatMap(s => s.incidentEventIds ?? []));
    const presentedUrgentTitles = new Set((o.urgent?.listOpen() ?? []).filter(e => incidentEventIds.has(e.id)).map(e => e.title));
    for (const section of finalSections) {
      if (['Needs attention', 'Remaining urgent work'].includes(section.title)) section.ownerLines = section.lines.filter(line => !presentedUrgentTitles.has(line));
    }
    routineSection.ownerLines = routine.filter(n => !recoveryIds.has(n.dedupKey.replace(/^incident-resolved:/, ''))).map(n => naturalRecovery(sanitizeDisplay(n.text, 300)));
    const itemCount = finalSections.reduce((n, s) => n + s.lines.length, 0);
    const materialHash = hashCanonical(finalSections.map((s) => ({ t: s.title, l: s.lines, u: s.unavailable === true })));
    const prev = db.prepare('SELECT material_hash FROM briefing_log ORDER BY created_at DESC LIMIT 1').get() as { material_hash: string } | undefined;
    const hasNewMaterial = itemCount > 0 && prev?.material_hash !== materialHash;

    const header = headerFor(kind, co);
    let overview: string | null = null;
    if (hasNewMaterial && o.summarizer) {
      overview = await o.summarizer.summarize({ kind, deterministicText: renderNaturalSections(finalSections) }, co.signal);
    }
    const naturalBody = renderNaturalSections(finalSections);
    const text = [header, overview, naturalBody || "All quiet, nothing new from the things I could check."].filter(Boolean).join('\n\n');
    return { kind, slotKey, sections: finalSections, itemCount, materialHash, hasNewMaterial, routineIds: routine.map((r) => r.id), text, summarized: overview !== null };
  }

  function websiteSection(ctx: BriefingContext, always: boolean): BriefingSection | null {
    if (!o.monitor) return null;
    const statuses = o.monitor.status(ctx.sinceIso);
    const lines: string[] = [];
    const ownerLines: string[] = [];
    const recoveryIds: string[] = [];
    const incidentEventIds: string[] = [];
    for (const s of statuses) {
      const open = s.openIncidents.map((i) => `${i.failureClass}${i.cause ? ` (${i.cause})` : ''} since ${fmtLocal(i.firstFailureAt)}${i.status === 'acknowledged' ? ', acknowledged' : ''}`);
      const label = s.localOfflineSince
        ? `unknown — this Mac has been offline since ${fmtLocal(s.localOfflineSince)}`
        : open.length
          ? open.join('; ')
          : s.lastObservation === 'ok'
            ? 'up'
            : s.lastObservation === 'unknown'
              ? 'not checked yet'
              : s.lastObservation.replace('_', ' ');
      if (!always && !open.length && !s.localOfflineSince && s.resolvedSince.length === 0) continue;
      lines.push(`${s.name}: ${label}${s.lastCheckedAt ? ` (checked ${fmtLocal(s.lastCheckedAt)})` : ''}`);
      for (const r of s.resolvedSince) lines.push(`  resolved ${r.failureClass} (${r.cause ?? 'unknown'}) ${fmtLocal(r.firstFailureAt)} → ${fmtLocal(r.resolvedAt!)}`);
      if (!s.localOfflineSince) for (const incident of s.openIncidents) if (incident.urgentEventId) incidentEventIds.push(incident.urgentEventId);
      if (s.localOfflineSince) {
        ownerLines.push(`I couldn’t check ${s.name} while your Mac was offline, starting ${fmtLocal(s.localOfflineSince)}.`);
      } else if (s.openIncidents.length) {
        for (const incident of s.openIncidents) {
          const condition = incident.failureClass === 'outage' ? 'has been unavailable' : incident.failureClass === 'degraded' ? 'has been having problems' : 'couldn’t be checked because its sign-in needs attention';
          ownerLines.push(`${s.name} ${condition} since ${fmtLocal(incident.firstFailureAt)}.${incident.status === 'acknowledged' ? ' You’ve already seen this.' : ''}`);
        }
      } else if (!s.resolvedSince.length) {
        ownerLines.push(s.lastObservation === 'ok' ? `${s.name} was working when I last checked${s.lastCheckedAt ? ` at ${fmtLocal(s.lastCheckedAt)}` : ''}.` : s.lastObservation === 'unknown' ? `I haven’t checked ${s.name} yet.` : `${s.name} needs another check; I can’t confirm it’s working yet.`);
      }
      for (const r of s.resolvedSince) {
        recoveryIds.push(r.id);
        const what = r.failureClass === 'outage' ? 'was unavailable' : r.failureClass === 'degraded' ? 'was having problems' : 'couldn’t be checked';
        ownerLines.push(`${s.name} ${what} from ${fmtLocal(r.firstFailureAt)} to ${fmtLocal(r.resolvedAt!)}. ${r.failureClass === 'monitor_auth' ? 'I could check it again after that.' : 'It recovered after that.'}`);
      }
    }
    if (!lines.length) return null;
    lines.push('(Local monitor only: it cannot check while this Mac is asleep or offline.)');
    return { title: 'Website status', lines, ownerLines, recoveryIds, incidentEventIds };
  }

  function headerFor(kind: BriefingKind, co: ComposeOptions): string {
    const parts = [GREETINGS[kind]];
    if (co.late && co.scheduledAt) parts.push(`I’m a bit late — this was due at ${localHhmm(Date.parse(co.scheduledAt), timezone)}.`);
    if (co.folded && co.folded.length) parts.push(`This also covers the missed ${co.folded.join(', ')} update${co.folded.length > 1 ? 's' : ''}.`);
    return parts.join('\n');
  }

  return {
    compose,
    async deliver(briefingId, kind, slotKey, co = {}) {
      const key = `briefing:${briefingId}:${slotKey}`;
      if (o.outbox.getByDedupKey(key)) return { draft: null, duplicate: true };
      const draft = await compose(kind, slotKey, co);
      // Keep the complete evidence in the structured activity log, including items omitted from chat.
      log.info('briefing: composed', { kind, slotKey, sections: draft.sections, materialHash: draft.materialHash });
      const res = withTransaction(db, () => {
        const r = o.outbox.enqueue({ dedupKey: key, category: 'briefing', text: draft.text });
        if (r.duplicate) return r;
        o.outbox.foldInto(draft.routineIds, key);
        db.prepare(
          `INSERT INTO briefing_log (dedup_key, briefing_id, kind, slot_key, material_hash, item_count, late, summarized, parts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(key, briefingId, kind, slotKey, draft.materialHash, draft.itemCount, co.late ? 1 : 0, draft.summarized ? 1 : 0, r.ids.length, clock.nowIso());
        return r;
      });
      return { draft: res.duplicate ? null : draft, duplicate: res.duplicate };
    },
  };
}

/** Only routine progress is shortened. Deadlines, decisions, urgent evidence and failures stay visible. */
export function renderNaturalSections(sections: BriefingSection[]): string {
  const output: string[] = [];
  for (const section of sections) {
    if (section.unavailable) {
      const subject = section.title === 'Relevant messages' ? 'your messages' : section.title.toLowerCase();
      output.push(`I couldn’t check ${subject} right now.`);
      continue;
    }
    // Priorities may contain decisions or deadlines, so never omit them.
    const routine = section.title === 'Progress today' && !section.lines.some(line => /\b(urgent|deadline|due|overdue|approve|approval|decision|blocked|failed|failure)\b/i.test(line));
    const display = section.ownerLines ?? section.lines;
    const lines = routine ? display.slice(0, 3) : display;
    for (const line of lines) output.push(line.trim());
    if (routine && section.lines.length > lines.length) output.push(`${section.lines.length - lines.length} more updates are in the activity record.`);
  }
  return output.join('\n');
}


/** Only recognizes the monitor's own recovery format, leaving task/approval references untouched. */
function naturalRecovery(text: string): string {
  const match = /^Resolved: (.+?) (outage|degradation|monitor credential problem) \([^)]+\) from (.+?) to (.+?) \(~\d+ min\)\. Ref inc_[A-Za-z0-9_-]+\.$/.exec(text);
  if (!match) return text;
  const condition = match[2] === 'outage' ? 'was unavailable' : match[2] === 'degradation' ? 'was having problems' : 'couldn’t be checked';
  return `${match[1]} ${condition} from ${match[3]} to ${match[4]}. ${match[2] === 'monitor credential problem' ? 'I could check it again after that.' : 'It recovered after that.'}`;
}
