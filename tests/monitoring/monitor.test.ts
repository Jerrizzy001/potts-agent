import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMonitoringConfig } from '../../src/monitoring/config.ts';
import { classifyFetchError, summarizeReadinessBody } from '../../src/monitoring/probe.ts';
import { runFor, setupMonitor, TOKEN } from './_site.ts';

const DAY = '2026-10-07T14:00:00Z'; // 10:00 EDT

test('9-minute outage → no incident, no message', async () => {
  const s = setupMonitor(DAY);
  s.st.home = 503;
  s.st.health = 503;
  await runFor(s, 10); // failures at t = 0..9 min (540 s)
  s.st.home = 200;
  s.st.health = 200;
  await runFor(s, 3);
  assert.equal(s.monitor.incidents.listUnresolved().length, 0);
  assert.equal(s.env.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()!.n, 0);
  assert.equal(s.channel.sent.length, 0);
});

test('10+ minute outage → exactly one incident; recovery needs consecutive successes and resolves it', async () => {
  const s = setupMonitor(DAY);
  s.st.home = 502;
  s.st.health = 'timeout';
  const reps = await runFor(s, 31);
  const opened = reps.flatMap((r) => r.opened);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.openedAt, '2026-10-07T14:10:00.000Z');
  assert.equal(opened[0]!.failureClass, 'outage');
  assert.equal(opened[0]!.cause, 'http_5xx');
  assert.equal(s.env.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()!.n, 1);
  const ev = s.urgent.get(opened[0]!.urgentEventId!)!;
  assert.equal(ev.shouldCall, true);
  assert.equal(s.channel.sent.length, 1);
  assert.match(s.channel.sent[0]!.text, /URGENT: Example App looks down/);

  // One good check is not recovery.
  s.st.home = 200;
  s.st.health = 200;
  await runFor(s, 1);
  assert.equal(s.monitor.incidents.get(opened[0]!.id)!.status, 'open');
  s.st.home = 502; // flap
  await runFor(s, 1);
  s.st.home = 200;
  const rec = await runFor(s, 2);
  assert.equal(rec.flatMap((r) => r.resolved).length, 1);
  assert.equal(s.monitor.incidents.get(opened[0]!.id)!.status, 'resolved');
  assert.equal(s.urgent.get(ev.id)!.status, 'resolved');
  // Owner had been told, so the recovery is sent too.
  assert.equal(s.channel.sent.length, 2);
  assert.match(s.channel.sent[1]!.text, /^Resolved: Example App outage/);

  // Evidence: timestamps, status codes, latencies — no bodies.
  const evidence = s.monitor.incidents.evidence(opened[0]!.id);
  assert.ok(evidence.length > 20);
  assert.ok(evidence.some((e) => e.statusCode === 502 && e.check === 'homepage'));
  const cols = (s.env.db.prepare(`SELECT name FROM pragma_table_info('incident_evidence')`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.some((c) => /body/.test(c)));

  // Outage again later → a NEW incident (the old one is resolved).
  s.st.home = 500;
  const again = await runFor(s, 12);
  assert.equal(again.flatMap((r) => r.opened).length, 1);
  assert.equal(s.env.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()!.n, 2);
});

test('Mac offline is not "site down": no incident, explicit monitoring gap', async () => {
  const s = setupMonitor(DAY);
  s.st.internet = false;
  const reps = await runFor(s, 40);
  assert.ok(reps.every((r) => r.observations[0]!.cls === 'mac_offline'));
  assert.ok(s.calls.some((c) => c.url.startsWith('https://1.1.1.1/')));
  assert.ok(s.calls.some((c) => c.url.startsWith('https://www.apple.com/')));
  assert.equal(s.monitor.incidents.listUnresolved().length, 0);
  assert.equal(s.channel.sent.length, 0);
  const st = s.monitor.status('2026-10-07T00:00:00Z')[0]!;
  assert.equal(st.localOfflineSince, '2026-10-07T14:00:00.000Z');
  s.st.internet = true;
  await runFor(s, 1);
  const gap = s.outbox.pendingRoutine();
  assert.equal(gap.length, 1);
  assert.match(gap[0]!.text, /Monitoring gap for Example App: this Mac had no internet from 2026-10-07 10:00 to 2026-10-07 10:40/);
  assert.equal(s.monitor.status('2026-10-07T00:00:00Z')[0]!.localOfflineSince, null);
});

