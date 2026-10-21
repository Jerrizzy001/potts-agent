import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '../../src/broker/testing.ts';
import {
  buildHandoffBrief, createDelegationGovernor, createExternalAdapter, createProjectRegistry, loadProjectsFile, MANDATORY_STOP_CONDITIONS, routeTask,
  validateProjectsDocument, createQwenAdapter,
} from '../../src/delegation/index.ts';
import { classifyRemoteOperation } from '../../src/release/index.ts';
import { taskInput } from './helpers.ts';

const projectDocument = () => ({ schemaVersion: 1 as const, projects: [{
  id: 'example-app', displayName: 'Example App', urls: ['https://example.com'], repoPath: '/path/to/example-project',
  remoteUrl: 'https://github.com/example/example-project.git', defaultBranch: 'main',
  setupCommands: [{ id: 'setup', argv: ['npm', 'ci'] }], testCommands: [{ id: 'typecheck', argv: ['npm', 'run', 'type-check'] }],
  release: { enabled: false, commands: [], credentialEnv: { GH_TOKEN: 'env:GH_TOKEN' } },
  ci: { provider: 'github_actions' as const, workflows: [{ file: '.github/workflows/ci.yml', deploys: true, triggers: [{ event: 'push' as const, branches: ['main'] }] }] },
  worker: { envAllowlist: [] },
}] });
const project = () => createProjectRegistry(projectDocument());

test('brief contains only the selected inputs plus mandatory stop conditions', () => {
  const h = createTestHarness();
  try {
    const reg = project();
    const p = reg.get('example-app')!;
    const g = createDelegationGovernor({ db: h.db, clock: h.clock });
    const t = g.createTask(taskInput({
      projectId: 'example-app',
      inputs: [
        { type: 'file', path: 'src/app/api/health/route.ts', note: 'liveness route' },
        { type: 'snippet', label: 'Monitor evidence', text: 'GET /api/health -> 503 at 2026-10-06T14:00Z (SELECTED-SNIPPET-MARKER)' },
      ],
    }));
    assert.ok(t.ok, t.ok ? '' : t.error.message);
    const b = buildHandoffBrief(t.value.taskId, t.value.spec, p);
    assert.match(b.text, /src\/app\/api\/health\/route\.ts/);
    assert.match(b.text, /SELECTED-SNIPPET-MARKER/);
    for (const s of MANDATORY_STOP_CONDITIONS) assert.ok(b.text.includes(s));
    for (const h2 of ['## Task objective', '## Relevant source material', '## Permitted scope and actions', '## Expected result and validation', '## Stop conditions']) assert.ok(b.text.includes(h2), h2);
    // Nothing that was not selected: no owner repo path, no other repo files, no remote URL, no other commands.
    assert.ok(!b.text.includes(p.repoPath));
    assert.ok(!b.text.includes(p.remoteUrl));
    assert.ok(!b.text.includes('README.md'));
    assert.ok(!b.text.includes('deploy:production'));
    assert.ok(!b.text.includes('npm ci'));
    assert.match(b.text, /npm run type-check/);
    assert.deepEqual(b.json.inputs.map((i) => i.type), ['file', 'snippet']);
    // Without run_registered_tests, no commands at all.
    const t2 = g.createTask(taskInput({ projectId: 'example-app', objective: 'read only', permittedActions: ['read_repo'] }));
    assert.ok(t2.ok);
    assert.deepEqual(buildHandoffBrief(t2.value.taskId, t2.value.spec, p).json.allowedCommands, []);
  } finally {
    h.close();
  }
});

test('routing: routine → Qwen; substantial/large/failed-local → Claude Code; no Claude → External manual', () => {
  const code = { kind: 'code_change' as const, projectId: 'example-app' };
  const all = { claudeCode: true, externalManual: true };
  assert.equal(routeTask(code, { contextTokens: 2000, estimatedFilesChanged: 1, estimatedLinesChanged: 10 }, all).target, 'local_qwen');
  assert.equal(routeTask(code, { contextTokens: 2000, estimatedFilesChanged: 5 }, all).target, 'claude_code');
  assert.equal(routeTask(code, { contextTokens: 50_000 }, all).target, 'claude_code');
  assert.equal(routeTask(code, { contextTokens: 100, localFailedAttempts: 2 }, all).target, 'claude_code');
  assert.equal(routeTask(code, { contextTokens: 50_000 }, { claudeCode: false, externalManual: true }).target, 'external_manual');
  assert.equal(routeTask({ kind: 'text', projectId: null }, { contextTokens: 50_000 }, all).target, 'external_manual');
  assert.equal(routeTask(code, { contextTokens: 50_000 }, { claudeCode: false, externalManual: false }).target, 'owner');
});

