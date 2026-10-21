import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnv, type Env } from '../writers/helpers.ts';
import {
  createOwnerAlertExecutor, createOwnerAlertHook, createOwnerAlertService, createTelephonyStore, createTwilioWebhookHandler, startTelephonyWebhookServer,
  twilioSignature, validTwilioSignature, alertMessage, alertTwiml, buildThirdPartyCallProposal, registerOwnerAlertCalls, refreshCallUsage,
  createTwilioProvider, TELEPHONY_CONFIG_SCHEMA, validateTelephonyConfig, STATUS_PATH, GATHER_PATH, type OwnerAlertService, type TelephonyStore,
} from '../../src/telephony/index.ts';
import { createFakeIncidentValidator, createFakeQuietHoursDecider, createFakeTelephonyProvider } from '../../src/telephony/testing.ts';
import { createExecutorRegistry } from '../../src/broker/executor.ts';
import { createAccountRegistry } from '../../src/core/config.ts';
import { TEST_ACCOUNTS } from '../../src/broker/testing.ts';

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const AUTH_TOKEN = 'test-auth-token-not-real';
const PUBLIC = 'https://potts-calls.example.test';
const OWNER_NUMBER = '+14165550199';

function setup() {
  const decider = createFakeQuietHoursDecider();
  const incidents = createFakeIncidentValidator();
  let provider!: ReturnType<typeof createFakeTelephonyProvider>;
  const mk = (env?: Env) => {
    const e: Env = (env ? env.reopen() : createEnv({
      executors: ({ db, clock }) => {
        provider ??= createFakeTelephonyProvider(clock);
        return [createOwnerAlertExecutor({
          store: createTelephonyStore(db, clock), clock, decider, incidents, provider, policy: () => e.policy.current, accountId: 'telephony-alerts',
          fromNumber: '+15550000000', ownerNumber: async () => OWNER_NUMBER, publicBaseUrl: PUBLIC,
        })];
      },
      hooks: ({ db, clock }) => ({ ownerAlert: createOwnerAlertHook({ store: createTelephonyStore(db, clock), decider, incidents, clock }) }),
    }));
    const store = createTelephonyStore(e.db, e.clock);
    const service = createOwnerAlertService({ store, clock: e.clock, decider, incidents, broker: e.broker, policy: () => e.policy.current, accountId: 'telephony-alerts' });
    const handler = createTwilioWebhookHandler({ store, clock: e.clock, accountSid: ACCOUNT_SID, authToken: async () => AUTH_TOKEN, publicBaseUrl: PUBLIC });
    return { env: e, store, service, handler };
  };
  const first = mk();
  return { ...first, provider: () => provider, decider, incidents, restart: (env: Env) => mk(env) };
}

/** Builds a correctly signed Twilio callback for the n-th placed call. */
function callback(provider: ReturnType<typeof createFakeTelephonyProvider>, n: number, kind: 'status' | 'gather', fields: Record<string, string>, opts: { token?: string; accountSid?: string } = {}) {
  const placed = provider.placed[n]!;
  const full = kind === 'status' ? placed.script.statusUrl : placed.script.gatherUrl;
  const url = full.slice(PUBLIC.length);
  const params = new URLSearchParams({ AccountSid: opts.accountSid ?? ACCOUNT_SID, CallSid: placed.sid, From: placed.from, To: placed.to, ...fields });
  return {
    method: 'POST', url, body: params.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(opts.token ?? AUTH_TOKEN, `${PUBLIC}${url}`, params) },
  };
}

const at = (env: Env, iso: string) => env.clock.set(iso);

