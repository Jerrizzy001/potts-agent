import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHarness } from '../../src/broker/testing.ts';
import {
  assertWorkerEnvSafe, claudeArgs, createClaudeCodeAdapter, createDelegationGovernor, createDelegationService, createExternalAdapter, createLocalTestRunner,
  createPaidEscalationGuard, createWorkingCopy, gitOk, porcelainStatus, WorkerEnvError,
} from '../../src/delegation/index.ts';
import { createFixture, g, taskInput, withProject, type Fixture } from './helpers.ts';

type H = ReturnType<typeof createTestHarness>;

function setup(h: H, fx: Fixture, registry = fx.registry, paidConfig = {}) {
  const runner = createLocalTestRunner({ workspaceRoot: fx.workspaceRoot });
  const governor = createDelegationGovernor({ db: h.db, clock: h.clock });
  const claude = createClaudeCodeAdapter({ runner, config: { allowUnisolatedRunner: true, timeoutSeconds: 60 } });
  const paidGuard = createPaidEscalationGuard({
    broker: h.broker, config: paidConfig,
    existingPurchase: (id) => governor.get(id)?.purchaseActionId ?? null, recordPurchase: (id, a) => governor.setPurchaseAction(id, a),
  });
  const service = createDelegationService({ db: h.db, clock: h.clock, broker: h.broker, governor, projects: registry, runner, paidGuard, claude, external: createExternalAdapter(), evidenceRoot: fx.evidenceRoot });
  return { runner, governor, claude, paidGuard, service };
}

