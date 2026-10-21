import type { Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import { withTransaction, type Db } from '../store/db.ts';
import { computeBackoffMs, type BackoffPolicy } from '../jobs/scheduler.ts';
import { OwnerChannelDeferredError, OwnerChannelRejectedError, TELEGRAM_MAX_CHARS, type OwnerChannel } from './channel.ts';
import { chunkWithLabels } from './chunk.ts';
import { isQuietAt, quietEndAfter, type QuietHoursConfig } from './quiet-hours.ts';

/**
 * Owner notification outbox.
 *
 * Categories:
 *  - urgent           immediate message; re-validated at send time (resolved/acknowledged → dropped)
 *  - important        immediate message; re-validated if it carries an event ref
 *  - routine          never sent on its own; folded into the next briefing
 *  - briefing         scheduled briefing text; if quiet hours hold it, it is superseded by the next briefing
 *  - approval_request immediate; held in quiet hours; re-validated (still pending?) at send time
 *  - reply            reply to an owner-initiated chat; held in quiet hours unless configured otherwise
 *
 * Quiet hours are evaluated at ACTUAL DISPATCH TIME, never at enqueue time, and
 * there is no urgent override. Delivery is at-most-once: a row moves to
 * 'sending' (with an attempt record) before the channel is called; anything
 * other than a definitive rejection leaves it 'uncertain', never re-sent.
 */
export type NotificationCategory = 'urgent' | 'important' | 'routine' | 'briefing' | 'approval_request' | 'reply';
export type NotificationStatus = 'pending' | 'sending' | 'delivered' | 'dropped' | 'folded' | 'failed' | 'uncertain';

export interface EnqueueInput {
  dedupKey: string;
  category: NotificationCategory;
  text: string;
  /** Urgent event id, approval id, incident id... used by validators. */
  eventRef?: string;
  notBeforeMs?: number;
  expiresAtMs?: number;
  expectedDestination?: {channel:string;target:string};
}

export interface Notification {
  id: string;
  dedupKey: string;
  category: NotificationCategory;
  eventRef: string | null;
  text: string;
  createdAt: string;
  status: NotificationStatus;
  heldSinceMs: number | null;
  attempts: number;
  nextAttemptMs: number;
  lastError: string | null;
  providerMessageId: string | null;
  deliveredAt: string | null;
  dropReason: string | null;
  foldedInto: string | null;
  expectedDestination?: {channel:string;target:string};
}

export type ValidationResult = { deliver: true } | { deliver: false; reason: string };
export type NotificationValidator = (n: Notification) => ValidationResult;

export interface OutboxOptions {
  db: Db;
  clock: Clock;
  quiet: QuietHoursConfig;
  channel?: OwnerChannel;
  validators?: Partial<Record<NotificationCategory, NotificationValidator>>;
  maxAttempts?: number;
  backoff?: BackoffPolicy;
  sendTimeoutMs?: number;
  random?: () => number;
  logger?: Logger;
}

export interface DispatchReport {
  delivered: string[];
  held: string[];
  dropped: { id: string; reason: string }[];
  folded: string[];
  retrying: string[];
  failed: string[];
  uncertain: string[];
}

export interface Outbox {
  /** Enqueues (chunking text > 4096 into parts). Duplicate dedup keys are ignored. */
  enqueue(input: EnqueueInput): { ids: string[]; duplicate: boolean };
  dispatchDue(): Promise<DispatchReport>;
  /** Startup: any 'sending' row (crash mid-send) becomes 'uncertain'. Returns count. */
  recover(): number;
  /** Routine items waiting for a briefing (not yet folded). */
  pendingRoutine(): Notification[];
  /** Marks the given routine notifications as folded into `briefingKey` (call in the briefing's transaction). */
  foldInto(ids: string[], briefingKey: string): void;
  get(id: string): Notification | null;
  getByDedupKey(key: string): Notification | null;
  list(filter?: { status?: NotificationStatus; category?: NotificationCategory }): Notification[];
  /** Drops a still-pending notification (e.g. the owner already saw it elsewhere). */
  drop(id: string, reason: string): boolean;
  setChannel(channel: OwnerChannel): void;
  setValidator(category: NotificationCategory, v: NotificationValidator): void;
}

interface Row {
  id: string;
  dedup_key: string;
  category: NotificationCategory;
  event_ref: string | null;
  text: string;
  created_at: string;
  status: NotificationStatus;
  held_since_ms: number | null;
  attempts: number;
  next_attempt_ms: number;
  last_error: string | null;
  provider_message_id: string | null;
  delivered_at: string | null;
  drop_reason: string | null;
  folded_into: string | null;
  expected_channel: string | null;
  expected_target: string | null;
}

const toN = (r: Row): Notification => ({
  id: r.id,
  dedupKey: r.dedup_key,
  category: r.category,
  eventRef: r.event_ref,
  text: r.text,
  createdAt: r.created_at,
  status: r.status,
  heldSinceMs: r.held_since_ms,
  attempts: r.attempts,
  nextAttemptMs: r.next_attempt_ms,
  lastError: r.last_error,
  providerMessageId: r.provider_message_id,
  deliveredAt: r.delivered_at,
  dropReason: r.drop_reason,
  foldedInto: r.folded_into,
  ...(r.expected_channel&&r.expected_target?{expectedDestination:{channel:r.expected_channel,target:r.expected_target}}:{}),
});

/** Sentinel "never by itself" attempt time for routine items. */
const NEVER = 8.64e15;

export function createOutbox(opts: OutboxOptions): Outbox {
  const { db, clock, quiet } = opts;
  let channel = opts.channel;
  const validators: Partial<Record<NotificationCategory, NotificationValidator>> = { ...(opts.validators ?? {}) };
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoff = opts.backoff ?? { baseMs: 30_000, maxMs: 15 * 60_000, jitter: 0.2 };
  const sendTimeoutMs = opts.sendTimeoutMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const log = opts.logger ?? nullLogger;

  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM owner_notifications WHERE id = ?').get(id) as Row | undefined;
    return r ? toN(r) : null;
  };
  const getByDedupKey = (k: string) => {
    const r = db.prepare('SELECT * FROM owner_notifications WHERE dedup_key = ?').get(k) as Row | undefined;
    return r ? toN(r) : null;
  };
  const setStatus = (id: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE owner_notifications SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
      ...(keys.map((k) => fields[k]) as (string | number | null)[]),
      clock.nowIso(),
      id,
    );
  };

  function enqueue(input: EnqueueInput): { ids: string[]; duplicate: boolean } {
    if (!input.dedupKey || input.dedupKey.length > 300) throw new Error('enqueue: dedupKey required (<= 300 chars)');
    return withTransaction(db, () => {
      if (getByDedupKey(input.dedupKey)) return { ids: [], duplicate: true };
      const now = clock.nowMs();
      const parts = chunkWithLabels(input.text, TELEGRAM_MAX_CHARS);
      const ids: string[] = [];
      parts.forEach((text, i) => {
        const id = newId('ntf', clock);
        const key = i === 0 ? input.dedupKey : `${input.dedupKey}#${i + 1}`;
        const nb = input.notBeforeMs ?? now;
        db.prepare(
          `INSERT INTO owner_notifications (id, dedup_key, category, event_ref, text, created_at, not_before_ms, expires_at_ms, status, attempts, next_attempt_ms, updated_at, expected_channel, expected_target)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        ).run(id, key, input.category, input.eventRef ?? null, text, clock.nowIso(), nb, input.expiresAtMs ?? null, input.category === 'routine' ? NEVER : nb, clock.nowIso(),input.expectedDestination?.channel??null,input.expectedDestination?.target??null);
        ids.push(id);
      });
      return { ids, duplicate: false };
    });
  }

  function recover(): number {
    return withTransaction(db, () => {
      const rows = db.prepare(`SELECT id FROM owner_notifications WHERE status = 'sending'`).all() as { id: string }[];
      for (const r of rows) {
        setStatus(r.id, { status: 'uncertain', last_error: 'process stopped during send; not re-sent (at-most-once)' });
        db.prepare(`UPDATE owner_delivery_attempts SET outcome = 'uncertain', finished_at = ? WHERE notification_id = ? AND outcome = 'sending'`).run(clock.nowIso(), r.id);
      }
      return rows.length;
    });
  }

  /** Decides what to do with a due row outside quiet hours. Synchronous; runs inside a transaction. */
  function preSend(n: Notification, now: number): { send: true } | { send: false; outcome: 'dropped' | 'folded'; reason: string } {
    if(n.eventRef?.startsWith('reminder:')) {
      const id=n.eventRef.slice('reminder:'.length);
      const reminder=db.prepare('SELECT revision,channel,target FROM owner_reminders WHERE id=?').get(id) as {revision:number;channel:string;target:string}|undefined;
      if(!reminder||!n.dedupKey.startsWith(`reminder:${id}:${reminder.revision}:`)||n.expectedDestination?.channel!==reminder.channel||n.expectedDestination?.target!==reminder.target)return {send:false,outcome:'dropped',reason:'reminder no longer matches its saved occurrence'};
    }
    if (n.category === 'routine') return { send: false, outcome: 'folded', reason: 'routine items go to the next briefing' };
    if (n.category === 'briefing' && n.heldSinceMs !== null) {
      return { send: false, outcome: 'dropped', reason: 'briefing held by quiet hours is superseded by the next briefing' };
    }
    const v = validators[n.category];
    if (v) {
      const r = v(n);
      if (!r.deliver) return { send: false, outcome: 'dropped', reason: r.reason };
    }
    void now;
    return { send: true };
  }

  async function dispatchDue(): Promise<DispatchReport> {
    const rep: DispatchReport = { delivered: [], held: [], dropped: [], folded: [], retrying: [], failed: [], uncertain: [] };
    const now = clock.nowMs();
    const due = (
      db.prepare(`SELECT * FROM owner_notifications WHERE status = 'pending' AND next_attempt_ms <= ? ORDER BY created_at, rowid`).all(now) as unknown as Row[]
    ).map(toN);
    for (const n0 of due) {
      const at = clock.nowMs();
      // Claim synchronously: quiet check, expiry, validation, and the move to 'sending'.
      const decision = withTransaction(db, () => {
        const n = get(n0.id);
        if (!n || n.status !== 'pending') return { kind: 'skip' as const };
        const exp = (db.prepare('SELECT expires_at_ms FROM owner_notifications WHERE id = ?').get(n.id) as { expires_at_ms: number | null }).expires_at_ms;
        if (exp !== null && at >= exp) {
          setStatus(n.id, { status: 'dropped', drop_reason: 'expired' });
          return { kind: 'dropped' as const, reason: 'expired' };
        }
        const replyAllowed = n.category === 'reply' && quiet.ownerInitiatedReplyAllowed;
        if (isQuietAt(at, quiet) && !replyAllowed) {
          const until = quietEndAfter(at, quiet);
          setStatus(n.id, { held_since_ms: n.heldSinceMs ?? at, next_attempt_ms: until });
          return { kind: 'held' as const };
        }
        const p = preSend(n, at);
        if (!p.send) {
          if (p.outcome === 'folded') {
            setStatus(n.id, { next_attempt_ms: NEVER, category: 'routine' });
            return { kind: 'folded' as const };
          }
          setStatus(n.id, { status: 'dropped', drop_reason: p.reason });
          if (n.category === 'briefing') {
            // Return routine items this briefing had absorbed so the next briefing includes them.
            db.prepare(`UPDATE owner_notifications SET status = 'pending', folded_into = NULL, updated_at = ? WHERE status = 'folded' AND folded_into = ?`).run(
              clock.nowIso(),
              n.dedupKey.replace(/#\d+$/, ''),
            );
          }
          return { kind: 'dropped' as const, reason: p.reason };
        }
        if (!channel) return { kind: 'no_channel' as const };
        const attempt = n.attempts + 1;
        setStatus(n.id, { status: 'sending', attempts: attempt });
        const attemptId = newId('dlv', clock);
        db.prepare(`INSERT INTO owner_delivery_attempts (id, notification_id, attempt, started_at, outcome) VALUES (?, ?, ?, ?, 'sending')`).run(
          attemptId,
          n.id,
          attempt,
          clock.nowIso(),
        );
        return { kind: 'send' as const, n: { ...n, attempts: attempt }, attemptId };
      });
      switch (decision.kind) {
        case 'skip':
        case 'no_channel':
          continue;
        case 'held':
          rep.held.push(n0.id);
          continue;
        case 'folded':
          rep.folded.push(n0.id);
          continue;
        case 'dropped':
          rep.dropped.push({ id: n0.id, reason: decision.reason });
          continue;
      }
      const { n, attemptId } = decision;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('send timeout')), sendTimeoutMs);
      timer.unref?.();
      try {
        const res = await Promise.race([
          channel!.send({ notificationId: n.id, idempotencyKey: `potts-ntf-${n.id}`, text: n.text, category: n.category, ...(n.eventRef?.startsWith('reminder:') ? { quietHours: quiet, expectedDestination:n.expectedDestination } : {}) }, ac.signal),
          new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('send timeout')), { once: true })),
        ]);
        withTransaction(db, () => {
          setStatus(n.id, { status: 'delivered', provider_message_id: res.providerMessageId, delivered_at: clock.nowIso(), last_error: null });
          db.prepare(`UPDATE owner_delivery_attempts SET outcome = 'delivered', provider_message_id = ?, finished_at = ? WHERE id = ?`).run(res.providerMessageId, clock.nowIso(), attemptId);
        });
        rep.delivered.push(n.id);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        if (e instanceof OwnerChannelDeferredError) {
          withTransaction(db, () => {
            // The adapter has explicitly certified that nothing was sent. Undo the
            // provisional attempt; overnight deferral must not exhaust retry limits.
            db.prepare('DELETE FROM owner_delivery_attempts WHERE id=?').run(attemptId);
            setStatus(n.id, { status:'pending', attempts:n.attempts-1, held_since_ms:n.heldSinceMs??clock.nowMs(), next_attempt_ms:e.notBeforeMs, last_error:null });
          });
          rep.held.push(n.id);
        } else if (e instanceof OwnerChannelRejectedError) {
          const retry = !e.permanent && n.attempts < maxAttempts;
          const delay = Math.max(computeBackoffMs(n.attempts, backoff, random), e.retryAfterMs ?? 0);
          withTransaction(db, () => {
            db.prepare(`UPDATE owner_delivery_attempts SET outcome = 'rejected', error = ?, finished_at = ? WHERE id = ?`).run(msg, clock.nowIso(), attemptId);
            setStatus(n.id, retry ? { status: 'pending', next_attempt_ms: clock.nowMs() + delay, last_error: msg } : { status: 'failed', last_error: msg });
          });
          (retry ? rep.retrying : rep.failed).push(n.id);
        } else {
          withTransaction(db, () => {
            db.prepare(`UPDATE owner_delivery_attempts SET outcome = 'uncertain', error = ?, finished_at = ? WHERE id = ?`).run(msg, clock.nowIso(), attemptId);
            setStatus(n.id, { status: 'uncertain', last_error: msg });
          });
          log.warn('outbox: delivery uncertain; not re-sending', { notificationId: n.id, error: msg });
          rep.uncertain.push(n.id);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return rep;
  }

  return {
    enqueue,
    dispatchDue,
    recover,
    pendingRoutine() {
      return (
        db.prepare(`SELECT * FROM owner_notifications WHERE status = 'pending' AND category = 'routine' ORDER BY created_at, rowid`).all() as unknown as Row[]
      ).map(toN);
    },
    foldInto(ids, briefingKey) {
      withTransaction(db, () => {
        for (const id of ids)
          db.prepare(`UPDATE owner_notifications SET status = 'folded', folded_into = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).run(briefingKey, clock.nowIso(), id);
      });
    },
    get,
    getByDedupKey,
    list(filter = {}) {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.status) {
        where.push('status = ?');
        args.push(filter.status);
      }
      if (filter.category) {
        where.push('category = ?');
        args.push(filter.category);
      }
      const sql = `SELECT * FROM owner_notifications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid`;
      return (db.prepare(sql).all(...args) as unknown as Row[]).map(toN);
    },
    drop(id, reason) {
      const r = db
        .prepare(`UPDATE owner_notifications SET status = 'dropped', drop_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(reason, clock.nowIso(), id);
      return Number(r.changes) === 1;
    },
    setChannel(c) {
      channel = c;
    },
    setValidator(cat, v) {
      validators[cat] = v;
    },
  };
}
