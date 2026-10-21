/**
 * Dedicated-user boundary (WP-2).
 *  - Wrapper validation runs everywhere: a copy of deploy/isolation/potts-worker-run with the user and
 *    jobs root rewritten to the current user / a temp dir is executed directly (no sudo).
 *  - The real `sudo -u potts-worker` suite runs only after the owner ran create-worker-user.sh --apply;
 *    otherwise it is skipped with the reason.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSandboxProfile, createDedicatedUserRunner, IsolationError, type RunSpec } from '../../src/workers/isolation/index.ts';

const WRAPPER_SRC = resolve(import.meta.dirname, '../../deploy/isolation/potts-worker-run');
const supported = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const HOME = homedir();

function run(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) =>
    execFile(file, args, { cwd, env: { PATH: '/usr/bin:/bin' } }, (err, stdout, stderr) =>
      res({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
}

let dir: string;
let jobs: string;
let wrapper: string;
before(() => {
  if (!supported) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'potts-wrap-')));
  jobs = join(dir, 'jobs');
  mkdirSync(join(jobs, 'job1'), { recursive: true });
  wrapper = join(dir, 'potts-worker-run');
  const src = readFileSync(WRAPPER_SRC, 'utf8').replace('JOBS_ROOT="/Users/Shared/potts-jobs"', `JOBS_ROOT="${jobs}"`).replace('WORKER="potts-worker"', `WORKER="${userInfo().username}"`);
  writeFileSync(wrapper, src);
  chmodSync(wrapper, 0o755);
});
after(() => {
  if (supported) rmSync(dir, { recursive: true, force: true });
});

const prof = (ws: string) => Buffer.from(buildSandboxProfile({ writablePaths: [ws], network: 'none' })).toString('base64');

test('wrapper: runs a job inside the sandbox with the env file consumed', { skip: !supported && 'macOS only' }, async () => {
  const ws = join(jobs, 'job1');
  const envf = join(ws, '.potts-env-test');
  writeFileSync(envf, `HOME=${ws}\nTMPDIR=${ws}\nPOTTS_JOB=42\nDYLD_INSERT_LIBRARIES=/tmp/x.dylib\n`);
  const r = await run(wrapper, ['--workspace', ws, '--cwd', ws, '--timeout-sec', '20', '--env-file', envf, '--profile-b64', prof(ws), '--', '/bin/sh', '-c', 'echo "$POTTS_JOB" > out && cat out && env | grep -c DYLD_ || true; ls ~/.ssh 2>/dev/null && echo LEAK || true'], ws);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^42\n0\n$/);
  assert.equal(existsSync(envf), false, 'env file must be deleted');
});

test('wrapper: refuses workspaces outside the jobs root, cwd outside the workspace, permissive profiles, bad timeouts', { skip: !supported && 'macOS only' }, async () => {
  const ws = join(jobs, 'job1');
  const outside = join(dir, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  const cases: string[][] = [
    ['--workspace', outside, '--cwd', outside, '--timeout-sec', '5', '--profile-b64', prof(outside), '--', '/usr/bin/true'],
    ['--workspace', jobs, '--cwd', jobs, '--timeout-sec', '5', '--profile-b64', prof(jobs), '--', '/usr/bin/true'],
    ['--workspace', join(ws, '..', '..', 'elsewhere'), '--cwd', outside, '--timeout-sec', '5', '--profile-b64', prof(outside), '--', '/usr/bin/true'],
    ['--workspace', ws, '--cwd', outside, '--timeout-sec', '5', '--profile-b64', prof(ws), '--', '/usr/bin/true'],
    ['--workspace', ws, '--cwd', ws, '--timeout-sec', '5', '--profile-b64', Buffer.from('(version 1)\n(allow default)\n').toString('base64'), '--', '/usr/bin/true'],
    ['--workspace', ws, '--cwd', ws, '--timeout-sec', '5', '--profile-b64', Buffer.from('(version 1)\n(deny default)\n(allow default)\n').toString('base64'), '--', '/usr/bin/true'],
    ['--workspace', ws, '--cwd', ws, '--timeout-sec', '999999', '--profile-b64', prof(ws), '--', '/usr/bin/true'],
    ['--workspace', ws, '--cwd', ws, '--timeout-sec', '5', '--profile-b64', prof(ws)],
  ];
  for (const c of cases) {
    const r = await run(wrapper, c, dir);
    assert.equal(r.code, 64, `expected refusal for ${c.join(' ')}: ${r.stderr}`);
  }
  const real = await run(WRAPPER_SRC, ['--workspace', ws, '--cwd', ws, '--timeout-sec', '5', '--profile-b64', prof(ws), '--', '/usr/bin/true'], dir);
  assert.equal(real.code, 64, 'the installed wrapper refuses to run as anyone but potts-worker');
});

test('wrapper: the perl alarm ends a job that overruns its time limit', { skip: !supported && 'macOS only' }, async () => {
  const ws = join(jobs, 'job1');
  const t0 = Date.now();
  const r = await run(wrapper, ['--workspace', ws, '--cwd', ws, '--timeout-sec', '1', '--profile-b64', prof(ws), '--', '/bin/sleep', '20'], ws);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 10_000);
});

// ---- real potts-worker user (owner-provisioned) ----
const dedicated = createDedicatedUserRunner();
const avail = supported ? await dedicated.available() : { ok: false as const, reason: 'macOS only' };
const skipReal = avail.ok ? false : `potts-worker not provisioned: ${avail.reason}`;

test('dedicated user: runs as potts-worker and cannot read owner data, policy, keychain or OpenClaw state', { skip: skipReal }, async () => {
  const job = mkdtempSync(join(dedicated.workspaceRoot, 'adv-'));
  try {
    const spec = (argv: string[]): RunSpec => ({ argv, cwd: job, env: { ...dedicated.baseEnv } as Record<string, string>, network: { mode: 'none' }, timeoutMs: 20_000 });
    const who = await dedicated.run(spec(['/usr/bin/id', '-un']));
    assert.equal(who.stdout.trim(), 'potts-worker', who.stderr);
    for (const t of [join(HOME, '.ssh'), join(HOME, 'Library', 'Keychains'), join(HOME, 'Library', 'Application Support', 'Potts'), join(HOME, '.openclaw'), join(HOME, 'Projects')]) {
      if (!existsSync(t)) continue;
      const r = await dedicated.run(spec(['/bin/ls', t]));
      assert.notEqual(r.exitCode, 0, `potts-worker must not list ${t}`);
    }
    assert.notEqual((await dedicated.run(spec(['/usr/bin/curl', '-sS', '-m', '5', 'https://example.com/']))).exitCode, 0);
    const w = await dedicated.run(spec(['/bin/sh', '-c', 'echo ok > result.txt']));
    assert.equal(w.exitCode, 0, w.stderr);
    assert.equal(readFileSync(join(job, 'result.txt'), 'utf8').trim(), 'ok', 'owner can read job output');
    assert.equal(readdirSync(job).some((f) => f.startsWith('.potts-env-')), false, 'env file consumed');
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test('dedicated user: cwd outside the jobs root is refused before sudo', { skip: !supported && 'macOS only' }, async () => {
  const r = createDedicatedUserRunner({ jobsRoot: jobs });
  await assert.rejects(r.run({ argv: ['/usr/bin/true'], cwd: dir, env: {}, network: { mode: 'none' }, timeoutMs: 1000 }), IsolationError);
  await assert.rejects(r.run({ argv: ['/usr/bin/true'], cwd: jobs, env: {}, network: { mode: 'none' }, timeoutMs: 1000 }), IsolationError);
  assert.equal(r.enforcement.osUser, 'potts-worker');
});