test('Twilio signature matches the published reference vector; tampering invalidates it', () => {
  const p = new URLSearchParams({ CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' });
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  assert.equal(twilioSignature('12345', url, p), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  assert.ok(validTwilioSignature('12345', url, p, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validTwilioSignature('54321', url, p, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validTwilioSignature('12345', url.replace('foo=1', 'foo=2'), p, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  p.set('Digits', '1');
  assert.ok(!validTwilioSignature('12345', url, p, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='));
  assert.ok(!validTwilioSignature('12345', url, p, undefined));
});

test('alert content is short, generic and escaped; no personal data reaches the provider', async () => {
  const { env, service, provider } = setup();
  try {
    assert.ok(service.raise({ incidentId: 'inc-site-1', trigger: 'website_outage', label: 'Example App <script>' }).ok);
    const ev = await service.tick();
    assert.equal(ev[0]!.event, 'called', JSON.stringify(ev));
    const call = provider().placed[0]!;
    assert.equal(call.to, OWNER_NUMBER);
    assert.equal(call.from, '+15550000000');
    assert.equal(call.script.say, 'Hi, this is Potts with an alert. Example App script has been down for at least ten minutes. Details are in Telegram. Press 1 to acknowledge.');
    assert.ok(call.machineDetection);
    // The action itself never contains the real number.
    const a = env.broker.list()[0]!;
    assert.deepEqual(a.destination, ['owner']);
    const tw = alertTwiml(alertMessage('test', null), 'https://x.test/g?c=1&d=<2>');
    assert.match(tw, /<Gather input="dtmf" numDigits="1"/);
    assert.match(tw, /action="https:\/\/x.test\/g\?c=1&amp;d=&lt;2&gt;"/);
  } finally {
    env.close();
  }
});

test('voicemail / answered status is not acknowledgement; DTMF 1 stops retries', async () => {
  const { env, service, provider, handler, store } = setup();
  try {
    service.raise({ incidentId: 'inc-1', trigger: 'interview_invitation' });
    await service.tick();
    // Answering machine picked up and the call completed: NOT an acknowledgement.
    for (const f of [{ CallStatus: 'in-progress', AnsweredBy: 'machine_end_beep', SequenceNumber: '2' }, { CallStatus: 'completed', CallDuration: '31', SequenceNumber: '3' }] as Record<string, string>[]) {
      const r = await handler(callback(provider(), 0, 'status', f));
      assert.equal(r.status, 200);
    }
    assert.equal(store.incident('inc-1')!.status, 'active');
    assert.equal(store.calls('inc-1')[0]!.answeredBy, 'machine_end_beep');
    // Gather with no/other digit is not acknowledgement either.
    const g0 = await handler(callback(provider(), 0, 'gather', { Digits: '7' }));
    assert.match(g0.body, /Not acknowledged/);
    assert.equal(store.incident('inc-1')!.status, 'active');

    env.clock.advanceSeconds(299);
    assert.deepEqual(await service.tick(), [], 'not due yet');
    assert.equal(provider().placed.length, 1, 'no retry before 300 s');
    env.clock.advanceSeconds(1);
    assert.equal((await service.tick())[0]!.event, 'called');
    assert.equal(provider().placed.length, 2);

    const ack = await handler(callback(provider(), 1, 'gather', { Digits: '1' }));
    assert.equal(ack.status, 200);
    assert.match(ack.body, /acknowledged/);
    assert.equal(store.incident('inc-1')!.status, 'acknowledged');
    env.clock.advanceSeconds(600);
    assert.deepEqual(await service.tick(), []);
    assert.equal(provider().placed.length, 2, 'acknowledged incident is never called again');
  } finally {
    env.close();
  }
});

test('3-attempt limit survives a restart (attempts are persisted before dialling)', async () => {
  const s = setup();
  let { env, service } = s;
  try {
    service.raise({ incidentId: 'inc-2', trigger: 'website_outage', label: 'Example App' });
    await service.tick();
    env.clock.advanceSeconds(300);
    await service.tick();
    assert.equal(s.provider().placed.length, 2);
    // Crash/restart: new broker, store and service on the same DB.
    ({ env, service } = s.restart(env));
    env.broker.recover();
    env.clock.advanceSeconds(300);
    assert.equal((await service.tick())[0]!.event, 'called');
    env.clock.advanceSeconds(300);
    const ev = await service.tick();
    assert.equal(ev[0]!.event, 'exhausted');
    assert.equal(s.provider().placed.length, 3);
    // A hand-crafted 4th attempt is denied by policy.
    const p = env.broker.propose({ kind: 'call_owner_alert', accountId: 'telephony-alerts', destination: ['owner'], payload: { incidentId: 'inc-2', trigger: 'website_outage', attempt: 4, label: 'Example App' } }, 'openclaw');
    assert.ok(p.ok && p.value.status === 'denied', JSON.stringify(p));
    // ... and replaying attempt 1 (out of sequence) is denied too.
    const r1 = env.broker.propose({ kind: 'call_owner_alert', accountId: 'telephony-alerts', destination: ['owner'], payload: { incidentId: 'inc-2', trigger: 'website_outage', attempt: 1, label: 'Example App' } }, 'openclaw');
    assert.ok(r1.ok && r1.value.status === 'denied');
    assert.equal(s.provider().placed.length, 3);
  } finally {
    env.close();
  }
});

test('quiet hours rechecked at dispatch: a retry crossing 23:00 is held until 08:00, then revalidated', async () => {
  const { env, service, provider, store, incidents } = setup();
  try {
    at(env, '2026-10-07T02:52:00.000Z'); // 22:52 Toronto (EDT)
    service.raise({ incidentId: 'inc-3', trigger: 'task_due' });
    assert.equal((await service.tick())[0]!.event, 'called');
    env.clock.advanceSeconds(300); // 22:57
    assert.equal((await service.tick())[0]!.event, 'called');
    env.clock.advanceSeconds(300); // 23:02 — third attempt would cross into quiet hours
    const ev = await service.tick();
    assert.equal(ev[0]!.event, 'quiet_hours');
    assert.equal(provider().placed.length, 2);
    assert.equal(store.incident('inc-3')!.nextAttemptAt, '2026-10-07T12:00:00.000Z', 'next attempt at 08:00 Toronto');
    // Overnight: nothing happens.
    at(env, '2026-10-07T09:30:00.000Z');
    assert.deepEqual(await service.tick(), []);
    // The incident was resolved before morning: no stale 08:00 call.
    incidents.inactive.set('inc-3', 'assignment completed');
    at(env, '2026-10-07T12:00:30.000Z');
    assert.equal((await service.tick())[0]!.event, 'resolved');
    assert.equal(provider().placed.length, 2);
  } finally {
    env.close();
  }
});

test('dispatch-time recheck: an action allowed at 22:59 is held if executed after 23:00', async () => {
  const { env, service, provider } = setup();
  try {
    at(env, '2026-10-07T02:59:30.000Z'); // 22:59:30 Toronto
    service.raise({ incidentId: 'inc-4', trigger: 'business_opportunity' });
    const p = env.broker.propose({ kind: 'call_owner_alert', accountId: 'telephony-alerts', destination: ['owner'], payload: { incidentId: 'inc-4', trigger: 'business_opportunity', attempt: 1 } }, 'system:owner-alert');
    assert.ok(p.ok && p.value.status === 'ready', JSON.stringify(p));
    env.clock.advanceSeconds(60); // 23:00:30
    const r = await env.broker.execute(p.value.actionId);
    assert.equal(!r.ok && r.error.code, 'held');
    assert.equal(provider().placed.length, 0);
    // Owner alert calls to anyone but the owner destination are denied outright.
    const other = env.broker.propose({ kind: 'call_owner_alert', accountId: 'telephony-alerts', destination: ['+14165550100'], payload: { incidentId: 'inc-4', trigger: 'business_opportunity', attempt: 1 } }, 'openclaw');
    assert.ok(other.ok && other.value.status === 'denied');
    // Unknown incident / trigger mismatch → denied.
    const fake = env.broker.propose({ kind: 'call_owner_alert', accountId: 'telephony-alerts', destination: ['owner'], payload: { incidentId: 'nope', trigger: 'test', attempt: 1 } }, 'openclaw');
    assert.ok(fake.ok && fake.value.status === 'denied');
  } finally {
    env.close();
  }
});

test('lost provider response after the call was placed: reconcile finds it, no extra call', async () => {
  const { env, service, provider } = setup();
  try {
    provider().mode = 'accept_then_throw';
    service.raise({ incidentId: 'inc-5', trigger: 'test' });
    const ev = await service.tick();
    assert.equal(ev[0]!.event, 'call_uncertain');
    const actionId = (ev[0] as { actionId: string }).actionId;
    const rec = await env.broker.reconcile(actionId);
    assert.ok(rec.ok && rec.value.status === 'sent', JSON.stringify(rec));
    assert.equal(provider().placed.length, 1);
    // Provider definitively refusing still consumes the attempt (no runaway retries/cost).
    provider().mode = 'reject';
    env.clock.advanceSeconds(300);
    assert.equal((await service.tick())[0]!.event, 'call_failed');
    env.clock.advanceSeconds(300);
    provider().mode = 'ok';
    assert.equal((await service.tick())[0]!.event, 'called');
    env.clock.advanceSeconds(300);
    assert.equal((await service.tick())[0]!.event, 'exhausted');
    assert.equal(provider().placed.length, 2);
  } finally {
    env.close();
  }
});

test('webhook: invalid signature, wrong account, replay and stale callbacks change nothing', async () => {
  const { env, service, provider, handler, store } = setup();
  try {
    service.raise({ incidentId: 'inc-6', trigger: 'test' });
    await service.tick();
    const bad = await handler(callback(provider(), 0, 'gather', { Digits: '1' }, { token: 'wrong-token' }));
    assert.equal(bad.status, 403);
    const wrongAcct = await handler(callback(provider(), 0, 'gather', { Digits: '1' }, { accountSid: `AC${'b'.repeat(32)}` }));
    assert.equal(wrongAcct.status, 403);
    assert.equal(store.incident('inc-6')!.status, 'active');
    // Signed for another URL (path swap) is rejected.
    const swapped = callback(provider(), 0, 'gather', { Digits: '1' });
    const sr = await handler({ ...swapped, url: swapped.url.replace(GATHER_PATH, STATUS_PATH) });
    assert.equal(sr.status, 403);

    const st = callback(provider(), 0, 'status', { CallStatus: 'ringing', SequenceNumber: '1', Timestamp: new Date(env.clock.nowMs()).toUTCString() });
    assert.equal((await handler(st)).status, 200);
    assert.equal((await handler(st)).status, 200);
    const evs = env.db.prepare('SELECT outcome FROM telephony_webhook_events ORDER BY received_at, rowid').all() as { outcome: string }[];
    assert.deepEqual(evs.map((e) => e.outcome).filter((o) => o === 'applied' || o === 'duplicate'), ['applied', 'duplicate']);
    const stale = callback(provider(), 0, 'status', { CallStatus: 'completed', SequenceNumber: '9', Timestamp: new Date(env.clock.nowMs() - 3600_000).toUTCString() });
    await handler(stale);
    assert.equal(store.calls('inc-6')[0]!.status, 'ringing', 'stale callback ignored');

    // Ack once; replaying the ack later (e.g. for another incident attempt) does nothing new.
    const ack = callback(provider(), 0, 'gather', { Digits: '1' });
    assert.match((await handler(ack)).body, /acknowledged/);
    assert.match((await handler(ack)).body, /acknowledged/);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM telephony_webhook_events WHERE outcome = 'duplicate'").get()!.n, 2);
  } finally {
    env.close();
  }
});

test('callback server exposes only the two telephony paths', async () => {
  const { env, handler } = setup();
  const srv = await startTelephonyWebhookServer({ handler, port: 0 });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    for (const p of ['/', '/gateway', '/telephony', '/telephony/twilio/other', '/api/status', '/telephony/twilio/status/../../admin']) {
      const r = await fetch(`${base}${p}`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(r.status, 404, p);
    }
    assert.equal((await fetch(`${base}${STATUS_PATH}`)).status, 405);
    const unsigned = await fetch(`${base}${STATUS_PATH}?c=x`, { method: 'POST', body: 'CallSid=CA1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(unsigned.status, 403);
    const big = await fetch(`${base}${GATHER_PATH}`, { method: 'POST', body: 'a='.padEnd(20_000, 'x'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(big.status, 413);
    assert.equal(srv.server.address() && typeof srv.server.address() === 'object' ? (srv.server.address() as { address: string }).address : '', '127.0.0.1');
  } finally {
    await srv.close();
    env.close();
  }
});

test('usage tracking reports provider count, duration and price without caps', async () => {
  const { env, service, provider, store } = setup();
  try {
    service.raise({ incidentId: 'inc-7', trigger: 'test' });
    await service.tick();
    env.clock.advanceSeconds(300);
    await service.tick();
    provider().prices.set(provider().placed[0]!.sid, { price: '-0.0140', unit: 'USD', duration: 34 });
    provider().prices.set(provider().placed[1]!.sid, { price: '-0.0140', unit: 'USD', duration: 12 });
    assert.equal(await refreshCallUsage(store, provider(), '2026-10-01T00:00:00.000Z'), 2);
    const u = store.usage('2026-10-01T00:00:00.000Z');
    assert.equal(u.calls, 2);
    assert.equal(u.totalDurationSeconds, 46);
    assert.deepEqual(u.spendByUnit, { USD: 0.028 });
    assert.equal(u.unpriced, 0);
  } finally {
    env.close();
  }
});

test('Twilio adapter: form-encoded Calls API request with TwiML, callbacks and AMD; 4xx is a definitive rejection', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let status = 201;
  const p = createTwilioProvider({
    accountSid: ACCOUNT_SID, credentials: async () => ({ username: ACCOUNT_SID, password: AUTH_TOKEN }),
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(status === 201 ? { sid: `CA${'c'.repeat(32)}`, status: 'queued' } : { code: 21215, message: 'Geo permission' }), { status });
    },
  });
  const r = await p.placeCall({ to: OWNER_NUMBER, from: '+15550000000', idempotencyKey: 'potts-act_1', machineDetection: true, ringTimeoutSeconds: 25, script: { say: 'Hello & bye', gatherUrl: `${PUBLIC}${GATHER_PATH}?c=1`, statusUrl: `${PUBLIC}${STATUS_PATH}?c=1` } }, new AbortController().signal);
  assert.equal(r.providerCallId, `CA${'c'.repeat(32)}`);
  const req = requests[0]!;
  assert.equal(req.url, `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
  const form = new URLSearchParams(String(req.init.body));
  assert.equal(form.get('To'), OWNER_NUMBER);
  assert.equal(form.get('MachineDetection'), 'Enable');
  assert.deepEqual(form.getAll('StatusCallbackEvent'), ['initiated', 'ringing', 'answered', 'completed']);
  assert.match(form.get('Twiml')!, /<Say voice="Polly.Matthew">Hello &amp; bye<\/Say>/);
  assert.match(String((req.init.headers as Record<string, string>).authorization), /^Basic /);
  status = 400;
  await assert.rejects(p.placeCall({ to: OWNER_NUMBER, from: '+15550000000', idempotencyKey: 'k', machineDetection: false, ringTimeoutSeconds: 25, script: { say: 's', gatherUrl: 'https://x', statusUrl: 'https://y' } }, new AbortController().signal), { name: 'ExecutorRejectedError' });
});

test('third-party calls: proposal needs recipient + purpose, always needs approval, and has no executor', async () => {
  const { env } = setup();
  try {
    assert.equal(buildThirdPartyCallProposal({ accountId: 'telephony-alerts', recipient: '416-555-0100', recipientName: 'Dentist', purpose: 'Reschedule my cleaning appointment', instructionRef: 'tg:1' }).ok, false);
    assert.equal(buildThirdPartyCallProposal({ accountId: 'telephony-alerts', recipient: '+14165550100', recipientName: 'Dentist', purpose: 'call', instructionRef: 'tg:1' }).ok, false);
    const b = buildThirdPartyCallProposal({ accountId: 'telephony-alerts', recipient: '+14165550100', recipientName: 'Dentist', purpose: 'Reschedule my cleaning appointment to next week', instructionRef: 'tg:1' });
    assert.ok(b.ok);
    const p = env.broker.propose(b.value, 'openclaw');
    assert.ok(p.ok && p.value.status === 'awaiting_approval');
    assert.ok(env.approve(p.value.actionId).ok);
    const r = await env.broker.execute(p.value.actionId);
    assert.equal(!r.ok && r.error.code, 'no_executor');
  } finally {
    env.close();
  }
});

test('telephony is disabled by default and its config schema is mirrored in potts.schema.json', () => {
  const reg = createExecutorRegistry();
  assert.equal(registerOwnerAlertCalls(reg, null, {} as never), null);
  assert.equal(registerOwnerAlertCalls(reg, { enabled: false } as never, {} as never), null);
  assert.equal(reg.list().length, 0);
  const root = JSON.parse(readFileSync(new URL('../../config/potts.schema.json', import.meta.url), 'utf8')) as { properties: Record<string, unknown> };
  assert.deepEqual(root.properties.telephony, TELEPHONY_CONFIG_SCHEMA);
  const accounts = createAccountRegistry(TEST_ACCOUNTS);
  const good = { enabled: false, provider: 'twilio', accountId: 'telephony-alerts', publicBaseUrl: 'https://potts-calls.example.ts.net', webhook: { host: '127.0.0.1', port: 8790 }, machineDetection: true, ringTimeoutSeconds: 25, twilio: { accountSidRef: 'keychain:potts/twilio-account-sid', authTokenRef: 'keychain:potts/twilio-auth-token' } };
  assert.ok(validateTelephonyConfig(good, accounts, root as never).ok);
  assert.equal(validateTelephonyConfig({ ...good, twilio: { accountSidRef: 'AC123', authTokenRef: 'raw-token' } }, accounts, root as never).ok, false, 'raw secrets refused');
  assert.equal(validateTelephonyConfig({ ...good, publicBaseUrl: 'http://insecure.example' }, accounts, root as never).ok, false, 'https only');
  assert.equal(validateTelephonyConfig({ ...good, webhook: { host: '0.0.0.0', port: 8790 } }, accounts, root as never).ok, false, 'loopback bind only');
  assert.equal(validateTelephonyConfig({ ...good, accountId: 'gmail-personal' }, accounts, root as never).ok, false, 'must be a telephony account');
});

// Silence unused-type lint in some editors.
export type _T = OwnerAlertService | TelephonyStore;