test('site DNS failure while the Mac is online → outage with cause dns; TLS failure → cause tls', async () => {
  const s = setupMonitor(DAY);
  s.st.home = 'dns';
  s.st.health = 'dns';
  const reps = await runFor(s, 11);
  assert.equal(reps[0]!.observations[0]!.cls, 'outage');
  assert.equal(reps[0]!.observations[0]!.cause, 'dns');
  const inc = reps.flatMap((r) => r.opened)[0]!;
  assert.equal(inc.cause, 'dns');

  const t = setupMonitor(DAY);
  t.st.home = 'tls';
  t.st.health = 'tls';
  const r2 = await runFor(t, 11);
  assert.equal(r2.flatMap((r) => r.opened)[0]!.cause, 'tls');
  assert.equal(classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } })), 'dns');
  assert.equal(classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'network');
  assert.equal(classifyFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
});

test('401 on readiness = monitor auth stale, not an outage; no call, routine notice only', async () => {
  const s = setupMonitor(DAY, { readiness: true });
  s.st.readiness = 401;
  const reps = await runFor(s, 12);
  assert.equal(reps[0]!.observations[0]!.cls, 'monitor_auth');
  const opened = reps.flatMap((r) => r.opened);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.failureClass, 'monitor_auth');
  assert.equal(s.monitor.incidents.unresolvedFor('exampleapp', 'outage'), null);
  assert.equal(s.monitor.incidents.unresolvedFor('exampleapp', 'degraded'), null);
  assert.equal(s.urgent.get(opened[0]!.urgentEventId!)!.shouldCall, false);
  assert.equal(s.channel.sent.length, 0); // routine → briefing
  assert.equal(s.outbox.pendingRoutine().length, 1);
  // Readiness requests carried the bearer token; nothing else did.
  assert.ok(s.calls.filter((c) => c.url.endsWith('/api/monitor')).every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.ok(s.calls.filter((c) => !c.url.endsWith('/api/monitor')).every((c) => c.auth === null));
  assert.ok(s.calls.every((c) => c.method === 'GET'));
});

test('homepage green + readiness failing → distinct degraded incident (message, no call)', async () => {
  const s = setupMonitor(DAY, { readiness: true });
  s.st.readiness = { status: 503, body: JSON.stringify({ status: 'degraded', subsystems: { database: 'down', email: 'ok' }, details: { secret: 'x' } }) };
  const reps = await runFor(s, 12);
  const ob = reps[0]!.observations[0]!;
  assert.equal(ob.cls, 'degraded');
  assert.equal(ob.cause, 'readiness_degraded');
  assert.deepEqual(ob.readiness, { status: 'degraded', subsystems: { database: 'down', email: 'ok' } });
  const opened = reps.flatMap((r) => r.opened);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.failureClass, 'degraded');
  assert.equal(s.monitor.incidents.unresolvedFor('exampleapp', 'outage'), null);
  assert.equal(s.urgent.get(opened[0]!.urgentEventId!)!.shouldCall, false);
  assert.equal(s.channel.sent.length, 1);
  assert.match(s.channel.sent[0]!.text, /^Heads-up: Example App is half-working/);
});

