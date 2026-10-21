import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox } from '../../src/notifications/outbox.ts';
import { createFakeOwnerChannel, TELEGRAM_MAX_CHARS } from '../../src/notifications/channel.ts';
import { DEFAULT_QUIET_HOURS, normalizeQuietHours } from '../../src/notifications/quiet-hours.ts';
import { createUrgentEventStore } from '../../src/notifications/urgent.ts';
import { bindUrgentEventsToOutbox } from '../../src/notifications/bind.ts';
import { chunkText } from '../../src/notifications/chunk.ts';
import { makeEnv } from '../jobs/_helpers.ts';

function setup(start: string, quiet = DEFAULT_QUIET_HOURS) {
  const env = makeEnv(start);
  const channel = createFakeOwnerChannel(() => env.clock.nowMs());
  const outbox = createOutbox({ db: env.db, clock: env.clock, quiet, channel, random: () => 0 });
  const urgent = createUrgentEventStore(env.db, env.clock);
  bindUrgentEventsToOutbox(urgent, outbox);
  return { env, channel, outbox, urgent };
}

/** Advance in steps, dispatching like the 30s job would. */
async function dispatchUntil(s: ReturnType<typeof setup>, untilIso: string, stepMs = 60_000) {
  const end = Date.parse(untilIso);
  while (s.env.clock.nowMs() < end) {
    s.env.clock.advanceMs(stepMs);
    await s.outbox.dispatchDue();
  }
}

test('event at 23:01 is held at dispatch time until 08:00 (no urgent override), then delivered once', async () => {
  const s = setup('2026-10-07T03:01:00Z'); // 23:01 EDT Oct 6
  const { event } = s.urgent.raise({ dedupKey: 'task:a1:due:x', sourceType: 'task_due', sourceRef: 'a1', title: 'Essay due 04:00', shouldCall: true });
  const r = await s.outbox.dispatchDue();
  assert.equal(r.held.length, 1);
  assert.equal(s.channel.sent.length, 0);
  await dispatchUntil(s, '2026-10-07T11:59:00Z'); // 07:59
  assert.equal(s.channel.sent.length, 0);
  await dispatchUntil(s, '2026-10-07T12:01:00Z'); // 08:01
  assert.equal(s.channel.sent.length, 1);
  assert.equal(s.channel.sent[0]!.at, Date.parse('2026-10-07T12:00:00Z'));
  assert.match(s.channel.sent[0]!.text, /Essay due/);
  assert.match(s.channel.sent[0]!.text, new RegExp(event.id));
  await dispatchUntil(s, '2026-10-07T13:00:00Z');
  assert.equal(s.channel.sent.length, 1);
});

test('quiet hours are enforced at dispatch, not enqueue: enqueued at 22:50, dispatched at 23:00 → held', async () => {
  const s = setup('2026-10-07T02:50:00Z');
  s.outbox.enqueue({ dedupKey: 'x1', category: 'important', text: 'hello' });
  s.env.clock.set('2026-10-07T03:00:00Z');
  const r = await s.outbox.dispatchDue();
  assert.equal(r.held.length, 1);
  assert.equal(s.channel.sent.length, 0);
});

test('a retry that would cross 23:00 is held until 08:00', async () => {
  const s = setup('2026-10-07T02:58:00Z'); // 22:58
  s.channel.setMode('reject', 1); // provider says retry in 1s; outbox backoff 30s * 2^0 = 30s... use explicit retryAfter
  s.outbox.enqueue({ dedupKey: 'r1', category: 'important', text: 'Example App degraded' });
  const r1 = await s.outbox.dispatchDue();
  assert.deepEqual(r1.retrying.length, 1);
  // force the retry time past 23:00 to model a 5-minute provider backoff
  s.env.db.prepare(`UPDATE owner_notifications SET next_attempt_ms = ? WHERE dedup_key = 'r1'`).run(Date.parse('2026-10-07T03:03:00Z'));
  await dispatchUntil(s, '2026-10-07T11:59:00Z');
  assert.equal(s.channel.sent.length, 0);
  const n = s.outbox.getByDedupKey('r1')!;
  assert.equal(n.status, 'pending');
  assert.equal(n.heldSinceMs, Date.parse('2026-10-07T03:03:00Z'));
  await dispatchUntil(s, '2026-10-07T12:00:00Z');
  assert.equal(s.channel.sent.length, 1);
  assert.equal(s.outbox.getByDedupKey('r1')!.status, 'delivered');
});

