import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestHarness } from '../../src/broker/testing.ts';
import { createExecutorRegistry } from '../../src/broker/index.ts';
import {
  createClaudeCodeAdapter, createDelegationGovernor, createDelegationService, createExternalAdapter, createLocalTestRunner, createPaidEscalationGuard,
  remoteBranchHead, type EvidenceReport,
} from '../../src/delegation/index.ts';
import { classifyRemoteOperation, createReleaseExecutor, createReleaseManager } from '../../src/release/index.ts';
import { createFixture, okFetch, taskInput, withProject, type Fixture } from './helpers.ts';
import type { ProjectRegistry } from '../../src/delegation/index.ts';

const TOKEN = 'tok-test-release-123';

function setup(fx: Fixture, o: { enabled?: boolean; registry?: ProjectRegistry; fetch?: typeof fetch } = {}) {
  const exec = createReleaseExecutor({
    enabled: o.enabled ?? true, projects: o.registry ?? fx.registry, workRoot: fx.releaseRoot, secretResolver: { env: { POTTS_TEST_DEPLOY_TOKEN: TOKEN } }, fetch: o.fetch ?? okFetch,
  });
  const registry = createExecutorRegistry();
  registry.register(exec);
  const h = createTestHarness({ brokerOptions: { executors: registry } });
  const manager = createReleaseManager({ db: h.db, broker: h.broker, projects: o.registry ?? fx.registry, clock: h.clock });
  return { h, exec, manager };
}

async function evidenceFor(fx: Fixture, h: ReturnType<typeof createTestHarness>): Promise<EvidenceReport> {
  const runner = createLocalTestRunner({ workspaceRoot: fx.workspaceRoot });
  const governor = createDelegationGovernor({ db: h.db, clock: h.clock });
  const claude = createClaudeCodeAdapter({ runner, config: { allowUnisolatedRunner: true, timeoutSeconds: 60 } });
  const paidGuard = createPaidEscalationGuard({ broker: h.broker });
  const service = createDelegationService({ db: h.db, clock: h.clock, broker: h.broker, governor, projects: fx.registry, runner, paidGuard, claude, external: createExternalAdapter(), evidenceRoot: fx.evidenceRoot });
  const t = governor.createTask(taskInput({ inputs: [{ type: 'file', path: 'math.mjs' }, { type: 'snippet', label: 'monitor', text: 'GET /api/health -> 500 (simulated fault)' }] }));
  assert.ok(t.ok);
  const r = await service.runAttempt(t.value.taskId, { contextTokens: 50_000 });
  assert.ok(r.ok && r.value.kind === 'evidence', r.ok ? r.value.kind : r.error.message);
  if (!r.ok || r.value.kind !== 'evidence') throw new Error('no evidence');
  assert.equal(r.value.report.allTestsPassed, true);
  return r.value.report;
}

const deployedSha = (fx: Fixture) => (existsSync(join(fx.stateDir, 'deployed.json')) ? (JSON.parse(readFileSync(join(fx.stateDir, 'deployed.json'), 'utf8')) as { sha: string }).sha : null);

test('CI guard: pushes/PRs that can trigger deployment are deploys', async () => {
  const fx = await createFixture();
  try {
    const p = fx.project;
    assert.equal(classifyRemoteOperation(p, { type: 'push', branch: 'main' }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'push', branch: 'potts/fix' }).kind, 'merge');
    assert.equal(classifyRemoteOperation(p, { type: 'push', branch: 'potts/fix', changedFiles: ['.github/workflows/release.yml'] }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'pull_request', head: 'potts/fix', base: 'main', changedFiles: ['math.mjs'] }).kind, 'merge');
    assert.equal(classifyRemoteOperation(p, { type: 'workflow_dispatch', workflowFile: '.github/workflows/release.yml' }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'workflow_dispatch', workflowFile: '.github/workflows/unknown.yml' }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'delete_branch', branch: 'main' }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'publish_package' }).kind, 'deploy');
    assert.equal(classifyRemoteOperation(p, { type: 'tag', tag: 'v1' }).kind, 'merge');
    const noCi = { ...p, ci: undefined as unknown as typeof p.ci };
    assert.equal(classifyRemoteOperation(noCi, { type: 'push', branch: 'feature' }).kind, 'deploy');
  } finally {
    fx.cleanup();
  }
});

