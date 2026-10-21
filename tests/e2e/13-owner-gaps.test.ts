/**
 * WP-9 evidence on the fully wired daemon (fake clock, fake Keychain, fake
 * Twilio REST API, in-memory OAuth tokens):
 *  - owner test call: verified owner ingress (/potts testcall) → one `test`
 *    owner-alert call through the Twilio adapter; quiet hours and
 *    telephony.enabled are respected; no retries;
 *  - /revoke purges the account's synced mail, cursors and sourced memory with a receipt;
 *  - policy hot reload: a valid edit invalidates outstanding approvals and re-requests them;
 *    an invalid or insecure file is rejected, the old policy stays, the owner is alerted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeClock } from '../../src/core/clock.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { createOwnerHandlers } from '../../integrations/openclaw/potts-broker-plugin/lib/owner.ts';
import { createReplayCache, type CommandContextLike } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import { accountMemorySourceId } from '../../src/connectors/oauth/purge.ts';
import { createFakeNet, gmailAccount, INGRESS_KEY, makeHome, markConnected, OWNER_ID, routeGmail, routeSite, sendPayload, startWorld, tokenSetFor, type FakeNet } from './_harness.ts';

const TWILIO_SID = 'AC' + 'a'.repeat(32);
const cmd = (args = ''): CommandContextLike => ({ channel: 'telegram', senderId: OWNER_ID, isAuthorizedSender: true, commandBody: `/potts ${args}`.trim(), args, from: `telegram:${OWNER_ID}`, to: `telegram:${OWNER_ID}` });

function routeTwilio(net: FakeNet) {
  const calls: URLSearchParams[] = [];
  net.route('https://api.twilio.com', (u, init) => {
    if (!String(new Headers(init?.headers).get('authorization') ?? '').startsWith('Basic ')) return new Response('{}', { status: 401 });
    if (u.pathname === `/2010-04-01/Accounts/${TWILIO_SID}/Calls.json` && init?.method === 'POST') {
      calls.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ sid: 'CA' + String(calls.length).padStart(32, '0'), status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === `/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`) return new Response(JSON.stringify({ calls: [], next_page_uri: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
  return calls;
}

const telephonyHome = (enabled: boolean) =>
  makeHome({
    accounts: [{ id: 'telephony-alerts', kind: 'telephony', address: '+15550000001', mode: 'approval_required', purpose: 'owner_alert' }],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      (c.owner as Record<string, unknown>).alertPhoneRef = 'keychain:potts/owner-alert-phone';
      c.integrations = { pauseAll: false, paused: {} };
      (c.telephony as Record<string, unknown>).enabled = enabled;
    },
  });

const twilioKeychain = { 'potts/twilio-account-sid': TWILIO_SID, 'potts/twilio-auth-token': 'fake-twilio-token-0000', 'potts/owner-alert-phone': '+15550000999' };

test('owner test call: one `test` call via Twilio, no retries; refused during quiet hours', async () => {
  const home = telephonyHome(true);
  const net = createFakeNet();
  const calls = routeTwilio(net);
  const clock = createFakeClock('2026-10-07T18:00:00Z'); // 14:00 Toronto
  const w = await startWorld({ home, start: clock.nowIso(), clock, net, keychain: twilioKeychain });
  try {
    assert.ok(w.d.runtime().executors.some((e) => e.startsWith('owner-alert-call:twilio')), JSON.stringify(w.d.runtime().problems));
    const r = w.owner({ type: 'test_call' });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(r.value.type, 'test_call');
    const incidentId = (r.value as { incidentId: string }).incidentId;
    assert.match(incidentId, /^test:/);
    await w.advance(60_000, 15_000);
    assert.equal(calls.length, 1, 'exactly one call');
    assert.equal(calls[0]!.get('To'), '+15550000999');
    assert.equal(calls[0]!.get('From'), '+15550000001');
    assert.match(calls[0]!.get('Twiml') ?? '', /test/i);
    assert.match(calls[0]!.get('StatusCallback') ?? '', /^https:\/\/.+\/telephony\/twilio\/status\?c=/);
    // Not answered with 1: a test call never retries.
    await w.advance(20 * 60_000, 60_000);
    assert.equal(calls.length, 1, 'no retries for a test call');
    assert.notEqual(w.d.telephonyStore.incident(incidentId)?.status, 'active');
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'owner_test_call' && e.data.incidentId === incidentId));

    // 23:30 Toronto: refused, nothing queued, nothing rings at 08:00.
    await w.until('2026-10-08T03:30:00Z', 10 * 60_000);
    const q = w.owner({ type: 'test_call' });
    assert.equal(q.ok, false);
    assert.equal(!q.ok && q.error.code, 'held');
    assert.match(!q.ok ? q.error.message : '', /quiet hours/);
    await w.until('2026-10-08T12:30:00Z', 10 * 60_000);
    assert.equal(calls.length, 1, 'no call from a refused request');
  } finally {
    await w.close();
  }
});

test('/potts testcall through the plugin and ingress socket: disabled telephony answers clearly and places nothing', async () => {
  const home = telephonyHome(false);
  const net = createFakeNet();
  const calls = routeTwilio(net);
  const w = await startWorld({ home, start: '2026-10-07T18:00:00Z', net, keychain: twilioKeychain });
  try {
    await w.d.start({ timers: false });
    const parsed = parsePluginConfig({ pottsHome: home, ownerTelegramId: OWNER_ID });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const owner = createOwnerHandlers({ cfg: parsed.value, secrets: { get: async () => ({ ownerId: OWNER_ID, key: Buffer.from(INGRESS_KEY, 'utf8') }) }, now: () => new Date(w.clock.nowMs()), replay: createReplayCache(), log: () => {} });
    const help = await owner.handleCommand('potts', cmd('help'));
    assert.match(help.text, /\/potts testcall/);
    const r = await owner.handleCommand('potts', cmd('testcall'));
    assert.match(r.text, /Not done: .*disabled/);
    await w.advance(2 * 60_000);
    assert.equal(calls.length, 0);
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'ingress_rejected' && e.data.intent === 'test_call'));
    // A non-owner sender never reaches the daemon.
    const other = await owner.handleCommand('potts', { ...cmd('testcall'), senderId: '999' });
    assert.equal(other.text, 'This command is not available here.');
  } finally {
    await w.close();
  }
});

test('/revoke purges the account\'s synced mail, cursors and sourced memory, with a receipt', async () => {
  const start = '2026-10-07T14:00:00Z';
  const home = makeHome({ accounts: [gmailAccount('read_only')], potts: (c) => ((c.monitoring as Record<string, unknown>).enabled = false) });
  const net = createFakeNet();
  routeSite(net);
  const gmail = routeGmail(net);
  gmail.addInbox('m1', { from: 'friend@example.com', subject: 'Dinner Friday', text: 'Dinner at 7 on Friday?' });
  gmail.addInbox('m2', { from: 'school@example.com', subject: 'Course update', text: 'Room change' });
  const w = await startWorld({ home, start, net, keychain: { 'potts/google-oauth-client-secret': 'fake-secret' }, tokens: { 'gmail-personal': tokenSetFor('google', start) } });
  try {
    markConnected(w, 'gmail-personal', 'google');
    await w.advance(10 * 60_000);
    const n = () => (w.d.db.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE account_id = 'gmail-personal'").get() as { n: number }).n;
    assert.equal(n(), 2, 'synced before revoke');
    const mem = w.d.memory!;
    assert.ok(mem.registerSource({ id: accountMemorySourceId('gmail-personal'), kind: 'gmail' }).ok);
    assert.ok(mem.remember({ text: 'Dinner with a friend on Friday', sourceId: accountMemorySourceId('gmail-personal'), status: 'inferred', confidence: 0.5 }).ok);

    const r = w.owner({ type: 'revoke_account', accountId: 'gmail-personal', reason: 'test' });
    assert.ok(r.ok);
    assert.equal(n(), 0);
    assert.equal(w.d.db.prepare("SELECT 1 FROM mail_sync_state WHERE account_id = 'gmail-personal'").get(), undefined);
    assert.equal(mem.search('Dinner').length, 0);
    const receipts = w.d.purgeReceipts();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.counts.mailItems, 2);
    assert.equal(receipts[0]!.memory?.facts, 1);
    assert.match(receipts[0]!.actor, /^owner:telegram:/);
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'account_purge' && e.data.receiptId === receipts[0]!.id));
    // Revoked accounts are not re-synced.
    await w.advance(10 * 60_000);
    assert.equal(n(), 0);
    await w.d.outbox.dispatchDue();
    assert.ok(w.channel.sent.some((m) => m.type === 'text' && /Account gmail-personal revoked\. Deleted 2 mail item/.test(m.text)));
  } finally {
    await w.close();
  }
});

test('policy hot reload: valid change invalidates and re-requests approvals; invalid or insecure file keeps the old policy and alerts', async () => {
  const start = '2026-10-07T14:00:00Z';
  const home = makeHome({ accounts: [gmailAccount('approval_required')], potts: (c) => ((c.monitoring as Record<string, unknown>).enabled = false) });
  const net = createFakeNet();
  routeGmail(net);
  const w = await startWorld({
    home, start, net, keychain: { 'potts/google-oauth-client-secret': 'fake-secret' },
    tokens: { 'gmail-personal': tokenSetFor('google', start), 'gmail-personal.send': tokenSetFor('google', start, { scope: 'openid email https://www.googleapis.com/auth/gmail.send', accessTokenExpiresAt: '2026-10-09T00:00:00Z' }) },
  });
  try {
    markConnected(w, 'gmail-personal', 'google');
    const a = w.d.broker.propose(sendPayload('bob@example.com', 'Hi'), 'openclaw/potts');
    assert.ok(a.ok);
    if (!a.ok) return;
    const first = w.d.broker.approvals.live(a.value.actionId)!;
    const oldHash = w.d.policy().hash;
    assert.equal(first.binding.policyHash, oldHash);

    // Valid edit (owner shortens approval expiry): picked up by the file watch within one tick.
    const path = join(home, 'policy.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...doc, approvalTtlSeconds: 3600 }, null, 2), { mode: 0o600 });
    await w.advance(30_000, 15_000);
    assert.notEqual(w.d.policy().hash, oldHash);
    assert.equal(w.d.broker.approvals.get(first.id)?.status, 'invalidated');
    const second = w.d.broker.approvals.live(a.value.actionId);
    assert.ok(second && second.status === 'pending' && second.binding.policyHash === w.d.policy().hash, 'a fresh approval under the new policy');
    // The invalidated approval can no longer be used.
    assert.equal(w.owner({ type: 'approve', approvalId: first.id, bindingHash: first.bindingHash }).ok, false);
    const reload = w.d.audit.list({ limit: 1000 }).filter((e) => e.type === 'policy_reload');
    assert.equal(reload.at(-1)?.data.outcome, 'reloaded');
    assert.equal(reload.at(-1)?.data.invalidated, 1);
    const newHash = w.d.policy().hash;

    // Invalid JSON via SIGHUP: rejected, policy unchanged, approvals untouched, owner alerted.
    writeFileSync(path, '{ not json', { mode: 0o600 });
    const bad = w.d.reloadPolicy('sighup');
    assert.equal(bad.outcome, 'rejected');
    assert.equal(w.d.policy().hash, newHash);
    assert.equal(w.d.broker.approvals.live(a.value.actionId)?.id, second.id);
    // Schema-invalid and insecure files are rejected too.
    writeFileSync(path, JSON.stringify({ ...doc, approvalTtlSeconds: 5 }), { mode: 0o600 });
    assert.equal(w.d.reloadPolicy('sighup').outcome, 'rejected');
    writeFileSync(path, JSON.stringify({ ...doc, approvalTtlSeconds: 7200 }));
    chmodSync(path, 0o666);
    const insecure = w.d.reloadPolicy('sighup');
    assert.equal(insecure.outcome, 'rejected');
    assert.match(insecure.outcome === 'rejected' ? insecure.reason : '', /writable/);
    assert.equal(w.d.policy().hash, newHash);
    await w.d.outbox.dispatchDue();
    assert.ok(w.channel.sent.some((m) => m.type === 'text' && /did not load the edited policy\.json/.test(m.text)));
    assert.ok(w.channel.sent.some((m) => m.type === 'text' && /loaded the edited policy/.test(m.text)));
    assert.ok(w.d.audit.list({ limit: 1000 }).filter((e) => e.type === 'policy_reload' && e.data.outcome === 'rejected').length >= 3);
    // The owner can approve the re-requested approval under the new policy.
    chmodSync(path, 0o600);
    assert.ok(w.approve(a.value.actionId).ok);
  } finally {
    await w.close();
  }
});
