/**
 * Local draft workspace in Potts home ($POTTS_HOME/drafts/<kind>/<id>.md,
 * metadata in the `drafts` table). Drafts are never sent or submitted from
 * here: email replies are local files (not provider drafts), and final
 * submissions/sends can only be represented as broker proposals
 * (see proposals.ts), which the owner must approve.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { sha256Hex } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { ensurePrivateDir } from '../store/home.ts';
import type { Db } from '../store/db.ts';
import { neutralize } from '../connectors/mail/injection.ts';
import type { NormalizedMail } from '../connectors/mail/types.ts';
import type { FactRecord, FactRequirement, FactSource } from './facts.ts';

export const DRAFT_KINDS = ['resume', 'cover_letter', 'application', 'email_reply', 'document', 'message'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_STATUSES = ['draft', 'ready_for_review', 'proposed', 'archived'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface SourceRef {
  type: string; // 'mail' | 'fact' | 'url' | 'brief' | 'rubric' ...
  id: string;
  label?: string;
}

export interface DraftRecord {
  id: string;
  kind: DraftKind;
  title: string;
  status: DraftStatus;
  sourceRefs: SourceRef[];
  unresolved: string[];
  meta: Record<string, unknown>;
  filePath: string;
  contentSha256: string;
  proposalActionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobMaterialInput {
  kind: 'resume' | 'cover_letter' | 'application';
  title: string;
  target: { company: string; role: string; url?: string; jobRef?: string };
  sections: { heading: string; requirements: FactRequirement[] }[];
  facts: FactSource;
  /** Free notes from the owner (kept as notes, not as facts). */
  notes?: string;
}

export interface EmailReplyInput {
  mail: NormalizedMail;
  fromAccountId: string;
  fromAddress: string;
  body: string;
  to?: string[];
}

export interface DraftWorkspace {
  readonly dir: string;
  createLocalDraft(i: { kind: DraftKind; title: string; body: string; actionId: string; filename?: string }): DraftRecord;
  forAction(actionId: string): DraftRecord | undefined;
  createJobMaterialDraft(i: JobMaterialInput): Promise<DraftRecord>;
  createEmailReplyDraft(i: EmailReplyInput): DraftRecord;
  get(id: string): DraftRecord | undefined;
  list(o?: { kind?: DraftKind; status?: DraftStatus }): DraftRecord[];
  read(id: string): string;
  updateBody(id: string, content: string): DraftRecord;
  setStatus(id: string, status: DraftStatus): DraftRecord;
  /** @internal used by proposals.ts after the broker recorded the proposal. */
  _markProposed(id: string, actionId: string): DraftRecord;
}