test('end to end: fault → isolated fix → evidence → push-to-main is a deploy needing approval → approved push → approved deploy → verified', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const { h, exec, manager } = setup(fx);
  try {
    const report = await evidenceFor(fx, h);
    // Push to main triggers the deploying workflow → deploy kind, approval required.
    const pr = await manager.proposeRemotePush({ report, branch: 'main' });
    assert.ok(pr.ok, pr.ok ? '' : pr.error.message);
    if (!pr.ok) return;
    assert.equal(pr.value.kind, 'deploy');
    assert.equal(pr.value.status, 'awaiting_approval');
    assert.ok(pr.value.classification!.reasons.some((r) => /Release/.test(r)));
    const unapproved = await manager.execute(pr.value.actionId);
    assert.equal(!unapproved.ok && unapproved.error.code, 'approval_missing');
    assert.equal(await remoteBranchHead(fx.origin, 'main'), fx.mainSha, 'nothing pushed without approval');
    // Owner approves the exact commit + destination.
    assert.ok(h.approve(pr.value.actionId).ok);
    const pushed = await manager.execute(pr.value.actionId);
    assert.ok(pushed.ok && pushed.value.status === 'succeeded', JSON.stringify(pushed));
    assert.equal(await remoteBranchHead(fx.origin, 'main'), report.candidateSha);
    // Deploy of the exact SHA to the registered target.
    const dp = await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: report.candidateSha!, report });
    assert.ok(dp.ok, dp.ok ? '' : dp.error.message);
    if (!dp.ok) return;
    assert.equal(dp.value.status, 'awaiting_approval');
    assert.equal(deployedSha(fx), null);
    assert.ok(h.approve(dp.value.actionId).ok);
    const dep = await manager.execute(dp.value.actionId);
    assert.ok(dep.ok && dep.value.status === 'succeeded', JSON.stringify(dep));
    assert.equal(deployedSha(fx), report.candidateSha);
    const v = exec.lastVerification(dp.value.actionId)!;
    assert.equal(v.ok, true);
    assert.equal(v.identity[0]!.ok, true);
    // The credential was resolved inside the executor only: never stored in the DB/audit.
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()) + JSON.stringify(h.db.prepare('SELECT * FROM dispatches').all()) + JSON.stringify(h.db.prepare('SELECT * FROM actions').all());
    assert.ok(!dump.includes(TOKEN));
    assert.equal(JSON.parse(readFileSync(join(fx.stateDir, 'deployed.json'), 'utf8')).tokenSeen, true);
    // Same approval cannot be replayed.
    const again = await h.broker.execute(dp.value.actionId);
    assert.ok(again.ok && again.value.status === 'succeeded' && again.value.alreadyDone);
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('feature-branch push is a merge (still approval-bound) and fast-forward only', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const { h, manager } = setup(fx);
  try {
    const report = await evidenceFor(fx, h);
    const pr = await manager.proposeRemotePush({ report, branch: 'potts/fix-add' });
    assert.ok(pr.ok && pr.value.kind === 'merge' && pr.value.status === 'awaiting_approval');
    if (!pr.ok) return;
    assert.ok(h.approve(pr.value.actionId).ok);
    const r = await manager.execute(pr.value.actionId);
    assert.ok(r.ok && r.value.status === 'succeeded');
    assert.equal(await remoteBranchHead(fx.origin, 'potts/fix-add'), report.candidateSha);
    // Failing evidence is never proposed.
    const failing = { ...report, risks: [...report.risks, { level: 'blocker' as const, code: 'tests_failed', message: 'x' }] };
    const refused = await manager.proposeRemotePush({ report: failing, branch: 'potts/other' });
    assert.equal(!refused.ok && refused.error.code, 'held');
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('release approval is invalidated by a new commit on the source branch', async () => {
  const fx = await createFixture();
  const { h, manager } = setup(fx);
  try {
    const dp = await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, allowWithoutEvidence: true });
    assert.ok(dp.ok, dp.ok ? '' : dp.error.message);
    if (!dp.ok) return;
    assert.ok(h.approve(dp.value.actionId).ok);
    const approvalId = h.broker.approvals.live(dp.value.actionId)!.id;
    await fx.advanceMain('math.mjs', 'export const add = (a, b) => a + b;\n');
    const r = await manager.execute(dp.value.actionId);
    assert.equal(!r.ok && r.error.code, 'approval_mismatch');
    assert.deepEqual(!r.ok && r.error.details?.changed, ['commit']);
    assert.equal(h.broker.getAction(dp.value.actionId)!.status, 'cancelled');
    assert.equal(h.broker.approvals.get(approvalId)!.status, 'invalidated');
    assert.equal(deployedSha(fx), null);
    const rows = h.db.prepare('SELECT result, changed_json FROM release_rechecks WHERE action_id = ?').all(dp.value.actionId) as { result: string; changed_json: string }[];
    assert.deepEqual(rows.map((x) => x.result), ['stale']);
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('release approval is invalidated by a changed deployment target', async () => {
  const fx = await createFixture();
  const { h, manager } = setup(fx);
  try {
    const dp = await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, allowWithoutEvidence: true });
    assert.ok(dp.ok);
    if (!dp.ok) return;
    assert.ok(h.approve(dp.value.actionId).ok);
    const moved = withProject(fx, { deploymentTargets: [{ ...fx.project.deploymentTargets![0]!, url: 'https://other.example' }] });
    const m2 = createReleaseManager({ db: h.db, broker: h.broker, projects: moved, clock: h.clock });
    const r = await m2.execute(dp.value.actionId);
    assert.equal(!r.ok && r.error.code, 'approval_mismatch');
    assert.deepEqual(!r.ok && r.error.details?.changed, ['target']);
    assert.equal(h.broker.getAction(dp.value.actionId)!.status, 'cancelled');
    assert.equal(deployedSha(fx), null);
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('executor rechecks itself: bypassing the manager with a moved branch or changed target deploys nothing', async () => {
  const fx = await createFixture();
  const moved = withProject(fx, { deploymentTargets: [{ ...fx.project.deploymentTargets![0]!, liveChecks: [] }] });
  const s1 = setup(fx);
  const s2 = setup(fx, { registry: moved });
  try {
    const a = await s1.manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, allowWithoutEvidence: true });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.ok(s1.h.approve(a.value.actionId).ok);
    await fx.advanceMain('README.md', 'new\n');
    const r = await s1.h.broker.execute(a.value.actionId);
    assert.ok(r.ok && r.value.status === 'failed' && /not the approved/.test(r.value.reason), JSON.stringify(r));
    assert.equal(deployedSha(fx), null);

    const head = (await remoteBranchHead(fx.origin, 'main'))!;
    // Proposed under the old registry, executed by an executor holding a changed target.
    const m1 = createReleaseManager({ db: s2.h.db, broker: s2.h.broker, projects: fx.registry, clock: s2.h.clock });
    const b = await m1.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: head, allowWithoutEvidence: true });
    assert.ok(b.ok);
    if (!b.ok) return;
    assert.ok(s2.h.approve(b.value.actionId).ok);
    const r2 = await s2.h.broker.execute(b.value.actionId);
    assert.ok(r2.ok && r2.value.status === 'failed' && /target changed/.test(r2.value.reason), JSON.stringify(r2));
    assert.equal(deployedSha(fx), null);
  } finally {
    s1.h.close();
    s2.h.close();
    fx.cleanup();
  }
});

