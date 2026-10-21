/**
 * Fixtures for WP-6 tests: a bare "origin" repo (stands in for GitHub), an
 * owner checkout with untracked output/ and .env, a fake `claude` CLI, a fake
 * release script, and a registered project pointing at them.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitOk } from '../../src/delegation/git.ts';
import { createProjectRegistry, type ProjectEntry, type ProjectRegistry } from '../../src/delegation/projects.ts';

export const ID_ENV = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
export const g = (args: string[], cwd: string) => gitOk(args, { cwd, env: ID_ENV });

export interface Fixture {
  root: string;
  origin: string;
  owner: string;
  fakeBin: string;
  stateDir: string;
  workspaceRoot: string;
  evidenceRoot: string;
  releaseRoot: string;
  project: ProjectEntry;
  registry: ProjectRegistry;
  mainSha: string;
  /** Commit a change on origin/main through a second clone (simulates someone merging). */
  advanceMain(file: string, content: string): Promise<string>;
  cleanup(): void;
}

const MATH = 'export function add(a, b) {\n  return a + b;\n}\n';
const TEST = "import { add } from './math.mjs';\nif (add(2, 2) !== 4) { console.error('add(2,2) != 4'); process.exit(1); }\nconsole.log('ok');\n";
const RELEASE = `import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const dry = process.argv.includes('--dry-run');
if (!process.env.DEPLOY_TOKEN) { console.error('missing DEPLOY_TOKEN'); process.exit(3); }
if (process.env.FAIL_PRE === '1' && dry) { console.error('dry run failed'); process.exit(4); }
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!dry) {
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  writeFileSync(process.env.STATE_DIR + '/deployed.json', JSON.stringify({ sha, tokenSeen: true }));
}
console.log((dry ? 'dry run ok ' : 'deployed ') + sha);
`;
const IDENTITY = `import { readFileSync } from 'node:fs';
const want = process.argv[2];
let d = {};
try { d = JSON.parse(readFileSync(process.env.STATE_DIR + '/deployed.json', 'utf8')); } catch {}
if (d.sha !== want) { console.error('deployed ' + d.sha + ' != ' + want); process.exit(1); }
console.log('identity ok');
`;

