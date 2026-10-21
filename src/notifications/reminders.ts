import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { Clock } from "../core/clock.ts";
import { withTransaction, type Db } from "../store/db.ts";
import type { Outbox } from "./outbox.ts";

export type ReminderSchedule =
  | { kind: "at"; at: string }
  | { kind: "cron"; expr: string; tz: string };
export interface Reminder {
  id: string;
  text: string;
  schedule: ReminderSchedule;
  channel: string;
  target: string;
  nextDueMs: number | null;
  revision: number;
  enabled: boolean;
}
interface Row {
  id: string;
  text: string;
  schedule_json: string;
  channel: string;
  target: string;
  next_due_ms: number | null;
  revision: number;
  enabled: number;
}
const decode = (r: Row): Reminder => ({
  id: r.id,
  text: r.text,
  schedule: JSON.parse(r.schedule_json),
  channel: r.channel,
  target: r.target,
  nextDueMs: r.next_due_ms,
  revision: r.revision,
  enabled: r.enabled === 1,
});
export function nextReminderDue(
  schedule: ReminderSchedule,
  after: number,
): number | null {
  if (schedule.kind === "at") {
    const ms = Date.parse(schedule.at);
    if (!Number.isFinite(ms)) throw new Error("Invalid reminder time");
    return ms;
  }
  if (schedule.expr.trim().split(/\s+/).length !== 5)
    throw new Error("Use a five-field cron schedule");
  return (
    new Cron(schedule.expr, { timezone: schedule.tz, paused: true })
      .nextRun(new Date(after))
      ?.getTime() ?? null
  );
}

/** Schedule advancement and occurrence insertion share one SQLite transaction. No volatile timers own reminders. */
export function createReminderStore(db: Db, clock: Clock) {
  const get = (id: string) => {
    const r = db.prepare("SELECT * FROM owner_reminders WHERE id=?").get(id) as
      | Row
      | undefined;
    return r ? decode(r) : null;
  };
  const cancelPending = (id: string) =>
    db
      .prepare(
        "UPDATE owner_notifications SET status='dropped',drop_reason='reminder cancelled or rescheduled',updated_at=? WHERE event_ref=? AND status='pending'",
      )
      .run(clock.nowIso(), `reminder:${id}`);
  const assertNotSending = (id: string) => {
    if (
      db
        .prepare(
          "SELECT 1 FROM owner_notifications WHERE event_ref=? AND status IN ('sending','uncertain') LIMIT 1",
        )
        .get(`reminder:${id}`)
    )
      throw new Error(
        "Reminder is already being delivered or has an unconfirmed delivery; change is unconfirmed",
      );
  };
  return {
    get,
    list: () =>
      (
        db
          .prepare("SELECT * FROM owner_reminders ORDER BY created_at,id")
          .all() as unknown as Row[]
      ).map(decode),
    save(
      input: {
        id?: string;
        text: string;
        schedule: ReminderSchedule;
        channel: string;
        target: string;
        nextDueMs?: number;
        enabled?: boolean;
      },
      replace = false,
    ): Reminder {
      if (
        !input.text.trim() ||
        input.text.length > 500 ||
        !input.channel ||
        !input.target
      )
        throw new Error("Invalid reminder");
      const id = input.id ?? `rem_${randomUUID()}`;
      const next = nextReminderDue(input.schedule, clock.nowMs());
      const due = input.nextDueMs ?? next;
      if (due === null || !Number.isFinite(due))
        throw new Error("Schedule has no next occurrence");
      return withTransaction(db, () => {
        const old = get(id);
        if (old && !replace) throw new Error("Reminder already exists");
        if (old) assertNotSending(id);
        if (old) cancelPending(id);
        db.prepare(
          `INSERT INTO owner_reminders (id,text,schedule_json,channel,target,next_due_ms,revision,enabled,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,schedule_json=excluded.schedule_json,channel=excluded.channel,target=excluded.target,next_due_ms=excluded.next_due_ms,revision=excluded.revision,enabled=excluded.enabled,updated_at=excluded.updated_at`,
        ).run(
          id,
          input.text,
          JSON.stringify(input.schedule),
          input.channel,
          input.target,
          due,
          (old?.revision ?? 0) + 1,
          input.enabled === false ? 0 : 1,
          clock.nowIso(),
          clock.nowIso(),
        );
        return get(id)!;
      });
    },
    remove(id: string): boolean {
      return withTransaction(db, () => {
        assertNotSending(id);
        cancelPending(id);
        return (
          Number(
            db.prepare("DELETE FROM owner_reminders WHERE id=?").run(id)
              .changes,
          ) === 1
        );
      });
    },
    enqueueDue(
      outbox: Outbox,
      destination: { channel: string; target: string },
    ): number {
      return withTransaction(db, () => {
        const due = db
          .prepare(
            "SELECT * FROM owner_reminders WHERE enabled=1 AND next_due_ms<=? ORDER BY next_due_ms,id",
          )
          .all(clock.nowMs()) as unknown as Row[];
        let count = 0;
        for (const row of due) {
          const r = decode(row);
          // A reconfigured account must never receive reminders saved for a different owner.
          if (
            r.channel !== destination.channel ||
            r.target !== destination.target
          )
            continue;
          const key = `reminder:${r.id}:${r.revision}:${r.nextDueMs}`;
          const alreadyPending = db
            .prepare(
              "SELECT 1 FROM owner_notifications WHERE event_ref=? AND status IN ('pending','sending') LIMIT 1",
            )
            .get(`reminder:${r.id}`);
          if (!alreadyPending)
            outbox.enqueue({
              dedupKey: key,
              category: "important",
              eventRef: `reminder:${r.id}`,
              text: r.text,
              notBeforeMs: r.nextDueMs!,
              expectedDestination: { channel: r.channel, target: r.target },
            });
          // Coalesce a sleeping computer's missed recurring occurrences into one reminder.
          // Never burst-send days of stale reminders when it wakes.
          const next =
            r.schedule.kind === "at"
              ? null
              : nextReminderDue(r.schedule, clock.nowMs());
          db.prepare(
            "UPDATE owner_reminders SET next_due_ms=?,enabled=?,updated_at=? WHERE id=?",
          ).run(next, next === null ? 0 : 1, clock.nowIso(), r.id);
          if (!alreadyPending) count++;
        }
        return count;
      });
    },
  };
}
