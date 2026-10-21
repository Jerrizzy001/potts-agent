import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock } from '../../src/core/clock.ts';
import { createAccountRegistry } from '../../src/core/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { migrate } from '../../src/store/migrate.ts';
import { buildPolicy, DEFAULT_POLICY } from '../../src/policy/document.ts';
import { createIngressVerifier, signOwnerIngress, type OwnerIntent } from '../../src/approvals/ingress.ts';
import { createExecutorRegistry, ExecutorRejectedError, type Executor } from '../../src/broker/executor.ts';
import { createBroker } from '../../src/broker/broker.ts';
import { createOwnerControls } from '../../src/broker/owner.ts';
import { createTestHarness, TEST_ACCOUNTS, TEST_OWNER_ID } from '../../src/broker/testing.ts';
import { randomBytes } from 'node:crypto';

function setup(execute: Executor['execute']) {
  const dir = mkdtempSync(join(tmpdir(), 'potts-exh-'));
  const clock = createFakeClock('2026-10-06T14:00:00.000Z');
  const db = openDatabase(join(dir, 'p.db'));
  migrate(db, { clock });
  const reg = createExecutorRegistry();
  let calls = 0;
  reg.register({
    name: 'weird', integration: 'mail', kinds: ['send_message'],
    execute: (i, s) => { calls++; return execute(i, s); },
    lookup: async () => ({ status: 'not_found' as const }),
  });
  const pol = buildPolicy(DEFAULT_POLICY);
  if (!pol.ok) throw pol.error;
  const accounts = createAccountRegistry(TEST_ACCOUNTS);
  const broker = createBroker({ db, clock, accounts, executors: reg, policy: () => pol.value });
  const key = randomBytes(32);
  const owner = createOwnerControls(broker, createIngressVerifier({ key, ownerSenderId: TEST_OWNER_ID, clock }), accounts);
  let n = 1;
  const sign = (intent: OwnerIntent) => signOwnerIngress(key, { source: 'telegram', senderId: TEST_OWNER_ID, chatId: TEST_OWNER_ID, chatType: 'private', updateId: String(++n), receivedAt: clock.nowIso(), intent });
  const approved = () => {
    const p = broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { body: 'hi' } }, 'openclaw');
    assert.ok(p.ok);
    const live = broker.approvals.live(p.value.actionId)!;
    assert.ok(owner.handle(sign({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash })).ok);
    return p.value.actionId;
  };
  return { broker, approved, calls: () => calls, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('executor that throws synchronously → uncertain, never stuck dispatching', async () => {
  const s = setup(() => { throw new Error('sync boom'); });
  try {
    const id = s.approved();
    const r = await s.broker.execute(id);
    assert.ok(r.ok);
    assert.equal(r.value.status, 'uncertain');
    assert.equal(s.broker.getAction(id)!.status, 'uncertain');
    assert.equal(s.broker.dispatches(id)[0]!.state, 'uncertain');
    // No retry without reconciliation.
    const again = await s.broker.execute(id);
    assert.equal(!again.ok && again.error.code, 'uncertain_requires_reconcile');
    assert.equal(s.calls(), 1);
  } finally { s.close(); }
});

test('executor that synchronously throws ExecutorRejectedError → definitive failure, approval released', async () => {
  const s = setup(() => { throw new ExecutorRejectedError('nope'); });
  try {
    const id = s.approved();
    const r = await s.broker.execute(id);
    assert.ok(r.ok);
    assert.equal(r.value.status, 'failed');
    assert.equal(s.broker.dispatches(id)[0]!.state, 'failed');
  } finally { s.close(); }
});

test('executor returning a non-promise / receipt without provider id → uncertain', async () => {
  const s1 = setup((() => ({ providerOperationId: 'op-1' })) as unknown as Executor['execute']);
  try {
    const id = s1.approved();
    const r = await s1.broker.execute(id);
    assert.ok(r.ok);
    assert.equal(r.value.status, 'succeeded', 'a plain (non-promise) valid receipt is accepted');
  } finally { s1.close(); }
  const s2 = setup((() => undefined) as unknown as Executor['execute']);
  try {
    const id = s2.approved();
    const r = await s2.broker.execute(id);
    assert.ok(r.ok);
    assert.equal(r.value.status, 'uncertain');
    assert.equal(s2.broker.getAction(id)!.status, 'uncertain');
  } finally { s2.close(); }
});

test('system cancelAction only cancels undispatched actions; audited as system', async () => {
  const h = createTestHarness();
  try {
    const p = h.broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { body: 'x' } }, 'openclaw');
    assert.ok(p.ok);
    const c = h.broker.cancelAction(p.value.actionId, 'stale', 'release');
    assert.ok(c.ok);
    assert.equal(h.broker.getAction(p.value.actionId)!.status, 'cancelled');
    assert.equal(h.broker.approvals.get(p.value.approvalId!)!.status, 'invalidated');
    const entry = h.broker.audit.list({ actionId: p.value.actionId }).find((e) => e.type === 'action_cancelled');
    assert.equal(entry?.actor, 'system:release');
    // Cannot cancel a succeeded action.
    const q = h.broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { body: 'y' } }, 'openclaw');
    assert.ok(q.ok);
    h.approve(q.value.actionId);
    assert.ok((await h.broker.execute(q.value.actionId)).ok);
    const c2 = h.broker.cancelAction(q.value.actionId, 'late', 'release');
    assert.equal(!c2.ok && c2.error.code, 'action_state');
  } finally { h.close(); }
});

test('revokeAccountFromSystem blocks dispatch and invalidates approvals; only the owner reinstates', async () => {
  const h = createTestHarness();
  try {
    const p = h.broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { body: 'x' } }, 'openclaw');
    assert.ok(p.ok);
    h.approve(p.value.actionId);
    h.broker.revokeAccountFromSystem('gmail-personal', 'provider invalid_grant', 'oauth');
    const r = await h.broker.execute(p.value.actionId);
    assert.equal(!r.ok && r.error.code, 'revoked');
    assert.equal(h.broker.approvals.get(p.value.approvalId!)!.status, 'invalidated');
    assert.deepEqual(h.broker.controls().revokedAccounts, ['gmail-personal']);
    assert.equal(h.broker.controls().runtime[0]!.setBy, 'system:oauth');
    assert.equal(h.provider.accepted.length, 0);
  } finally { h.close(); }
});

test('broker internals (_setControl/_cancelAction/_proposeDirect) are only used by src/broker', () => {
  const root = join(import.meta.dirname, '../../src');
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.includes(`${join('src', 'broker')}`) && /\b_(setControl|cancelAction|proposeDirect)\b/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