type Row = {
  id: string; kind: DraftKind; title: string; status: DraftStatus; source_refs_json: string; unresolved_json: string; meta_json: string;
  file_path: string; content_sha256: string; proposal_action_id: string | null; created_at: string; updated_at: string;
};
const toRec = (r: Row): DraftRecord => ({
  id: r.id, kind: r.kind, title: r.title, status: r.status, sourceRefs: JSON.parse(r.source_refs_json) as SourceRef[], unresolved: JSON.parse(r.unresolved_json) as string[],
  meta: JSON.parse(r.meta_json) as Record<string, unknown>, filePath: r.file_path, contentSha256: r.content_sha256, proposalActionId: r.proposal_action_id,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

function fmtLocal(iso: string | null | undefined, tz: string): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(d);
  return `${local} (${tz}) — ${iso}`;
}

const mdEscape = (s: string) => s.replace(/\r/g, '').trim();

export function createDraftWorkspace(o: { home: string; db: Db; clock: Clock }): DraftWorkspace {
  const dir = join(o.home, 'drafts');
  ensurePrivateDir(dir);
  const get = (id: string) => {
    const r = o.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    return r ? toRec(r) : undefined;
  };
  const must = (id: string) => {
    const r = get(id);
    if (!r) throw new Error(`draft ${id} not found`);
    return r;
  };
  const abs = (rel: string) => {
    const p = resolve(dir, rel);
    if (!p.startsWith(resolve(dir) + sep)) throw new Error('draft path escapes the drafts directory');
    return p;
  };
  const writeFile = (rel: string, content: string) => {
    const p = abs(rel);
    ensurePrivateDir(resolve(p, '..'));
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, p);
    chmodSync(p, 0o600);
  };
  const create = (kind: DraftKind, title: string, content: string, sourceRefs: SourceRef[], unresolved: string[], meta: Record<string, unknown>, filename?: string): DraftRecord => {
    const id = newId('drf', o.clock);
    if (filename && !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,149}$/.test(filename)) throw new Error('filename must be a plain basename');
    const rel = filename ? `${kind}/${id}/${filename}` : `${kind}/${id}.md`;
    mkdirSync(join(dir, kind), { recursive: true, mode: 0o700 });
    writeFile(rel, content);
    const now = o.clock.nowIso();
    o.db.prepare(
      `INSERT INTO drafts (id, kind, title, status, source_refs_json, unresolved_json, meta_json, file_path, content_sha256, proposal_action_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    ).run(id, kind, title, 'draft', JSON.stringify(sourceRefs), JSON.stringify(unresolved), JSON.stringify(meta), rel, sha256Hex(content), now, now);
    return must(id);
  };

  return {
    dir,
    get,
    forAction(actionId) {
      const row = o.db.prepare("SELECT * FROM drafts WHERE json_extract(meta_json, '$.createdByActionId') = ?").get(actionId) as Row | undefined;
      return row ? toRec(row) : undefined;
    },
    createLocalDraft(i) {
      if (!(DRAFT_KINDS as readonly string[]).includes(i.kind)) throw new Error('invalid local draft kind');
      return create(i.kind, i.title, i.body, [], ['AI-generated draft: verify facts and requirements before using.'], { createdByActionId: i.actionId }, i.filename);
    },
    list(q = {}) {
      const where: string[] = [];
      const args: string[] = [];
      if (q.kind) (where.push('kind = ?'), args.push(q.kind));
      if (q.status) (where.push('status = ?'), args.push(q.status));
      return (o.db.prepare(`SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid`).all(...args) as Row[]).map(toRec);
    },
    read(id) {
      return readFileSync(abs(must(id).filePath), 'utf8');
    },
    updateBody(id, content) {
      const d = must(id);
      if (d.status === 'proposed') throw new Error('draft has a pending proposal; editing requires a new proposal (and a new approval)');
      writeFile(d.filePath, content);
      o.db.prepare('UPDATE drafts SET content_sha256 = ?, updated_at = ? WHERE id = ?').run(sha256Hex(content), o.clock.nowIso(), id);
      return must(id);
    },
    setStatus(id, status) {
      if (!(DRAFT_STATUSES as readonly string[]).includes(status)) throw new Error('invalid draft status');
      if (status === 'proposed') throw new Error('use proposeDraft() to create a broker proposal');
      must(id);
      o.db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, o.clock.nowIso(), id);
      return must(id);
    },
    _markProposed(id, actionId) {
      o.db.prepare("UPDATE drafts SET status = 'proposed', proposal_action_id = ?, updated_at = ? WHERE id = ?").run(actionId, o.clock.nowIso(), id);
      return must(id);
    },

    async createJobMaterialDraft(i) {
      const refs: SourceRef[] = [];
      const unresolved: string[] = [];
      const used: FactRecord[] = [];
      const out = [
        `# ${mdEscape(i.title)}`,
        '',
        `> LOCAL DRAFT for ${i.target.role} at ${i.target.company}. Built from VERIFIED facts only. Final application submission requires an explicit owner approval (submit_application) through the application's own review/receipt path.`,
        '',
      ];
      for (const s of i.sections) {
        out.push(`## ${s.heading}`, '');
        let any = false;
        for (const req of s.requirements) {
          const facts = await i.facts.find(req);
          const verified = facts.filter((f) => f.status === 'verified').slice(0, req.limit ?? 5);
          const others = facts.filter((f) => f.status !== 'verified');
          for (const f of verified) {
            out.push(`- ${mdEscape(f.text)} [fact:${f.id}]`);
            refs.push({ type: 'fact', id: f.id, label: req.key });
            used.push(f);
            any = true;
          }
          if (!verified.length) {
            unresolved.push(
              others.length
                ? `${req.label}: ${others.length} unverified fact(s) found (${others.map((f) => `${f.id}:${f.status}`).join(', ')}); confirm before use — not inserted.`
                : `${req.label}: no verified fact available.`,
            );
            out.push(`- [UNRESOLVED: ${req.label}]`);
          }
        }
        if (!any && !s.requirements.length) out.push('_(no requirements)_');
        out.push('');
      }
      if (i.notes) out.push('## Owner notes (not facts)', mdEscape(i.notes), '');
      out.push('## Unresolved facts', ...(unresolved.length ? unresolved.map((u) => `- [ ] ${u}`) : ['- (none)']), '');
      if (i.target.url) refs.push({ type: 'url', id: i.target.url, label: 'job posting' });
      return create(i.kind, i.title, out.join('\n'), refs, unresolved, { target: i.target, factIds: used.map((f) => f.id) });
    },

    createEmailReplyDraft(i) {
      const m = i.mail;
      const to = i.to ?? (m.replyTo.length ? m.replyTo : m.from ? [m.from] : []).map((a) => a.address);
      const unresolved = to.length ? [] : ['No recipient address could be determined.'];
      const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
      const quoted = neutralize(m.bodyText).split('\n').slice(0, 80).map((l) => `> ${l}`).join('\n');
      const content = [
        '<!-- LOCAL DRAFT ONLY. Not a provider draft. Not sent. Sending requires owner approval of this exact content (send_message). -->',
        `From: ${i.fromAddress} (account ${i.fromAccountId})`,
        `To: ${to.join(', ')}`,
        `Subject: ${subject.replace(/\n/g, ' ')}`,
        ...(m.internetMessageId ? [`In-Reply-To: ${m.internetMessageId}`] : []),
        '',
        i.body.trim(),
        '',
        `On ${m.receivedAt ?? 'an earlier date'}, ${m.from?.name ?? m.from?.address ?? 'the sender'} wrote:`,
        quoted,
        '',
      ].join('\n');
      return create('email_reply', subject, content, [{ type: 'mail', id: `${m.accountId}:${m.providerMessageId}`, label: m.subject }], unresolved, {
        fromAccountId: i.fromAccountId, fromAddress: i.fromAddress, to, subject, inReplyTo: m.internetMessageId, replyBody: i.body.trim(),
      });
    },
  };
}