test('429 → rate limited: backs off per Retry-After, never counts as an outage', async () => {
  const s = setupMonitor(DAY);
  s.st.home = { status: 429, headers: { 'retry-after': '900' } };
  s.st.health = { status: 429 };
  const r = await s.monitor.runOnce();
  assert.equal(r.observations[0]!.cls, 'rate_limited');
  assert.equal(r.nextDelayMs, 900_000);
  const before = s.calls.length;
  s.env.clock.advanceMs(60_000);
  const r2 = await s.monitor.runOnce();
  assert.equal(r2.observations.length, 0); // skipped while limited
  assert.equal(s.calls.length, before);
  await runFor(s, 30);
  assert.equal(s.monitor.incidents.listUnresolved().length, 0);
});

test('planned maintenance window → no incident', async () => {
  const s = setupMonitor(DAY, { site: { maintenanceWindows: [{ start: '2026-10-07T13:30:00Z', end: '2026-10-07T15:00:00Z', reason: 'deploy' }] } });
  s.st.home = 503;
  const reps = await runFor(s, 30);
  assert.ok(reps.slice(0, 30).every((r) => r.observations[0]!.cls === 'maintenance'));
  assert.equal(s.calls.length, 0);
  assert.equal(s.monitor.incidents.listUnresolved().length, 0);
});

test('critical read journey: GET-only, content checked, failure → degraded', async () => {
  assert.throws(() => normalizeMonitoringConfig({ sites: [{ id: 'x', name: 'x', baseUrl: 'https://x.test', journeys: [{ name: 'apply', path: '/api/apply', method: 'POST' }] }] }), /GET-only/);
  assert.throws(() => normalizeMonitoringConfig({ sites: [{ id: 'x', name: 'x', baseUrl: 'http://x.test' }] }), /https/);
  assert.throws(() => normalizeMonitoringConfig({ sites: [{ id: 'x', name: 'x', baseUrl: 'https://x.test', journeys: [{ name: 'j', path: '//evil.test/' }] }] }), /absolute path/);
  const s = setupMonitor(DAY, { journeys: true });
  s.st.journey = { status: 200, body: '<html>maintenance page</html>' };
  const reps = await runFor(s, 11);
  assert.equal(reps[0]!.observations[0]!.cls, 'degraded');
  assert.equal(reps[0]!.observations[0]!.cause, 'content_mismatch');
  assert.equal(reps.flatMap((r) => r.opened)[0]!.failureClass, 'degraded');
});

test('readiness secrets: token never logged or stored; only a coarse summary is kept', async () => {
  const logs: string[] = [];
  const s = setupMonitor(DAY, { readiness: true, logSink: logs });
  s.st.readiness = { status: 200, body: JSON.stringify({ status: 'ok', subsystems: { database: 'ok', 'Bad Key!': 'ok', db2: 'weird' }, data: { RESEND_API_KEY: 'sk_live_zzz' } }) };
  const r = await runFor(s, 3);
  assert.deepEqual(r[0]!.observations[0]!.readiness, { status: 'ok', subsystems: { database: 'ok' } });
  const dump = JSON.stringify(
    ['monitor_checks', 'incident_evidence', 'incidents', 'urgent_events', 'owner_notifications', 'monitor_site_state'].map((t) => s.env.db.prepare(`SELECT * FROM ${t}`).all()),
  );
  for (const hay of [dump, logs.join('\n')]) {
    assert.ok(!hay.includes(TOKEN));
    assert.ok(!hay.includes('sk_live_zzz'));
  }
  assert.ok(logs.length > 0);
  assert.deepEqual(summarizeReadinessBody('not json'), { status: null, subsystems: {} });
});

test('the monitor token being unavailable is an auth problem, not an outage', async () => {
  const s = setupMonitor(DAY, { readiness: true });
  s.st.tokenAvailable = false;
  const reps = await runFor(s, 12);
  assert.equal(reps[0]!.observations[0]!.cls, 'monitor_auth');
  assert.equal(reps.flatMap((r) => r.opened)[0]!.failureClass, 'monitor_auth');
  assert.ok(!s.calls.some((c) => c.url.endsWith('/api/monitor')));
});
