/** Dry run by default. --apply disables verified legacy jobs before atomically importing schedules.
 * Disabled source jobs remain as rollback evidence. Never enable them while native reminders exist.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase, withTransaction } from "../src/store/db.ts";
import { migrate } from "../src/store/migrate.ts";
import { resolvePottsHome } from "../src/store/home.ts";
import { systemClock } from "../src/core/clock.ts";
import { reminderExecutionFingerprint } from "../src/notifications/reminder-migration.ts";
import {
  createReminderStore,
  type ReminderSchedule,
} from "../src/notifications/reminders.ts";
const home = resolvePottsHome();
const cli = join(homedir(), ".openclaw", "bin", "openclaw");
const cfg = JSON.parse(readFileSync(join(home, "potts.json"), "utf8"));
if (
  cfg.owner?.channel !== "imessage" ||
  typeof cfg.owner.imessageOwnerId !== "string"
)
  throw new Error(
    "This migration requires the verified iMessage owner configuration",
  );
const destination = {
  channel: "imessage",
  target: cfg.owner.imessageOwnerId as string,
};
interface Legacy {
  id: string;
  name: string;
  enabled: boolean;
  payload: { kind: string; argv: string[] };
  delivery: { mode: string; channel: string; to: string };
  schedule: ReminderSchedule;
  state?: { nextRunAtMs?: number; runningAtMs?: number; queuedAtMs?: number };
  nextRunAtMs?: number;
}
const list = (): Legacy[] =>
  JSON.parse(
    execFileSync(cli, ["cron", "list", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ).jobs;
const resumeAt = process.argv.indexOf("--resume");
const resumeFile = resumeAt >= 0 ? process.argv[resumeAt + 1] : undefined;
if (resumeAt >= 0 && !resumeFile)
  throw new Error("--resume requires the saved legacy.json path");
const candidates: Legacy[] = resumeFile
  ? JSON.parse(readFileSync(resumeFile, "utf8"))
  : list().filter((j) => j.name?.startsWith("potts-reminder-") && j.enabled);
const executionState = (j: Legacy) => {
  return reminderExecutionFingerprint(j.state);
};
for (const j of candidates) {
  if (!j.id || !j.name?.startsWith("potts-reminder-") || j.enabled !== true)
    throw new Error("Invalid migration snapshot");
  if (j.state?.runningAtMs || j.state?.queuedAtMs)
    throw new Error(`Reminder ${j.id} is in flight; retry after it settles`);
  if (
    j.payload?.kind !== "command" ||
    j.payload.argv?.length !== 2 ||
    j.payload.argv[0] !== "/bin/echo" ||
    j.delivery?.mode !== "announce" ||
    j.delivery.channel !== destination.channel ||
    j.delivery.to !== destination.target
  )
    throw new Error(`Reminder ${j.id} needs individual review`);
  if (!["at", "cron"].includes(j.schedule?.kind))
    throw new Error(`Unsupported schedule ${j.id}`);
  if (j.schedule.kind === "cron" && j.schedule.tz !== "America/Toronto")
    throw new Error(`Unexpected timezone ${j.id}`);
}
console.log(
  JSON.stringify(
    {
      mode: process.argv.includes("--apply") ? "apply" : "preview",
      count: candidates.length,
      reminders: candidates.map((j) => ({
        id: j.id,
        schedule: j.schedule,
        nextDueMs: j.state?.nextRunAtMs ?? j.nextRunAtMs,
      })),
    },
    null,
    2,
  ),
);
if (process.argv.includes("--apply") && candidates.length) {
  const dir = join(
    home,
    "reminder-migration",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "legacy.json"), JSON.stringify(candidates, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      recovery: join(dir, "legacy.json"),
      instruction:
        "If interrupted, rerun with --apply --resume and this saved path. Never simply re-enable legacy jobs after native import.",
    }),
  );
  for (const j of candidates) {
    execFileSync(cli, ["cron", "disable", j.id], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  }
  const after = list();
  for (const j of candidates) {
    const disabled = after.find((x) => x.id === j.id);
    if (
      !disabled ||
      disabled.enabled !== false ||
      disabled.state?.runningAtMs ||
      disabled.state?.queuedAtMs ||
      JSON.stringify(disabled.payload) !== JSON.stringify(j.payload) ||
      JSON.stringify(disabled.schedule) !== JSON.stringify(j.schedule) ||
      JSON.stringify(disabled.delivery) !== JSON.stringify(j.delivery) ||
      executionState(disabled) !== executionState(j)
    )
      throw new Error(
        `Disable/readback failed for ${j.id}; sources are retained, do not import blindly`,
      );
  }
  const db = openDatabase(join(home, "potts.db"));
  try {
    migrate(db);
    const store = createReminderStore(db, systemClock);
    withTransaction(db, () => {
      for (const j of candidates) {
        const existing = store.get(j.id);
        if (existing) {
          if (
            existing.text !== j.payload.argv[1] ||
            JSON.stringify(existing.schedule) !== JSON.stringify(j.schedule) ||
            existing.channel !== destination.channel ||
            existing.target !== destination.target
          )
            throw new Error(
              "Previously imported reminder was edited; reconcile it manually",
            );
          continue;
        }
        store.save({
          id: j.id,
          text: j.payload.argv[1]!,
          schedule: j.schedule,
          ...destination,
          nextDueMs:
            j.schedule.kind === "at"
              ? Date.parse(j.schedule.at)
              : (j.state?.nextRunAtMs ?? j.nextRunAtMs),
        });
      }
    });
    for (const j of candidates) {
      const r = store.get(j.id);
      if (
        !r ||
        r.text !== j.payload.argv[1] ||
        JSON.stringify(r.schedule) !== JSON.stringify(j.schedule) ||
        r.channel !== destination.channel ||
        r.target !== destination.target
      )
        throw new Error("Native reminder readback failed");
    }
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(
        {
          importedIds: candidates.map((j) => j.id),
          legacyJobs: "disabled, retained",
          at: systemClock.nowIso(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({ verified: true, count: candidates.length, backup: dir }),
    );
  } finally {
    db.close();
  }
}
