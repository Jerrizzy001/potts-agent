import type { Clock } from '../core/clock.ts';
import type { Db } from '../store/db.ts';
import type { UrgentEventStore } from './urgent.ts';

/**
 * Inputs from the connector layer (WP-4 implements these). Only structured,
 * classifier-assigned fields are used here; free text from senders never
 * decides urgency.
 */
export interface TaskDeadlineInfo {
  /** Stable id from the task source. */
  id: string;
  project: string;
  title: string;
  /** UTC ISO due instant. */
  dueAt: string;
  completed: boolean;
  /** Calendar feeds may not reveal whether the owner completed. */
  completionStatusKnown?: boolean;
  sourceRef?: string;
}

export interface TaskDeadlineSource {
  listOpenTasks(signal?: AbortSignal): Promise<TaskDeadlineInfo[]>;
}

export type MailPriorityCategory =
  | 'interview_invitation'
  | 'business_enquiry'
  | 'client_opportunity'
  | 'job_opportunity'
  | 'newsletter'
  | 'promotion'
  | 'receipt'
  | 'routine';

export interface PriorityMailItem {
  /** Stable message id within the account. */
  id: string;
  accountId: string;
  category: MailPriorityCategory;
  /** Classifier decision that a business enquiry / opportunity qualifies for urgent attention. */
  qualifies: boolean;
  /** Display-only, untrusted. Truncated and never interpreted. */
  subject: string;
  from: string;
  receivedAt: string;
}

export interface PriorityMailSource {
  listPriorityItems(sinceIso: string, signal?: AbortSignal): Promise<PriorityMailItem[]>;
}

export interface DeadlineWatcherOptions {
  db: Db;
  clock: Clock;
  urgent: UrgentEventStore;
  tasks?: TaskDeadlineSource;
  mail?: PriorityMailSource;
  /** Default 6 hours. */
  taskWindowMs?: number;
  /** First run looks back this far for mail. Default 24h. */
  initialMailLookbackMs?: number;
}

export interface DeadlineRunReport {
  raised: string[];
  resolved: string[];
  errors: string[];
}

export interface DeadlineWatcher {
  run(signal?: AbortSignal): Promise<DeadlineRunReport>;
}

const CURSOR_KEY = 'deadlines.mail.since';

export function sanitizeDisplay(s: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/**
 * Raises urgent events:
 *  - unfinished task due within 6h → one event per task + due version
 *    (dedup "task:<id>:due:<dueAt>"; a changed due date is a new version);
 *  - interview invitation → one event per message;
 *  - qualifying business enquiry / client opportunity → one event per message.
 * Newsletters, promotions, receipts and other routine mail never raise events.
 * Open task events are resolved once the task is completed, its due
 * date changes, or it is past due (the owner already got the alert).
 */
export function createDeadlineWatcher(o: DeadlineWatcherOptions): DeadlineWatcher {
  const windowMs = o.taskWindowMs ?? 6 * 3600_000;
  const lookback = o.initialMailLookbackMs ?? 24 * 3600_000;
  return {
    async run(signal) {
      const rep: DeadlineRunReport = { raised: [], resolved: [], errors: [] };
      const now = o.clock.nowMs();
      if (o.tasks) {
        try {
          const list = await o.tasks.listOpenTasks(signal);
          const byId = new Map(list.map((a) => [a.id, a]));
          for (const a of list) {
            const due = Date.parse(a.dueAt);
            if (Number.isNaN(due) || a.completed) continue;
            if (due > now && due - now <= windowMs) {
              const dueIso = new Date(due).toISOString();
              const r = o.urgent.raise({
                dedupKey: `task:${a.id}:due:${dueIso}`,
                sourceType: 'task_due',
                sourceRef: a.id,
                title: `${a.completionStatusKnown === false ? 'Task due (completion unverified)' : 'Unfinished task due'} ${dueIso}: ${sanitizeDisplay(a.project, 40)} — ${sanitizeDisplay(a.title, 80)}`,
                detail: { taskId: a.id, dueAt: dueIso, summary: `Due in ${Math.round((due - now) / 60000)} minutes; ${a.completionStatusKnown === false ? 'check completion status' : 'not completed'}.` },
                shouldCall: a.completionStatusKnown !== false,
              });
              if (r.created) rep.raised.push(r.event.id);
            }
          }
          for (const ev of o.urgent.listBySource('task_due')) {
            if (ev.status === 'resolved') continue;
            const a = byId.get(ev.sourceRef);
            const dueAt = String(ev.detail.dueAt ?? '');
            let reason: string | null = null;
            if (!a) reason = 'task no longer listed as open';
            else if (a.completed) reason = 'task completed';
            else if (new Date(Date.parse(a.dueAt)).toISOString() !== dueAt) reason = 'due date changed';
            else if (Date.parse(dueAt) <= now) reason = 'due time passed';
            if (reason) {
              o.urgent.resolve(ev.id, reason);
              rep.resolved.push(ev.id);
            }
          }
        } catch (e) {
          rep.errors.push(`tasks: ${(e as Error).message}`);
        }
      }
      if (o.mail) {
        const cur = o.db.prepare('SELECT value FROM wp5_kv WHERE key = ?').get(CURSOR_KEY) as { value: string } | undefined;
        const since = cur?.value ?? new Date(now - lookback).toISOString();
        try {
          const items = await o.mail.listPriorityItems(since, signal);
          let maxSeen = since;
          for (const m of items) {
            if (m.receivedAt > maxSeen) maxSeen = m.receivedAt;
            const isInterview = m.category === 'interview_invitation' && m.qualifies === true;
            const isBusiness = (m.category === 'business_enquiry' || m.category === 'client_opportunity') && m.qualifies === true;
            if (!isInterview && !isBusiness) continue;
            const r = o.urgent.raise({
              dedupKey: `mail:${m.accountId}:${m.id}`,
              sourceType: isInterview ? 'interview_invitation' : 'business_enquiry',
              sourceRef: `${m.accountId}:${m.id}`,
              title: `${isInterview ? 'Interview invitation' : 'Business enquiry'} from ${sanitizeDisplay(m.from, 60)}: "${sanitizeDisplay(m.subject, 80)}"`,
              detail: { accountId: m.accountId, messageId: m.id, receivedAt: m.receivedAt, category: m.category },
              shouldCall: true,
            });
            if (r.created) rep.raised.push(r.event.id);
          }
          o.db
            .prepare('INSERT INTO wp5_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(CURSOR_KEY, maxSeen, o.clock.nowIso());
        } catch (e) {
          rep.errors.push(`mail: ${(e as Error).message}`);
        }
      }
      return rep;
    },
  };
}