test('executor is registered disabled by default and a failing pre-release step deploys nothing', async () => {
  const fx = await createFixture();
  const off = setup(fx, { enabled: false });
  try {
    assert.equal(createReleaseExecutor({ projects: fx.registry, workRoot: fx.releaseRoot }).enabled, false);
    const a = await off.manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, allowWithoutEvidence: true });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.ok(off.h.approve(a.value.actionId).ok);
    const r = await off.manager.execute(a.value.actionId);
    assert.ok(r.ok && r.value.status === 'failed' && /disabled/.test(r.value.reason));
    assert.equal(deployedSha(fx), null);
  } finally {
    off.h.close();
  }
  const failing = withProject(fx, { release: { ...fx.project.release!, env: { ...fx.project.release!.env, FAIL_PRE: '1' } } });
  const s = setup(fx, { registry: failing });
  try {
    const a = await s.manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, allowWithoutEvidence: true });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.ok(s.h.approve(a.value.actionId).ok);
    const r = await s.manager.execute(a.value.actionId);
    assert.ok(r.ok && r.value.status === 'failed' && /nothing was deployed/.test(r.value.reason), JSON.stringify(r));
    assert.equal(deployedSha(fx), null);
  } finally {
    s.h.close();
    fx.cleanup();
  }
});