/** Fake Claude Code CLI. Behaviour selected by FAKE_CLAUDE_MODE in the worker env. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const tmp = process.env.TMPDIR || '/tmp';
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.FAKE_CLAUDE_LOGIN_METHOD || 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
let brief = '';
try { brief = readFileSync(0, 'utf8'); } catch {}
writeFileSync(join(tmp, 'fake-claude-brief.txt'), brief);
writeFileSync(join(tmp, 'fake-claude-args.json'), JSON.stringify(args));
writeFileSync(join(tmp, 'fake-claude-env.json'), JSON.stringify(Object.keys(process.env).sort()));
const mode = process.env.FAKE_CLAUDE_MODE || 'break';
const claim = (passed) => 'Done.\\n\\n\`\`\`json\\n' + JSON.stringify({ summary: 'Adjusted add()', filesChanged: ['math.mjs'], testsRun: [{ command: 'node test.mjs', exitCode: 0 }], testsPassed: passed, unfinished: [] }) + '\\n\`\`\`';
if (mode === 'limit') {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached. Your limit will reset at 5pm.', session_id: 's-limit', num_turns: 1 }));
  process.exit(1);
}
if (mode === 'break') writeFileSync('math.mjs', 'export function add(a, b) {\\n  return a - b + 1;\\n}\\n');
if (mode === 'fix') writeFileSync('math.mjs', '// Adds two numbers.\\nexport function add(a, b) {\\n  return a + b;\\n}\\n');
if (mode === 'extension') { writeFileSync('math.mjs', '// touched\\nexport function add(a, b) {\\n  return a + b;\\n}\\n'); writeFileSync('extension.txt', 'x'); }
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: claim(true), session_id: 's-1', num_turns: 4, total_cost_usd: 0.42 }));
`;

export async function createFixture(opts: { fakeClaudeMode?: string } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'potts-wp6-'));
  const origin = join(root, 'origin.git');
  const owner = join(root, 'owner');
  const fakeBin = join(root, 'bin');
  const stateDir = join(root, 'cloud-state');
  mkdirSync(fakeBin);
  await gitOk(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  await gitOk(['init', '--quiet', '--initial-branch=main', owner]);
  writeFileSync(join(owner, 'math.mjs'), MATH);
  writeFileSync(join(owner, 'test.mjs'), TEST);
  writeFileSync(join(owner, 'release.mjs'), RELEASE);
  writeFileSync(join(owner, 'check-identity.mjs'), IDENTITY);
  writeFileSync(join(owner, '.env.example'), 'API_KEY=\n');
  await g(['add', '-A'], owner);
  await g(['commit', '--quiet', '-m', 'initial'], owner);
  await g(['remote', 'add', 'origin', origin], owner);
  await g(['push', '--quiet', 'origin', 'main'], owner);
  // Untracked owner state that must never reach a worker.
  mkdirSync(join(owner, 'output'));
  writeFileSync(join(owner, 'output', 'private-report.txt'), 'owner private output');
  writeFileSync(join(owner, '.env'), 'SECRET_THING=do-not-copy\n');
  const mainSha = await g(['rev-parse', 'HEAD'], owner);
  writeFileSync(join(fakeBin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(fakeBin, 'claude'), 0o755);
  const nodeDir = dirname(process.execPath);
  const project: ProjectEntry = {
    id: 'demo',
    displayName: 'Demo site',
    urls: ['https://demo.example'],
    repoPath: owner,
    remoteUrl: origin,
    defaultBranch: 'main',
    testCommands: [{ id: 'unit', argv: ['node', 'test.mjs'], timeoutSeconds: 30 }],
    releaseChecks: [{ id: 'extension', pathPatterns: ['extension*', 'extension/**'], commands: [{ id: 'ext-check', argv: ['node', 'test.mjs'], timeoutSeconds: 30 }], runbook: 'docs/ext.md' }],
    deploymentTargets: [
      {
        id: 'production', kind: 'other', url: 'https://demo.example', sourceBranch: 'main',
        identityChecks: [{ type: 'command', argv: ['node', 'check-identity.mjs', '{sha}'], timeoutSeconds: 30 }],
        liveChecks: [{ type: 'http', url: 'https://demo.example/api/health', expectStatus: 200, expectJson: { ok: true } }],
      },
    ],
    release: {
      enabled: true,
      commands: [
        { id: 'dry-run', argv: ['node', 'release.mjs', '--dry-run'], phase: 'pre', timeoutSeconds: 30 },
        { id: 'deploy', argv: ['node', 'release.mjs'], phase: 'release', timeoutSeconds: 30 },
      ],
      credentialEnv: { DEPLOY_TOKEN: 'env:POTTS_TEST_DEPLOY_TOKEN' },
      envAllowlist: ['HOME'],
      env: { PATH: `${nodeDir}:/usr/bin:/bin`, STATE_DIR: stateDir },
    },
    ci: {
      provider: 'github_actions',
      workflows: [
        { file: '.github/workflows/release.yml', name: 'Release', triggers: [{ event: 'push', branches: ['main'] }, { event: 'workflow_dispatch' }], deploys: true, usesSecrets: true },
        { file: '.github/workflows/ci.yml', name: 'CI', triggers: [{ event: 'pull_request', branches: ['main'] }], deploys: false },
      ],
      workflowPathPatterns: ['.github/workflows/**'],
    },
    worker: {
      envAllowlist: ['HOME', 'TMPDIR', 'USER', 'LANG'],
      env: { PATH: `${fakeBin}:${nodeDir}:/usr/bin:/bin`, FAKE_CLAUDE_MODE: opts.fakeClaudeMode ?? 'break' },
      testNetwork: [],
    },
  };
  const registry = createProjectRegistry({ schemaVersion: 1, projects: [project] });
  const fx: Fixture = {
    root, origin, owner, fakeBin, stateDir,
    workspaceRoot: join(root, 'workers'), evidenceRoot: join(root, 'evidence'), releaseRoot: join(root, 'release'),
    project, registry, mainSha,
    async advanceMain(file, content) {
      const other = join(root, `other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await gitOk(['clone', '--quiet', origin, other]);
      writeFileSync(join(other, file), content);
      await g(['add', '-A'], other);
      await g(['commit', '--quiet', '-m', `change ${file}`], other);
      await g(['push', '--quiet', 'origin', 'HEAD:main'], other);
      return g(['rev-parse', 'HEAD'], other);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fx;
}

export function withProject(fx: Fixture, patch: Partial<ProjectEntry>): ProjectRegistry {
  return createProjectRegistry({ schemaVersion: 1, projects: [{ ...fx.project, ...patch }] });
}

export function taskInput(o: Record<string, unknown> = {}) {
  return {
    kind: 'code_change',
    projectId: 'demo',
    objective: 'Make add() correct and keep tests green',
    inputs: [{ type: 'file', path: 'math.mjs' }],
    permittedActions: ['read_repo', 'edit_working_copy', 'run_registered_tests'],
    expectedEvidence: ['node test.mjs passes'],
    stopConditions: ['Stop if the fix needs more than math.mjs'],
    ...o,
  };
}

export const okFetch: typeof fetch = async () => new Response(JSON.stringify({ ok: true, kind: 'liveness' }), { status: 200, headers: { 'content-type': 'application/json' } });
