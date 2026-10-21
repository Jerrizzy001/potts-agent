/**
 * Evidence: "Claude supplies a patch and says tests passed" → independent
 * evidence review and exact-change approval before release.
 *
 * The daemon is wired with the WP-6 fixture project (local bare "origin",
 * fake `claude` CLI). The fake worker always claims tests passed; Potts re-runs
 * the registered tests itself. Releases go through the daemon's own dispatch
 * job only after the owner approves the exact commit and destination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTestRunner } from '../../src/delegation/runner.ts';
import { remoteBranchHead } from '../../src/delegation/git.ts';
import { createFixture, taskInput, type Fixture } from '../delegation/helpers.ts';
import { createFakeNet, makeHome, startWorld, type World } from './_harness.ts';

async function world(fx: Fixture): Promise<World> {
  const project = { ...fx.project, release: { ...fx.project.release!, enabled: true } };
  const home = makeHome({
    projects: { schemaVersion: 1, projects: [project] },
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      ((c.delegation as Record<string, unknown>).claudeCode as Record<string, unknown>).enabled = true;
      delete ((c.delegation as Record<string, unknown>).claudeCode as Record<string, unknown>).oauthTokenRef;
    },
  });
  const net = createFakeNet();
  net.route('https://demo.example/api/health', () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  return startWorld({
    home, start: '2026-10-07T15:00:00Z', net, env: { POTTS_TEST_DEPLOY_TOKEN: 'tok-e2e-deploy' },
    daemon: { isolatedRunner: createLocalTestRunner({ workspaceRoot: fx.workspaceRoot }), allowUnisolatedRunner: true },
  });
}

test('E2E-10a worker claims "tests passed" but broke the code → Potts re-runs tests, reports failure, refuses to propose a release', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'break' });
  const w = await world(fx);
  try {
    assert.ok(w.d.delegation && w.d.delegationGovernor, JSON.stringify(w.d.runtime().problems));
    const t = w.d.delegationGovernor!.createTask(taskInput());
    assert.ok(t.ok);
    const r = await w.d.delegation!.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'evidence', r.ok ? r.value.kind : r.error.message);
    if (!r.ok || r.value.kind !== 'evidence') return;
    assert.equal(r.value.worker.claim?.testsPassed, true, 'the worker claimed success');
    assert.equal(r.value.report.allTestsPassed, false, 'independent re-run shows the tests fail');
    assert.match(r.value.ownerReport, /fail/i);
    const pr = await w.d.releaseManager!.proposeRemotePush({ report: r.value.report, branch: 'main' });
    assert.equal(pr.ok, false, 'no release proposal from failing evidence');
    assert.equal(await remoteBranchHead(fx.origin, 'main'), fx.mainSha);
    assert.equal(w.d.broker.list().filter((a) => a.kind === 'deploy' || a.kind === 'merge').length, 0);
  } finally {
    await w.close();
    fx.cleanup();
  }
});

test('E2E-10b verified fix → exact-change deploy proposal → nothing until the owner approves that commit → daemon releases it once', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const w = await world(fx);
  try {
    const t = w.d.delegationGovernor!.createTask(taskInput());
    assert.ok(t.ok);
    const r = await w.d.delegation!.runAttempt(t.value.taskId, { contextTokens: 50_000 });
    assert.ok(r.ok && r.value.kind === 'evidence');
    if (!r.ok || r.value.kind !== 'evidence') return;
    assert.equal(r.value.report.allTestsPassed, true);
    const pr = await w.d.releaseManager!.proposeRemotePush({ report: r.value.report, branch: 'main' });
    assert.ok(pr.ok, pr.ok ? '' : pr.error.message);
    if (!pr.ok) return;
    assert.equal(pr.value.kind, 'deploy', 'push to main triggers the deploying workflow');
    assert.equal(pr.value.status, 'awaiting_approval');
    // A code-fix request is not deployment approval: the daemon dispatches nothing.
    await w.advance(2 * 60_000, 15_000);
    assert.equal(await remoteBranchHead(fx.origin, 'main'), fx.mainSha);
    assert.ok(w.channel.sent.some((m) => m.type === 'approval' && m.approvalId === pr.value.approvalId), 'owner shown the exact change for approval');
    // The approval binds the exact commit SHA: the preview the owner sees names it.
    const preview = w.d.owner!.preview(pr.value.approvalId!)!;
    assert.ok(JSON.stringify(preview.payload).includes(r.value.report.candidateSha!));
    assert.ok(w.approve(pr.value.actionId).ok);
    await w.advance(60_000, 15_000);
    assert.equal(w.d.broker.getAction(pr.value.actionId)!.status, 'succeeded');
    assert.equal(await remoteBranchHead(fx.origin, 'main'), r.value.report.candidateSha);
    // Replaying does nothing more.
    await w.advance(5 * 60_000, 60_000);
    assert.equal(w.d.broker.dispatches(pr.value.actionId).length, 1);
  } finally {
    await w.close();
    fx.cleanup();
  }
});

test('E2E code-fix proposal reaches isolated worker via daemon and exposes evidence without releasing', async () => {
  const fx = await createFixture({ fakeClaudeMode: 'fix' });
  const w = await world(fx);
  try {
    const id = fx.project.id;
    const input = { kind: 'prepare_fix', scope: {taskId:`project:${id}`,projectId:id}, payload:{projectId:id,problem:'Fix the addition function and verify its registered tests.'} };
    const bad = w.d.broker.propose({...input,scope:{taskId:'made-up',projectId:id}},'openclaw/potts');
    assert.ok(bad.ok && bad.value.status==='held');
    const action = w.d.broker.propose(input,'openclaw/potts');
    assert.ok(action.ok && action.value.status==='ready',JSON.stringify(action)); if(!action.ok)return;
    await w.advance(30000);
    assert.equal(w.d.broker.status(action.value.actionId)!.status,'succeeded');
    const row = w.d.db.prepare('SELECT task_id,result_json FROM delegation_broker_jobs WHERE action_id=?').get(action.value.actionId) as {task_id:string;result_json:string};
    assert.equal(JSON.parse(row.result_json).testsPassed,true);
    assert.equal(JSON.parse(row.result_json).blockers,false);
    assert.equal(await remoteBranchHead(fx.origin,'main'),fx.mainSha);
    await w.advance(30000);
    assert.equal(w.d.delegationGovernor!.runs(row.task_id).length,1);
  } finally {await w.close();fx.cleanup();}
});