test('held urgent message is dropped at 08:00 when its event was acknowledged or resolved overnight', async () => {
  const s = setup('2026-10-07T05:00:00Z'); // 01:00
  const a = s.urgent.raise({ dedupKey: 'k-a', sourceType: 'interview_invitation', sourceRef: 'm1', title: 'Interview invite', shouldCall: true }).event;
  const b = s.urgent.raise({ dedupKey: 'k-b', sourceType: 'task_due', sourceRef: 'a2', title: 'Lab due', shouldCall: true }).event;
  await s.outbox.dispatchDue();
  s.urgent.acknowledge(a.id, 'owner:telegram');
  s.urgent.resolve(b.id, 'task completed');
  await dispatchUntil(s, '2026-10-07T12:30:00Z');
  assert.equal(s.channel.sent.length, 0);
  const dropped = s.outbox.list({ status: 'dropped' });
  assert.deepEqual(dropped.map((d) => d.dropReason).sort(), ['event already acknowledged', 'event resolved (task completed)']);
});

test('approval requests are held in quiet hours and re-validated at 08:00', async () => {
  const s = setup('2026-10-07T04:00:00Z');
  const pending = new Set(['apr_1', 'apr_2']);
  s.outbox.setValidator('approval_request', (n) => (pending.has(n.eventRef ?? '') ? { deliver: true } : { deliver: false, reason: 'approval no longer pending' }));
  s.outbox.enqueue({ dedupKey: 'approval:apr_1', category: 'approval_request', text: 'Approve sending reply to Alex?', eventRef: 'apr_1' });
  s.outbox.enqueue({ dedupKey: 'approval:apr_2', category: 'approval_request', text: 'Approve deploy?', eventRef: 'apr_2' });
  await s.outbox.dispatchDue();
  assert.equal(s.channel.sent.length, 0);
  pending.delete('apr_2'); // expired overnight
  await dispatchUntil(s, '2026-10-07T12:01:00Z');
  assert.deepEqual(s.channel.sent.map((m) => m.text), ['Approve sending reply to Alex?']);
});

test('owner-initiated reply: held by default (strict); immediate only when configured', async () => {
  const strict = setup('2026-10-07T04:00:00Z');
  strict.outbox.enqueue({ dedupKey: 'reply:1', category: 'reply', text: 'Here is the answer' });
  await strict.outbox.dispatchDue();
  assert.equal(strict.channel.sent.length, 0);
  const relaxed = setup('2026-10-07T04:00:00Z', normalizeQuietHours({ ownerInitiatedReplyAllowed: true }));
  relaxed.outbox.enqueue({ dedupKey: 'reply:1', category: 'reply', text: 'Here is the answer' });
  relaxed.outbox.enqueue({ dedupKey: 'other', category: 'urgent', text: 'still held' });
  await relaxed.outbox.dispatchDue();
  assert.deepEqual(relaxed.channel.sent.map((m) => m.text), ['Here is the answer']);
});

test('dedup keys: the same key is enqueued once', () => {
  const s = setup('2026-10-07T14:00:00Z');
  assert.equal(s.outbox.enqueue({ dedupKey: 'd', category: 'important', text: 'a' }).duplicate, false);
  assert.equal(s.outbox.enqueue({ dedupKey: 'd', category: 'important', text: 'b' }).duplicate, true);
  assert.equal(s.outbox.list().length, 1);
  // urgent events are deduplicated too
  s.urgent.raise({ dedupKey: 'e', sourceType: 'other', sourceRef: 'x', title: 't', shouldCall: false });
  s.urgent.raise({ dedupKey: 'e', sourceType: 'other', sourceRef: 'x', title: 't', shouldCall: false });
  assert.equal(s.outbox.list().length, 2);
});