test('working copy: fresh clone, no remotes, no output/ or .env, owner checkout untouched', async () => {
  const fx = await createFixture();
  try {
    const runner = createLocalTestRunner({ workspaceRoot: fx.workspaceRoot });
    const before = await porcelainStatus(fx.owner);
    const wc = await createWorkingCopy({ project: fx.project, taskId: 'tsk_TEST1', runner });
    assert.equal(wc.baseSha, fx.mainSha);
    assert.equal(await gitOk(['remote'], { cwd: wc.dir }), '');
    assert.equal(existsSync(join(wc.dir, 'output')), false);
    assert.equal(existsSync(join(wc.dir, '.env')), false);
    assert.equal(existsSync(join(wc.dir, '.env.example')), true);
    assert.equal(existsSync(join(wc.dir, 'math.mjs')), true);
    // Separate object store: not a worktree, no alternates pointing at the owner's .git.
    assert.equal(existsSync(join(wc.dir, '.git', 'objects', 'info', 'alternates')), false);
    assert.equal(readFileSync(join(wc.dir, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/potts/tsk_TEST1');
    assert.ok(wc.ownerCheckout.dirtyEntries >= 2, 'owner has untracked output/ and .env');
    // Owner checkout unchanged, its untracked work preserved.
    assert.equal(await porcelainStatus(fx.owner), before);
    assert.equal(readFileSync(join(fx.owner, 'output', 'private-report.txt'), 'utf8'), 'owner private output');
    assert.equal((await g(['remote'], fx.owner)), 'origin');
    // A repository that TRACKS a credential-like file is refused.
    writeFileSync(join(fx.owner, 'id_rsa'), 'not really a key');
    await g(['add', 'id_rsa'], fx.owner);
    await g(['commit', '--quiet', '-m', 'oops'], fx.owner);
    await assert.rejects(createWorkingCopy({ project: fx.project, taskId: 'tsk_TEST2', runner }), /credential-like/);
    assert.equal(existsSync(join(fx.workspaceRoot, 'tsk_TEST2', 'work')), false);
  } finally {
    fx.cleanup();
  }
});

test('fake Claude returns a patch and claims tests passed; independent run disagrees and the report flags it', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'break' });
  const h = createTestHarness();
  try {
    const { governor, service, runner } = setup(h, fx);
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(r.value.kind, 'evidence');
    if (r.value.kind !== 'evidence') return;
    const { report, ownerReport, worker } = r.value;
    assert.equal(worker.status, 'completed');
    assert.equal(worker.claim.testsPassed, true);
    assert.equal(report.worker.claimedTestsPassed, true);
    assert.equal(report.allTestsPassed, false);
    assert.equal(report.worker.claimVerified, false);
    assert.ok(report.risks.some((x) => x.code === 'claim_mismatch' && x.level === 'blocker'));
    assert.ok(report.risks.some((x) => x.code === 'tests_failed'));
    assert.deepEqual(report.filesChanged.map((f) => f.path), ['math.mjs']);
    assert.equal(report.diffstat.files, 1);
    assert.ok(report.candidateSha && report.candidateSha !== fx.mainSha);
    assert.match(ownerReport, /NOT READY/);
    assert.match(ownerReport, /CONTRADICTED/);
    assert.match(ownerReport, /FAIL test node test\.mjs/);
    // Attempt failed → task re-queued for a bounded retry, working copy preserved.
    const task = governor.get(t.value.taskId)!;
    assert.equal(task.status, 'queued');
    assert.ok(task.workingCopy && existsSync(task.workingCopy));
    // The worker received exactly the brief and no credentials/billing switches.
    const tmp = runner.baseEnv.TMPDIR!;
    const envKeys = JSON.parse(readFileSync(join(tmp, 'fake-claude-env.json'), 'utf8')) as string[];
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'POTTS_TEST_DEPLOY_TOKEN', 'DEPLOY_TOKEN', 'SSH_AUTH_SOCK', 'GH_TOKEN']) assert.ok(!envKeys.includes(k), k);
    assert.equal(readFileSync(join(tmp, 'fake-claude-brief.txt'), 'utf8'), r.value.brief.text);
    const args = JSON.parse(readFileSync(join(tmp, 'fake-claude-args.json'), 'utf8')) as string[];
    for (const a of ['-p', '--restricted', 'dontAsk', 'json', '--strict-mcp-config', 'Bash(node test.mjs)', 'Bash(git push:*)', 'WebFetch']) assert.ok(args.includes(a), a);
    assert.ok(!args.includes('--bare') && !args.includes('--dangerously-skip-permissions'));
    // Owner checkout untouched by the whole run.
    assert.equal(readFileSync(join(fx.owner, 'math.mjs'), 'utf8'), 'export function add(a, b) {\n  return a + b;\n}\n');
    // Evidence persisted.
    assert.equal(service.latestEvidence(t.value.taskId)?.reportHash, report.reportHash);
    // Bounded retry continues in the SAME preserved working copy; after the last attempt the task fails, work kept.
    const r2 = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r2.ok && r2.value.kind === 'evidence');
    const after = governor.get(t.value.taskId)!;
    assert.equal(after.workingCopy, task.workingCopy);
    assert.equal(after.attempts, 2);
    assert.equal(after.status, 'failed');
    assert.ok(existsSync(join(after.workingCopy!, 'math.mjs')));
    const r3 = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.equal(r3.ok, false, 'no third attempt');
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('a correct patch passes independent checks; extension-touching changes require release checks', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'extension' });
  const h = createTestHarness();
  try {
    const { governor, service } = setup(h, fx);
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'evidence', r.ok ? r.value.kind : r.error.message);
    if (!r.ok || r.value.kind !== 'evidence') return;
    const rep = r.value.report;
    assert.equal(rep.allTestsPassed, true);
    assert.equal(rep.worker.claimVerified, true);
    assert.deepEqual(rep.releaseChecks, [{ id: 'extension', required: true, passed: true, runbook: 'docs/ext.md' }]);
    assert.ok(rep.risks.some((x) => x.code === 'release_check:extension'));
    assert.ok(rep.commands.some((c) => c.group === 'release_check:extension' && c.passed));
    assert.equal(governor.get(t.value.taskId)!.status, 'succeeded');
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('Claude Code adapter refuses a runner without an OS boundary unless explicitly allowed; env guard', async () => {
  const fx = await createFixture();
  try {
    const runner = createLocalTestRunner({ workspaceRoot: fx.workspaceRoot });
    assert.throws(() => createClaudeCodeAdapter({ runner }), /OS user boundary/);
    for (const bad of [{ ANTHROPIC_API_KEY: 'x' } as Record<string, string>, { GH_TOKEN: 'x' }, { MY_SECRET: 'x' }, { SSH_AUTH_SOCK: '/tmp/a' }, { HARMLESS: 'Bearer abcdefghijklmnopqrstuvwxyz' }])
      assert.throws(() => assertWorkerEnvSafe(bad), WorkerEnvError);
    assert.doesNotThrow(() => assertWorkerEnvSafe({ CLAUDE_CODE_OAUTH_TOKEN: 'sub' }, ['CLAUDE_CODE_OAUTH_TOKEN']));
    await assert.rejects(runner.run({ argv: ['node', '-e', '1'], cwd: fx.workspaceRoot, env: { CLOUDFLARE_API_TOKEN: 'x' }, network: { mode: 'none' }, timeoutMs: 5000, secretEnvNames: ['CLOUDFLARE_API_TOKEN'] }), WorkerEnvError);
    await assert.rejects(runner.run({ argv: ['node', '-e', '1'], cwd: fx.owner, env: {}, network: { mode: 'none' }, timeoutMs: 5000 }), /outside the worker workspace/);
    const timed = await runner.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: fx.workspaceRoot, env: {}, network: { mode: 'none' }, timeoutMs: 300 });
    assert.equal(timed.timedOut, true);
    // Read-only task: no edit tools, no test commands.
    const spec = { kind: 'investigation' as const, projectId: 'demo', parentId: null, objective: 'x', inputs: [], permittedActions: ['read_repo' as const], deadline: '2026-10-07T00:00:00.000Z', expectedEvidence: ['x'], stopConditions: [] };
    const args = claudeArgs(spec, fx.project, { command: 'claude', timeoutSeconds: 60, networkAllowlist: [], acceptedAuthMethods: [] });
    const tools = args[args.indexOf('--tools') + 1]!;
    assert.ok(!tools.includes('Edit') && !tools.includes('Write'));
    assert.ok(!args.includes('Bash(node test.mjs)'));
  } finally {
    fx.cleanup();
  }
});

test('auth check: API-key auth is refused (would be separately billed)', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const h = createTestHarness();
  try {
    const reg = withProject(fx, { worker: { ...fx.project.worker, env: { ...fx.project.worker.env, FAKE_CLAUDE_LOGIN_METHOD: 'api_key' } } });
    const { governor, service } = setup(h, fx, reg);
    const t = governor.createTask(taskInput());
    assert.ok(t.ok);
    const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === "blocked", JSON.stringify(r.ok ? { kind: r.value.kind, reason: (r.value as { reason?: string }).reason } : r.error.message));
    assert.ok(r.ok && r.value.kind === 'blocked' && /not an accepted subscription method/.test(r.value.reason));
  } finally {
    h.close();
    fx.cleanup();
  }
});
