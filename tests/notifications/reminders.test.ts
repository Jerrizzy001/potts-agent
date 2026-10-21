import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/db.ts";
import { migrate } from "../../src/store/migrate.ts";
import { createFakeClock } from "../../src/core/clock.ts";
import {
  createReminderStore,
  nextReminderDue,
} from "../../src/notifications/reminders.ts";
import { createOutbox } from "../../src/notifications/outbox.ts";
import { createFakeOwnerChannel } from "../../src/notifications/channel.ts";
import { DEFAULT_QUIET_HOURS } from "../../src/notifications/quiet-hours.ts";
import {
  createGatewayTelegramDeliver,
  startOwnerChannelServer,
} from "../../integrations/openclaw/potts-broker-plugin/lib/owner-channel.ts";
import { createPluginSocketOwnerChannel } from "../../src/owner/owner-channel.ts";
import { outboxChannelFromPlugin } from "../../src/daemon/owner-notify.ts";
const destination = { channel: "imessage", target: "+14165550123" };
function fixture(start = "2026-10-22T02:59:00Z", path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  const clock = createFakeClock(start);
  const channel = createFakeOwnerChannel(clock.nowMs);
  const outbox = createOutbox({
    db,
    clock,
    quiet: DEFAULT_QUIET_HOURS,
    channel,
    random: () => 0,
  });
  return { db, clock, channel, outbox, store: createReminderStore(db, clock) };
}
function add(
  f: ReturnType<typeof fixture>,
  id = "once",
  at = "2026-10-22T02:59:00Z",
) {
  f.store.save({
    id,
    text: "Take a break",
    schedule: { kind: "at", at },
    ...destination,
  });
}
test("late one-shot retains a durable morning delivery even after schedule completion and process reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "potts-reminder-"));
  let f = fixture(undefined, join(dir, "state.db"));
  try {
    add(f);
    f.clock.set("2026-10-22T03:01:00Z");
    assert.equal(f.store.enqueueDue(f.outbox, destination), 1);
    assert.equal(f.store.enqueueDue(f.outbox, destination), 0);
    assert.equal(f.store.get("once")?.enabled, false);
    assert.equal((await f.outbox.dispatchDue()).held.length, 1);
    assert.equal(f.channel.sent.length, 0);
    f.db.close();
    f = fixture("2026-10-22T11:59:59Z", join(dir, "state.db"));
    assert.equal((await f.outbox.dispatchDue()).delivered.length, 0);
    f.clock.set("2026-10-22T12:00:00Z");
    assert.equal((await f.outbox.dispatchDue()).delivered.length, 1);
    assert.equal(f.outbox.list()[0]?.attempts, 1);
    await f.outbox.dispatchDue();
    assert.equal(f.channel.sent.length, 1);
  } finally {
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("definitive rejection just before23 retries only after08; uncertain delivery never retries", async () => {
  const f = fixture("2026-10-22T02:59:50Z");
  try {
    add(f);
    f.store.enqueueDue(f.outbox, destination);
    f.channel.setMode("reject", 1);
    assert.equal((await f.outbox.dispatchDue()).retrying.length, 1);
    f.clock.set("2026-10-22T03:01:00Z");
    assert.equal((await f.outbox.dispatchDue()).held.length, 1);
    assert.equal(f.channel.sent.length, 0);
    f.clock.set("2026-10-22T12:00:00Z");
    f.channel.setMode("throw_uncertain", 1);
    assert.equal((await f.outbox.dispatchDue()).uncertain.length, 1);
    assert.equal(f.channel.sent.length, 1);
    f.clock.advanceMs(86400000);
    await f.outbox.dispatchDue();
    assert.equal(f.channel.sent.length, 1);
  } finally {
    f.db.close();
  }
});
test("recurring wake coalesces missed occurrences and maintains separate dedup keys", async () => {
  const f = fixture("2026-10-20T12:00:00Z");
  try {
    f.store.save({
      id: "daily",
      text: "Stretch",
      schedule: { kind: "cron", expr: "0 22 * * *", tz: "America/Toronto" },
      ...destination,
    });
    f.clock.set("2026-10-24T04:00:00Z");
    assert.equal(f.store.enqueueDue(f.outbox, destination), 1);
    assert.equal(f.store.enqueueDue(f.outbox, destination), 0);
    await f.outbox.dispatchDue();
    assert.equal(f.outbox.list()[0]?.status, "pending");
    assert.equal(
      f.store.get("daily")?.nextDueMs,
      Date.parse("2026-10-25T02:00:00Z"),
    );
    f.clock.set("2026-10-24T12:00:00Z");
    await f.outbox.dispatchDue();
    f.clock.set("2026-10-25T02:00:00Z");
    f.store.enqueueDue(f.outbox, destination);
    await f.outbox.dispatchDue();
    assert.equal(f.channel.sent.length, 2);
  } finally {
    f.db.close();
  }
});
test("cancellation/reschedule drops held occurrence and mismatched destination never enqueues", async () => {
  const f = fixture();
  try {
    add(f);
    assert.equal(
      f.store.enqueueDue(f.outbox, { ...destination, target: "wrong" }),
      0,
    );
    f.store.enqueueDue(f.outbox, destination);
    f.store.remove("once");
    assert.equal(f.outbox.list()[0]?.status, "dropped");
    add(f, "change");
    f.store.enqueueDue(f.outbox, destination);
    f.store.save(
      {
        id: "change",
        text: "New",
        schedule: { kind: "at", at: "2026-10-22T13:00:00Z" },
        ...destination,
      },
      true,
    );
    assert.equal(f.outbox.list()[1]?.status, "dropped");
  } finally {
    f.db.close();
  }
});
test("quiet morning release tracks Toronto DST spring and fall", async () => {
  for (const [night, morning] of [
    ["2027-03-14T04:30:00Z", "2027-03-14T12:00:00Z"],
    ["2026-11-01T03:30:00Z", "2026-11-01T13:00:00Z"],
  ]) {
    const f = fixture(night);
    try {
      add(f, "dst", night);
      f.store.enqueueDue(f.outbox, destination);
      await f.outbox.dispatchDue();
      assert.equal(f.outbox.list()[0]?.nextAttemptMs, Date.parse(morning!));
      f.clock.set(morning!);
      await f.outbox.dispatchDue();
      assert.equal(f.channel.sent.length, 1);
    } finally {
      f.db.close();
    }
  }
  assert.equal(
    nextReminderDue(
      { kind: "cron", expr: "0 8 * * *", tz: "America/Toronto" },
      Date.parse("2026-11-01T03:30:00Z"),
    ),
    Date.parse("2026-11-01T13:00:00Z"),
  );
});
test("real socket path rechecks after async adapter load crosses23 and preserves retry budget", async () => {
  const f = fixture("2026-10-22T02:59:59Z");
  const dir = mkdtempSync(join(tmpdir(), "potts-qh-"));
  const path = join(dir, "owner.sock");
  const key = Buffer.alloc(32, 3);
  let sent = 0;
  let cross = true;
  const deliver = createGatewayTelegramDeliver(
    {
      channel: {
        outbound: {
          loadAdapter: async () => {
            if (cross) f.clock.set("2026-10-22T03:00:00Z");
            return {
              sendText: async () => {
                sent++;
                return { messageId: "receipt-1" };
              },
            };
          },
        },
      },
    },
    () => ({}),
    undefined,
    "imessage",
    destination.target,
    f.clock.nowMs,
  );
  const server = await startOwnerChannelServer({
    socketPath: path,
    secrets: {
      get: async () => ({ key, ownerId: destination.target }),
    } as never,
    deliver,
    approvalPrompt: async () => ({ ok: false, error: "unused" }),
    now: f.clock.nowMs,
  });
  try {
    f.outbox.setChannel(
      outboxChannelFromPlugin(
        createPluginSocketOwnerChannel({ socketPath: path, key }),
      ),
    );
    add(f);
    f.store.enqueueDue(f.outbox, destination);
    assert.equal((await f.outbox.dispatchDue()).held.length, 1);
    assert.equal(sent, 0);
    assert.equal(f.outbox.list()[0]?.attempts, 0);
    assert.equal(f.outbox.list()[0]?.status, "pending");
    cross = false;
    f.clock.set("2026-10-22T12:00:00Z");
    assert.equal((await f.outbox.dispatchDue()).delivered.length, 1);
    assert.equal(sent, 1);
  } finally {
    await server.close();
    f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("in-flight cancellation/reschedule is refused and quiet deferral cannot resurrect a cancelled reminder", async () => {
  const f = fixture();
  try {
    add(f);
    f.store.enqueueDue(f.outbox, destination);
    const row = f.outbox.list()[0]!;
    f.db
      .prepare("UPDATE owner_notifications SET status='sending' WHERE id=?")
      .run(row.id);
    assert.throws(() => f.store.remove("once"), /already being delivered/);
    assert.throws(
      () =>
        f.store.save(
          {
            id: "once",
            text: "New",
            schedule: { kind: "at", at: "2026-10-22T15:00:00Z" },
            ...destination,
          },
          true,
        ),
      /already being delivered/,
    );
    assert.equal(f.store.get("once")?.text, "Take a break");
    f.db.prepare("UPDATE owner_notifications SET status='uncertain' WHERE id=?").run(row.id);
    assert.throws(() => f.store.remove("once"), /unconfirmed delivery/);
    f.db
      .prepare("UPDATE owner_notifications SET status='pending' WHERE id=?")
      .run(row.id);
    f.store.remove("once");
    await f.outbox.dispatchDue();
    assert.equal(f.outbox.get(row.id)?.status, "dropped");
    assert.equal(f.channel.sent.length, 0);
  } finally {
    f.db.close();
  }
});
test("destination is checked after asynchronous loading, before any native adapter call", async () => {
  let sent = 0;
  const deliver = createGatewayTelegramDeliver(
    {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async () => {
              sent++;
              return { messageId: "wrong" };
            },
          }),
        },
      },
    },
    () => ({}),
    undefined,
    "imessage",
    "+14165550999",
  );
  await assert.rejects(
    () =>
      deliver({
        to: destination.target,
        text: "private",
        expectedDestination: destination,
      }),
    /destination changed/,
  );
  assert.equal(sent, 0);
});
test("pending reminder is coalesced across additional missed daily occurrences and stale revision is rejected", async () => {
  const f = fixture("2026-10-20T12:00:00Z");
  try {
    f.store.save({
      id: "daily",
      text: "Stretch",
      schedule: { kind: "cron", expr: "0 22 * * *", tz: "America/Toronto" },
      ...destination,
    });
    f.clock.set("2026-10-21T03:00:00Z");
    f.store.enqueueDue(f.outbox, destination);
    await f.outbox.dispatchDue();
    f.clock.set("2026-10-24T04:00:00Z");
    assert.equal(f.store.enqueueDue(f.outbox, destination), 0);
    assert.equal(f.outbox.list().length, 1);
    f.db
      .prepare("UPDATE owner_reminders SET revision=revision+1 WHERE id=?")
      .run("daily");
    f.clock.set("2026-10-24T12:00:00Z");
    assert.equal((await f.outbox.dispatchDue()).dropped.length, 1);
    assert.equal(f.channel.sent.length, 0);
  } finally {
    f.db.close();
  }
});
