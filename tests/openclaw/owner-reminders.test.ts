import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOwnerReminderTools,
  reminderOutsideQuietHours,
} from "../../integrations/openclaw/potts-broker-plugin/lib/owner-reminders.ts";
import { openDatabase } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import { createReminderStore } from "../../src/notifications/reminders.ts";
const owner = {
  get: async () => ({ ownerId: "424242", key: Buffer.alloc(32) }),
} as never;
function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = createFakeClock("2026-10-21T16:00:00Z");
  const [tool] = createOwnerReminderTools(owner, {
    db,
    now: clock.nowMs,
    deliveryChannel: "imessage",
    deliveryTarget: "+14165550123",
  });
  return { db, clock, tool: tool!, store: createReminderStore(db, clock) };
}
test("reminders are saved/read back with configured iMessage destination and Toronto time", async () => {
  const f = fixture();
  try {
    const r = await f.tool.execute("x", {
      action: "add",
      text: "stretch",
      at: "2026-10-22T09:00",
    });
    assert.equal((r.details as any).ok, true);
    const saved = f.store.list()[0]!;
    assert.equal(saved.target, "+14165550123");
    assert.equal(saved.channel, "imessage");
    assert.equal(saved.nextDueMs, Date.parse("2026-10-22T13:00:00Z"));
    assert.doesNotMatch(r.content[0]!.text, /cron|argv|schema/);
  } finally {
    f.db.close();
  }
});
test("reschedule preserves id/text, cancels the old pending occurrence, remove verifies absence", async () => {
  const f = fixture();
  try {
    const add = await f.tool.execute("x", {
      action: "add",
      text: "stretch",
      at: "20m",
    });
    const id = (add.details as any).id;
    assert.ok(id);
    const res = await f.tool.execute("x", {
      action: "reschedule",
      id,
      cron: "0 10 * * *",
    });
    assert.equal((res.details as any).ok, true);
    assert.equal(f.store.get(id)?.text, "stretch");
    assert.equal(f.store.get(id)?.revision, 2);
    const rm = await f.tool.execute("x", { action: "remove", id });
    assert.equal((rm.details as any).ok, true);
    assert.equal(f.store.get(id), null);
  } finally {
    f.db.close();
  }
});
test("list/remove are scoped to current owner destination", async () => {
  const f = fixture();
  try {
    f.store.save({
      id: "other",
      text: "private",
      schedule: { kind: "cron", expr: "0 10 * * *", tz: "America/Toronto" },
      channel: "telegram",
      target: "999",
    });
    const list = await f.tool.execute("x", { action: "list" });
    assert.deepEqual((list.details as any).reminders, []);
    assert.equal(
      (await f.tool.execute("x", { action: "remove", id: "other" })).details &&
        f.store.get("other")?.text,
      "private",
    );
  } finally {
    f.db.close();
  }
});
test("invalid, past, quiet schedules are refused without saving; database unavailable never claims success", async () => {
  const f = fixture();
  try {
    for (const p of [
      { at: "2026-10-01T09:00" },
      { at: "2026-10-22T23:00" },
      { cron: "0 0 * * *" },
      { cron: "99 10 * * *" },
      { at: "20m", cron: "0 10 * * *" },
      { at: "tomorrow" },
    ])
      assert.equal(
        (await f.tool.execute("x", { action: "add", text: "test", ...p }))
          .details &&
          ((await f.tool.execute("x", { action: "list" })).details as any)
            .reminders.length,
        0,
      );
    f.db.exec("DROP TABLE owner_reminders");
    const r = await f.tool.execute("x", {
      action: "add",
      text: "test",
      at: "20m",
    });
    assert.equal((r.details as any).ok, false);
    assert.equal((r.details as any).uncertain, true);
  } finally {
    f.db.close();
  }
});
test("quiet admission checks absolute Toronto hour and all cron hours", () => {
  const now = Date.parse("2026-10-21T02:50:00Z");
  assert.equal(reminderOutsideQuietHours("20m", "", now), false);
  for (const expr of [
    "0 * * * *",
    "0 */2 * * *",
    "0 7-10 * * *",
    "0 8-23 * * *",
    "0 9,23 * * *",
  ])
    assert.equal(reminderOutsideQuietHours("", expr, now), false);
  for (const expr of ["0 8-22 * * *", "*/15 9,18,21 * * *", "0 8-22/2 * * *"])
    assert.equal(reminderOutsideQuietHours("", expr, now), true);
});
