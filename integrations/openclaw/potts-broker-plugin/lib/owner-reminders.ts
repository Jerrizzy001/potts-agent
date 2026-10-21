/** Owner-only reminders persisted locally; the daemon owns durable dispatch through its quiet-hours outbox. */
import { join } from "node:path";
import type { SecretsProvider } from "./config.ts";
import { defaultPottsHome } from "./config.ts";
import { openDatabase, type Db } from "../../../../src/store/db.ts";
import {
  createReminderStore,
  type ReminderSchedule,
} from "../../../../src/notifications/reminders.ts";
import { localToUtc } from "../../../../src/jobs/tz.ts";
const TZ = "America/Toronto";
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}
const result = (text: string, details: unknown): ToolResult => ({
  content: [{ type: "text", text }],
  details,
});
export const AT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?|\d{1,4}[mhd])$/;
export const CRON_PATTERN = /^(\S+\s+){4}\S+$/;
/** Admission policy; actual dispatch and retries also enforce quiet hours. */
export function reminderOutsideQuietHours(
  at: string,
  cron: string,
  nowMs: number,
): boolean {
  const allowedHour = (hour: number) =>
    Number.isInteger(hour) && hour >= 8 && hour < 23;
  if (cron) {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const hours = new Set<number>();
    for (const part of fields[1]!.split(",")) {
      const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
      if (!m) return false;
      const step = m[2] ? Number(m[2]) : 1;
      if (step < 1 || step > 23) return false;
      const bounds = m[1] === "*" ? [0, 23] : m[1]!.split("-").map(Number);
      const start = bounds[0]!;
      const end = bounds[1] ?? (m[2] ? 23 : start);
      if (start < 0 || start > 23 || end < start || end > 23) return false;
      for (let h = start; h <= end; h += step) hours.add(h);
    }
    return hours.size > 0 && [...hours].every(allowedHour);
  }
  if (!AT_PATTERN.test(at)) return false;
  const duration = /^(\d{1,4})([mhd])$/.exec(at);
  let ms: number;
  if (duration) {
    const delay =
      Number(duration[1]) *
      { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]!]!;
    if (delay <= 0) return false;
    ms = nowMs + delay;
  } else if (!/Z$|[+-]\d{2}:\d{2}$/.test(at))
    return allowedHour(Number(at.slice(11, 13)));
  else ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms)),
  );
  return allowedHour(hour);
}

export function parseReminderAt(at: string, now: number): number {
  const duration = /^(\d{1,4})([mhd])$/.exec(at);
  if (duration)
    return (
      now +
      Number(duration[1]) *
        { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2]!]!
    );
  if (/Z$|[+-]\d{2}:\d{2}$/.test(at)) return Date.parse(at);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at);
  if (!m) return NaN;
  return localToUtc(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] ?? 0),
    },
    TZ,
  );
}
export function createOwnerReminderTools(
  secrets: SecretsProvider,
  opts: {
    db?: Db;
    home?: string;
    deliveryChannel?: "telegram" | "imessage";
    deliveryTarget?: string;
    now?: () => number;
  } = {},
) {
  const now = opts.now ?? Date.now;
  return [
    {
      name: "potts_reminder",
      catalogMode: "direct-only" as const,
      description:
        "Reminders for the owner only. add: text and at (Toronto local time or 20m/2h/1d), or a five-field cron. list/remove/reschedule by saved id. Quiet hours are 23:00–08:00 Toronto; delayed reminders wait until morning. Confirm only verified saved changes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { enum: ["add", "list", "remove", "reschedule"] },
          text: { type: "string", minLength: 1, maxLength: 500 },
          at: { type: "string", maxLength: 40 },
          cron: { type: "string", maxLength: 60 },
          id: { type: "string", maxLength: 100 },
        },
      },
      async execute(
        _id: string,
        p: Record<string, unknown>,
      ): Promise<ToolResult> {
        let db: Db | undefined;
        try {
          const s = await secrets.get();
          if (!s)
            return result("Your reminder connection is unavailable.", {
              ok: false,
            });
          const channel = opts.deliveryChannel ?? "telegram",
            target = opts.deliveryTarget ?? s.ownerId;
          db =
            opts.db ??
            openDatabase(join(opts.home ?? defaultPottsHome(), "potts.db"));
          const store = createReminderStore(db, {
            nowMs: now,
            now: () => new Date(now()),
            nowIso: () => new Date(now()).toISOString(),
          });
          const owned = store
            .list()
            .filter((r) => r.channel === channel && r.target === target);
          if (p.action === "list")
            return result(
              owned.length
                ? JSON.stringify(owned.map(({ target, ...r }) => r))
                : "No reminders set.",
              { ok: true, reminders: owned.map(({ target, ...r }) => r) },
            );
          const existing = owned.find((r) => r.id === p.id);
          if (p.action === "remove") {
            if (!existing)
              return result("I couldn’t find that reminder.", { ok: false });
            store.remove(existing.id);
            if (store.get(existing.id))
              throw new Error("Removal did not persist");
            return result("That reminder is cancelled.", {
              ok: true,
              id: existing.id,
              state: "removed",
            });
          }
          const changing = p.action === "reschedule";
          if (p.action !== "add" && !changing)
            return result("I can add, list, remove or reschedule reminders.", {
              ok: false,
            });
          if (changing && !existing)
            return result("I couldn’t find that reminder.", { ok: false });
          const text =
            typeof p.text === "string" ? p.text.trim() : (existing?.text ?? "");
          const at = typeof p.at === "string" ? p.at.trim() : "";
          const cron = typeof p.cron === "string" ? p.cron.trim() : "";
          if (
            !text ||
            text.length > 500 ||
            !!at === !!cron ||
            (at && !AT_PATTERN.test(at)) ||
            (cron && !CRON_PATTERN.test(cron))
          )
            return result(
              "Give me reminder text and one valid time or repeating schedule.",
              { ok: false },
            );
          if (!reminderOutsideQuietHours(at, cron, now()))
            return result(
              "Choose a time outside your quiet hours, 11 pm–8 am Toronto time.",
              { ok: false, quietHours: true },
            );
          const ms = at ? parseReminderAt(at, now()) : null;
          if (at && (!Number.isFinite(ms) || ms! <= now()))
            return result("Choose a future time for that reminder.", {
              ok: false,
            });
          const schedule: ReminderSchedule = at
            ? { kind: "at", at: new Date(ms!).toISOString() }
            : { kind: "cron", expr: cron, tz: TZ };
          const saved = store.save(
            {
              ...(existing ? { id: existing.id } : {}),
              text,
              schedule,
              channel,
              target,
            },
            changing,
          );
          const read = store.get(saved.id);
          if (!read || JSON.stringify(read) !== JSON.stringify(saved))
            throw new Error("Saved reminder did not match");
          const when = new Intl.DateTimeFormat("en-CA", {
            timeZone: TZ,
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(saved.nextDueMs!));
          return result(
            at
              ? `I’ll remind you on ${when} Toronto time.`
              : `Your repeating reminder is saved. The next one is ${when} Toronto time.`,
            {
              ok: true,
              id: saved.id,
              schedule: saved.schedule,
              nextRunAtMs: saved.nextDueMs,
              channel,
              timezone: TZ,
            },
          );
        } catch {
          return result(
            "I couldn’t confirm that reminder change. Check your reminder list before trying again.",
            { ok: false, uncertain: true },
          );
        } finally {
          if (db && !opts.db) db.close();
        }
      },
    },
  ];
}
export const OWNER_REMINDER_TOOL_NAMES = ["potts_reminder"] as const;
