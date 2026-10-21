import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from '../../src/broker/testing.ts';
import { createDelegationGovernor } from '../../src/delegation/index.ts';
import { taskInput } from './helpers.ts';

type H = ReturnType<typeof createTestHarness>;
const gov = (h: H, limits = {}) => createDelegationGovernor({ db: h.db, clock: h.clock, limits });
const mk = (g: ReturnType<typeof gov>, o: Record<string, unknown> = {}) => {
  const r = g.createTask(taskInput(o));
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
};
const limitOf = (r: { ok: boolean; error?: { details?: Record<string, unknown> } }) => (r.ok ? null : r.error?.details?.limit);

test('max depth: children beyond the limit are refused', () => {
  const h = createTestHarness();
  try {
    const g = gov(h, { maxDepth: 2 });
    const root = mk(g, { objective: 'root objective' });
    const c1 = mk(g, { parentId: root.taskId, objective: 'child one' });
    const c2 = mk(g, { parentId: c1.taskId, objective: 'child two' });
    assert.equal(c2.depth, 2);
    assert.equal(c2.rootId, root.taskId);
    const c3 = g.createTask(taskInput({ parentId: c2.taskId, objective: 'child three' }));
    assert.equal(limitOf(c3), 'max_depth');
  } finally {
    h.close();
  }
});

test('cycle detection: an objective repeating any ancestor is refused (normalized)', () => {
  const h = createTestHarness();
  try {
    const g = gov(h, { maxDepth: 5 });
    const a = mk(g, { objective: 'Fix the login page' });
    const b = mk(g, { parentId: a.taskId, objective: 'Investigate session cookie' });
    const loop = g.createTask(taskInput({ parentId: b.taskId, objective: '  fix THE   login page ' }));
    assert.equal(limitOf(loop), 'cycle');
    // Same objective in a different project scope is not the same task, but scope cannot be widened.
    const widen = g.createTask(taskInput({ parentId: b.taskId, objective: 'other', projectId: 'other-project' }));
    assert.equal(widen.ok, false);
  } finally {
    h.close();
  }
});

test('per-root task and attempt budgets', () => {
  const h = createTestHarness();
  try {
    const g = gov(h, { maxDepth: 5, maxTasksPerRoot: 3, maxAttemptsPerRoot: 2, maxConcurrentWorkers: 5, maxConcurrentPerProject: 5 });
    const root = mk(g, { objective: 'r' });
    const a = mk(g, { parentId: root.taskId, objective: 'a' });
    mk(g, { parentId: root.taskId, objective: 'b' });
    assert.equal(limitOf(g.createTask(taskInput({ parentId: a.taskId, objective: 'c' }))), 'root_task_budget');
    const r1 = g.startAttempt(root.taskId, 'claude_code');
    assert.ok(r1.ok);
    g.finishAttempt(r1.ok ? r1.value.id : '', 'succeeded', null);
    const r2 = g.startAttempt(a.taskId, 'claude_code');
    assert.ok(r2.ok);
    g.finishAttempt(r2.ok ? r2.value.id : '', 'failed', null);
    assert.equal(limitOf(g.startAttempt(a.taskId, 'claude_code')), 'root_attempt_budget');
    assert.equal(g.get(a.taskId)!.status, 'failed');
  } finally {
    h.close();
  }
});

test('concurrency cap: global and per project; over-cap tasks stay queued', () => {
  const h = createTestHarness();
  try {
    const g = gov(h, { maxConcurrentWorkers: 2, maxConcurrentPerProject: 1 });
    const t1 = mk(g, { objective: 't1' });
    const t2 = mk(g, { objective: 't2' });
    const t3 = mk(g, { kind: 'text', projectId: null, permittedActions: ['draft_text'], objective: 't3', inputs: [] });
    const t4 = mk(g, { kind: 'text', projectId: null, permittedActions: ['draft_text'], objective: 't4', inputs: [] });
    assert.ok(g.startAttempt(t1.taskId, 'claude_code').ok);
    const blockedSameProject = g.startAttempt(t2.taskId, 'claude_code');
    assert.equal(limitOf(blockedSameProject), 'concurrency');
    assert.equal(!blockedSameProject.ok && blockedSameProject.error.code, 'held');
    assert.equal(g.get(t2.taskId)!.status, 'queued');
    assert.ok(g.startAttempt(t3.taskId, 'local_qwen').ok);
    assert.equal(limitOf(g.startAttempt(t4.taskId, 'local_qwen')), 'concurrency');
    assert.equal(g.runningCount(), 2);
  } finally {
    h.close();
  }
});

test('bounded retries, preserved failure, deadline and crash recovery', () => {
  const h = createTestHarness();
  try {
    const g = gov(h, { maxAttemptsPerTask: 2 });
    const t = mk(g);
    const a1 = g.startAttempt(t.taskId, 'claude_code');
    assert.ok(a1.ok);
    assert.equal(g.finishAttempt(a1.ok ? a1.value.id : '', 'failed', { why: 'tests' }).ok && g.get(t.taskId)!.status, 'queued');
    const a2 = g.startAttempt(t.taskId, 'claude_code');
    assert.ok(a2.ok);
    g.finishAttempt(a2.ok ? a2.value.id : '', 'failed', null);
    assert.equal(g.get(t.taskId)!.status, 'failed');
    assert.match(g.get(t.taskId)!.statusReason ?? '', /no retries left/);
    assert.equal(limitOf(g.startAttempt(t.taskId, 'claude_code')), 'task_state');

    const late = mk(g, { objective: 'late', deadline: new Date(h.clock.nowMs() + 60_000).toISOString() });
    h.clock.advanceSeconds(120);
    assert.equal(limitOf(g.startAttempt(late.taskId, 'claude_code')), 'deadline_passed');

    const crash = mk(g, { objective: 'crash', deadline: new Date(h.clock.nowMs() + 3_600_000).toISOString() });
    assert.ok(g.startAttempt(crash.taskId, 'claude_code').ok);
    assert.deepEqual(g.recover(), [crash.taskId]);
    assert.equal(g.get(crash.taskId)!.status, 'queued');
    assert.equal(g.runs(crash.taskId)[0]!.status, 'abandoned');
  } finally {
    h.close();
  }
});

test('task validation rejects secrets, owner-state paths and unknown fields', () => {
  const h = createTestHarness();
  try {
    const g = gov(h);
    const bad = [
      taskInput({ inputs: [{ type: 'file', path: '.env' }] }),
      taskInput({ inputs: [{ type: 'file', path: 'output/private-report.txt' }] }),
      taskInput({ inputs: [{ type: 'file', path: '../other/repo.txt' }] }),
      taskInput({ inputs: [{ type: 'file', path: '/Users/someone/.ssh/id_rsa' }] }),
      taskInput({ inputs: [{ type: 'snippet', label: 'log', text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' }] }),
      taskInput({ inputs: [{ type: 'snippet', label: 'cfg', text: 'password = hunter2hunter2' }] }),
      taskInput({ approved: true }),
      taskInput({ permittedActions: ['deploy'] }),
    ];
    for (const b of bad) assert.equal(g.createTask(b).ok, false, JSON.stringify(b.inputs ?? b));
    assert.equal(g.createTask(taskInput({ inputs: [{ type: 'file', path: '.env.example' }] })).ok, true);
  } finally {
    h.close();
  }
});
