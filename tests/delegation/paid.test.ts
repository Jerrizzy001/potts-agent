import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHarness } from '../../src/broker/testing.ts';
import {
  createClaudeCodeAdapter, createDelegationGovernor, createDelegationService, createExternalAdapter, createLocalTestRunner, createPaidEscalationGuard,
} from '../../src/delegation/index.ts';
import { createFixture, taskInput, type Fixture } from './helpers.ts';

type H = ReturnType<typeof createTestHarness>;

function setup(h: H, fx: Fixture, paidConfig = {}) {
  const runner = createLocalTestRunner({ workspaceRoot: fx.workspaceRoot });
  const governor = createDelegationGovernor({ db: h.db, clock: h.clock });
  const claude = createClaudeCodeAdapter({ runner, config: { allowUnisolatedRunner: true, timeoutSeconds: 60 } });
  const paidGuard = createPaidEscalationGuard({
    broker: h.broker, config: paidConfig,
    existingPurchase: (id) => governor.get(id)?.purchaseActionId ?? null, recordPurchase: (id, a) => governor.setPurchaseAction(id, a),
  });
  const service = createDelegationService({ db: h.db, clock: h.clock, broker: h.broker, governor, projects: fx.registry, runner, paidGuard, claude, external: createExternalAdapter(), evidenceRoot: fx.evidenceRoot });
  return { runner, governor, service };
}

test('separately billed escalation produces a purchase proposal, not an action', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const h = createTestHarness();
  try {
    const { governor, service, runner } = setup(h, fx, { billing: { claude_code: 'separately_billed' } });
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'awaiting_owner', r.ok ? r.value.kind : r.error.message);
    if (!r.ok || r.value.kind !== 'awaiting_owner') return;
    assert.ok(r.value.purchaseActionId);
    const a = h.broker.getAction(r.value.purchaseActionId)!;
    assert.equal(a.kind, 'purchase');
    assert.equal(a.status, 'awaiting_approval');
    assert.deepEqual(a.destination, ['anthropic:extra-usage']);
    assert.ok(h.broker.approvals.live(a.id), 'owner approval requested');
    // No worker ran and nothing executed.
    assert.equal(existsSync(join(runner.baseEnv.TMPDIR!, 'fake-claude-brief.txt')), false);
    assert.equal(h.miscExec.calls, 0);
    assert.equal(governor.get(t.value.taskId)!.status, 'awaiting_owner');
    assert.equal(governor.runs(t.value.taskId).length, 0);
    // Executing the purchase without approval is refused by the broker.
    const ex = await h.broker.execute(a.id);
    assert.equal(!ex.ok && ex.error.code, 'approval_missing');
    assert.equal(h.miscExec.calls, 0);
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('exhausted subscription allowance stops the task and proposes a purchase once; no API-key fallback', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'limit' });
  const h = createTestHarness();
  try {
    const { governor, service, runner } = setup(h, fx);
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'awaiting_owner', r.ok ? r.value.kind : r.error.message);
    if (!r.ok || r.value.kind !== 'awaiting_owner') return;
    assert.match(r.value.reason, /allowance is exhausted/);
    const pid = r.value.purchaseActionId!;
    assert.equal(h.broker.getAction(pid)!.kind, 'purchase');
    const task = governor.get(t.value.taskId)!;
    assert.equal(task.status, 'awaiting_owner');
    assert.equal(task.purchaseActionId, pid);
    assert.equal(governor.runs(t.value.taskId)[0]!.status, 'allowance_exhausted');
    // The worker ran exactly once, with no billing switch in its environment.
    const env = JSON.parse(readFileSync(join(runner.baseEnv.TMPDIR!, 'fake-claude-env.json'), 'utf8')) as string[];
    assert.ok(!env.includes('ANTHROPIC_API_KEY') && !env.includes('ANTHROPIC_AUTH_TOKEN'));
    // The task cannot simply be re-run (awaiting the owner), and no second purchase is proposed.
    const again = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.equal(again.ok, false);
    assert.equal(h.broker.list({ status: 'awaiting_approval' }).filter((x) => x.kind === 'purchase').length, 1);
    assert.equal(h.miscExec.calls, 0);
  } finally {
    h.close();
    fx.cleanup();
  }
});

test("'wait' mode never proposes a purchase", async () => {
  const fx = await createFixture({ fakeClaudeMode: 'limit' });
  const h = createTestHarness();
  try {
    const { governor, service } = setup(h, fx, { onAllowanceExhausted: 'wait' });
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'awaiting_owner' && r.value.purchaseActionId === null);
    assert.equal(h.broker.list().filter((x) => x.kind === 'purchase').length, 0);
  } finally {
    h.close();
    fx.cleanup();
  }
});