test('External adapter only returns an owner-reviewed manual brief', async () => {
  const h = createTestHarness();
  try {
    const g = createDelegationGovernor({ db: h.db, clock: h.clock });
    const t = g.createTask(taskInput({ kind: 'text', projectId: null, permittedActions: ['draft_text'], inputs: [{ type: 'snippet', label: 'notes', text: 'outline' }] }));
    assert.ok(t.ok);
    const brief = buildHandoffBrief(t.value.taskId, t.value.spec, null);
    const external = createExternalAdapter();
    const out = await external.handoff(brief);
    assert.equal(out.mode, 'manual');
    assert.equal(out.automated, false);
    assert.ok(out.mode === 'manual' && out.briefText === brief.text);
    assert.ok(out.mode === 'manual' && out.ownerInstructions.some((s) => /paste the brief into External yourself/.test(s)));
    // A "route" without verification evidence, or without the explicit mode, is never used.
    let completed = 0;
    const route = { verification: { verifiedAt: '', evidence: '' }, submit: async () => ({ handoffId: String(++completed) }) };
    assert.equal((await createExternalAdapter({ mode: 'verified_route', route }).handoff(brief)).mode, 'manual');
    assert.equal((await createExternalAdapter({ route: { ...route, verification: { verifiedAt: 'x', evidence: 'y' } } }).handoff(brief)).mode, 'manual');
    assert.equal(completed, 0);
  } finally {
    h.close();
  }
});

test('project registry: only Example App registered, exact URL resolution, release disabled, CI notes', () => {
  const reg = project();
  assert.deepEqual(reg.list().map((p) => p.id), ['example-app']);
  const p = reg.resolveUrl('https://EXAMPLE.com/')!;
  assert.equal(p.repoPath, '/path/to/example-project');
  assert.equal(reg.resolveUrl('http://example.com'), undefined);
  assert.equal(reg.resolveUrl('https://evil.example.com'), undefined);
  assert.equal(reg.resolveUrl('https://unregistered.example'), undefined);
  assert.equal(p.release?.enabled, false);
  assert.ok(Object.values(p.release?.credentialEnv ?? {}).every((v) => /^(keychain|env):/.test(v)));
  assert.equal(classifyRemoteOperation(p, { type: 'push', branch: 'main' }).kind, 'deploy');
  assert.equal(classifyRemoteOperation(p, { type: 'pull_request', head: 'potts/fix', base: 'main', changedFiles: ['src/a.ts'] }).kind, 'merge');
  assert.equal(classifyRemoteOperation(p, { type: 'pull_request', head: 'potts/fix', base: 'main', changedFiles: ['.github/workflows/ci.yml'] }).kind, 'deploy');
  // Raw secrets in a projects file are rejected.
  const raw = projectDocument();
  raw.projects[0]!.release.credentialEnv = { GH_TOKEN: 'ghp_realtokenvalue1234567890' };
  assert.equal(validateProjectsDocument(raw).ok, false);
  const raw2 = projectDocument();
  raw2.projects.push({ ...raw2.projects[0]!, id: 'dup' });
  assert.equal(validateProjectsDocument(raw2).ok, false, 'same URL registered twice');
  assert.ok(createProjectRegistry({ schemaVersion: 1, projects: [] }).resolveUrl('https://example.com') === undefined);
});

test('Qwen adapter is loopback-only', async () => {
  assert.throws(() => createQwenAdapter({ baseUrl: 'https://api.example.com/v1' }), /loopback/);
  const q = createQwenAdapter({ fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'draft' } }] }), { status: 200 }) });
  assert.deepEqual(await q.run('brief'), { ok: true, text: 'draft', error: null, model: 'qwen/qwen3.5-9b' });
});

test('delegation config: example config resolves with Claude Code disabled and manual External', async () => {
  const { loadConfig } = await import('../../src/core/index.ts');
  const { resolveDelegationConfig, loadProjectsForConfig } = await import('../../src/delegation/index.ts');
  const { mkdtempSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'potts-cfg-'));
  for (const [src, dst] of [['potts.example.json', 'potts.json'], ['accounts.example.json', 'accounts.json'], ['projects.example.json', 'projects.json']] as const)
    copyFileSync(fileURLToPath(new URL(`../../config/${src}`, import.meta.url)), join(dir, dst));
  const cfg = loadConfig(join(dir, 'potts.json'));
  assert.ok(cfg.ok, cfg.ok ? '' : cfg.error.message);
  if (!cfg.ok) return;
  const d = resolveDelegationConfig(cfg.value);
  assert.equal(d.claudeCode.enabled, false);
  assert.equal(d.external.mode, 'manual');
  assert.equal(d.paid.billing.claude_code, 'subscription');
  assert.equal(d.limits.maxDepth, 2);
  const reg = loadProjectsForConfig(cfg.value);
  assert.ok(reg.ok);
  assert.deepEqual(reg.value.list(), [], 'public project registry grants no project access by default');
});