test('at-most-once: an uncertain send is never retried; a crash mid-send becomes uncertain on recovery', async () => {
  const s = setup('2026-10-07T14:00:00Z');
  s.channel.setMode('throw_uncertain', 1);
  s.outbox.enqueue({ dedupKey: 'u', category: 'important', text: 'maybe sent' });
  const r = await s.outbox.dispatchDue();
  assert.equal(r.uncertain.length, 1);
  s.env.clock.advanceMs(3600_000);
  await s.outbox.dispatchDue();
  assert.equal(s.channel.sent.length, 1); // only the one the provider accepted before the error
  assert.equal(s.outbox.getByDedupKey('u')!.status, 'uncertain');

  // Simulate a crash between "sending" and the result.
  s.outbox.enqueue({ dedupKey: 'c', category: 'important', text: 'crash' });
  const id = s.outbox.getByDedupKey('c')!.id;
  s.env.db.prepare(`UPDATE owner_notifications SET status = 'sending', attempts = 1 WHERE id = ?`).run(id);
  s.env.db.prepare(`INSERT INTO owner_delivery_attempts (id, notification_id, attempt, started_at, outcome) VALUES ('dlv_x', ?, 1, ?, 'sending')`).run(id, s.env.clock.nowIso());
  assert.equal(s.outbox.recover(), 1);
  await s.outbox.dispatchDue();
  assert.equal(s.outbox.get(id)!.status, 'uncertain');
  assert.equal(s.channel.sent.length, 1);
  // A DB invariant forbids a second possible-send attempt.
  assert.throws(() =>
    s.env.db.prepare(`INSERT INTO owner_delivery_attempts (id, notification_id, attempt, started_at, outcome) VALUES ('dlv_y', ?, 2, ?, 'sending')`).run(id, s.env.clock.nowIso()),
  );
});

test('definitive rejections retry with backoff up to the limit, then fail', async () => {
  const s = setup('2026-10-07T14:00:00Z');
  s.channel.setMode('reject');
  s.outbox.enqueue({ dedupKey: 'f', category: 'important', text: 'x' });
  for (let i = 0; i < 10; i++) {
    await s.outbox.dispatchDue();
    s.env.clock.advanceMs(20 * 60_000);
  }
  const n = s.outbox.getByDedupKey('f')!;
  assert.equal(n.status, 'failed');
  assert.equal(n.attempts, 5);
});

test('routine items are never sent alone; they wait for a briefing', async () => {
  const s = setup('2026-10-07T14:00:00Z');
  s.outbox.enqueue({ dedupKey: 'n1', category: 'routine', text: 'Newsletter from X' });
  await dispatchUntil(s, '2026-10-07T18:00:00Z', 10 * 60_000);
  assert.equal(s.channel.sent.length, 0);
  assert.equal(s.outbox.pendingRoutine().length, 1);
});

test('long text is chunked into Telegram-sized parts', async () => {
  const s = setup('2026-10-07T14:00:00Z');
  const para = 'Line of briefing text that is moderately long. '.repeat(20);
  const text = Array.from({ length: 12 }, () => para).join('\n\n');
  assert.ok(text.length > 2 * TELEGRAM_MAX_CHARS);
  const r = s.outbox.enqueue({ dedupKey: 'long', category: 'important', text });
  assert.ok(r.ids.length >= 3);
  await s.outbox.dispatchDue();
  assert.equal(s.channel.sent.length, r.ids.length);
  for (const m of s.channel.sent) assert.ok(m.text.length <= TELEGRAM_MAX_CHARS);
  assert.match(s.channel.sent[0]!.text, /^\(1\/\d+\)/);
  for (const c of chunkText('x'.repeat(10_000), 4096)) assert.ok(c.length <= 4096);
});