test('deploy proposals need evidence for the exact commit and passing required release checks', async () => {
  const fx = await createFixture();
  const { h, manager } = setup(fx);
  try {
    assert.equal((await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha })).ok, false);
    const fake = {
      candidateSha: fx.mainSha, risks: [], taskId: 't', reportHash: 'h',
      releaseChecks: [{ id: 'extension', required: true, passed: null, runbook: null }],
    } as unknown as EvidenceReport;
    const r = await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: fx.mainSha, report: fake });
    assert.equal(!r.ok && r.error.code, 'held');
    assert.match(!r.ok ? r.error.message : '', /extension/);
    const wrong = await manager.proposeDeploy({ projectId: 'demo', targetId: 'production', commitSha: 'a'.repeat(40), allowWithoutEvidence: true });
    assert.equal(!wrong.ok && wrong.error.code, 'held', 'only the current head of the source branch can be deployed');
  } finally {
    h.close();
    fx.cleanup();
  }
});

test('typed release review tests exact commit before approval; execution requires approval and per-project enablement', async () => {
  const { createReleaseRequests } = await import('../../src/release/requests.ts');
  const fx = await createFixture();
  const {h,manager}=setup(fx);
  try {
    const reviews=createReleaseRequests({root:join(fx.root,'reviews'),projects:fx.registry,manager,paused:()=>false});
    const bad=reviews.request({projectId:'demo',operation:'deploy',commit:'HEAD',targetId:'production'});assert.equal(bad.ok,false);
    const r=reviews.request({projectId:'demo',operation:'deploy',commit:fx.mainSha,targetId:'production'});assert.ok(r.ok);
    const id=r.value.reviewId!;
    let j: any;
    for(let i=0;i<100;i++){const s=reviews.status({reviewId:id});assert.ok(s.ok);j=s.value;if(j.state!=='preparing')break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal(j.state,'awaiting_approval',j.error);assert.equal(j.report.allTestsPassed,true);assert.equal(deployedSha(fx),null);
    const before=await manager.execute(j.actionId);assert.ok(!before.ok || before.value.status!=='succeeded');assert.equal(deployedSha(fx),null);
    assert.ok(h.approve(j.actionId).ok);const executed=await manager.execute(j.actionId);assert.ok(executed.ok&&executed.value.status==='succeeded');assert.equal(deployedSha(fx),fx.mainSha);
    const disabled=withProject(fx,{release:{...fx.project.release!,enabled:false}});
    const x=createReleaseRequests({root:join(fx.root,'disabled-reviews'),projects:disabled,manager,paused:()=>false});
    assert.equal(x.request({projectId:'demo',operation:'deploy',commit:fx.mainSha,targetId:'production'}).ok,false);
  } finally {h.close();fx.cleanup();}
});

test('release preparation never requests approval when independent checks fail or controls are paused', async () => {
  const { createReleaseRequests } = await import('../../src/release/requests.ts');
  const fx=await createFixture();const {h,manager}=setup(fx);
  try {
    const failing=withProject(fx,{testCommands:[{id:'fail',argv:[process.execPath,'-e','process.exit(1)']}]});
    const reviews=createReleaseRequests({root:join(fx.root,'bad-reviews'),projects:failing,manager,paused:()=>false});
    const r=reviews.request({projectId:'demo',operation:'deploy',commit:fx.mainSha,targetId:'production'});assert.ok(r.ok);
    let state='preparing';
    for(let i=0;i<100&&state==='preparing';i++){await new Promise(resolve=>setTimeout(resolve,50));const s=reviews.status({reviewId:r.value.reviewId});assert.ok(s.ok && 'state' in s.value);state=s.value.state;}
    assert.equal(state,'failed');assert.equal(h.broker.list({}).length,0);
    const paused=createReleaseRequests({root:join(fx.root,'paused-reviews'),projects:fx.registry,manager,paused:()=>true});
    assert.equal(paused.request({projectId:'demo',operation:'deploy',commit:fx.mainSha,targetId:'production'}).ok,false);
  }finally{h.close();fx.cleanup();}
});

test('an enabled release executor refuses an individually disabled project after owner approval', async () => {
  const fx=await createFixture();const disabled=withProject(fx,{release:{...fx.project.release!,enabled:false}});
  const {h,manager}=setup(fx,{registry:disabled});
  try {
    const r=await manager.proposeDeploy({projectId:'demo',targetId:'production',commitSha:fx.mainSha,allowWithoutEvidence:true});assert.ok(r.ok);assert.ok(h.approve(r.value.actionId).ok);
    const out=await manager.execute(r.value.actionId);assert.ok(!out.ok||out.value.status!=='succeeded');assert.equal(deployedSha(fx),null);
  }finally{h.close();fx.cleanup();}
});
