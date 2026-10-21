/**
 * Bypass attempts against the Seatbelt runner (WP-2). Every attempt must fail
 * while the matching positive control (same action allowed / unsandboxed)
 * succeeds, so a test cannot pass just because a command was broken.
 *
 * Tests never print the contents of protected files: reads use `head -c 1 >/dev/null`
 * (exit status only).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecRunner, IsolationError, mapNetworkPolicy, type RunSpec } from '../../src/workers/isolation/index.ts';
import { WorkerEnvError } from '../../src/delegation/runner.ts';

const supported = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const skip = supported ? false : 'sandbox-exec not available';
const HOME = homedir();
const NODE = process.execPath;

let base: string;
let root: string;
let job: string;
let outside: string;
let runner: ReturnType<typeof createSandboxExecRunner>;
let tcp: Server;
let tcpPort = 0;
let unixSrv: Server;
let unixPath: string;

const spec = (argv: string[], extra: Partial<RunSpec> = {}): RunSpec => ({
  argv,
  cwd: job,
  env: { ...runner.baseEnv } as Record<string, string>,
  network: { mode: 'none' },
  timeoutMs: 20_000,
  ...extra,
});
const sh = (script: string, extra: Partial<RunSpec> = {}) => runner.run(spec(['/bin/sh', '-c', script], extra));

before(async () => {
  if (!supported) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'potts-adv-')));
  root = join(base, 'jobs');
  mkdirSync(root);
  runner = createSandboxExecRunner({ workspaceRoot: root });
  job = join(runner.workspaceRoot, 'job1');
  mkdirSync(job);
  outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'victim.txt'), 'keep me');
  writeFileSync(join(outside, 'policy.json'), '{"version":"orig"}');
  tcp = createServer((s) => { s.on('error', () => {}); s.end('hello\n'); });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
  tcpPort = (tcp.address() as { port: number }).port;
  unixPath = join(base, 'b.sock');
  unixSrv = createServer((s) => { s.on('error', () => {}); s.end('{"ok":true}\n'); });
  await new Promise<void>((r) => unixSrv.listen(unixPath, () => r()));
});
after(() => {
  if (!supported) return;
  tcp.close();
  unixSrv.close();
  rmSync(base, { recursive: true, force: true });
});

test('positive controls: normal work inside the workspace succeeds', { skip }, async () => {
  const r = await sh('echo ok > out.txt && cat out.txt && mkdir -p a/b && echo x > a/b/c');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ok');
  assert.equal(readFileSync(join(job, 'out.txt'), 'utf8').trim(), 'ok');
  const n = await runner.run(spec([NODE, '-e', 'require("fs").writeFileSync("n.txt","node"); console.log(1+1)']));
  assert.equal(n.exitCode, 0, n.stderr);
  assert.equal(n.stdout.trim(), '2');
  const p = await runner.run(spec(['/usr/bin/python3', '-c', 'print(6*7)']));
  assert.equal(p.exitCode, 0, p.stderr);
  assert.equal(p.stdout.trim(), '42');
  assert.deepEqual(runner.enforcement, { osUser: null, filesystem: true, network: true });
});

test('rm outside the workspace fails and the file survives', { skip }, async () => {
  const r = await runner.run(spec(['/bin/rm', '-f', join(outside, 'victim.txt')]));
  assert.notEqual(r.exitCode, 0);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'keep me');
});

test('writing to a policy file outside the workspace fails (shell, node, python)', { skip }, async () => {
  const pol = join(outside, 'policy.json');
  assert.notEqual((await sh(`echo '{"version":"evil"}' > '${pol}'`)).exitCode, 0);
  assert.notEqual((await runner.run(spec([NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(pol)}, 'evil')`]))).exitCode, 0);
  assert.notEqual((await runner.run(spec(['/usr/bin/python3', '-c', `open(${JSON.stringify(pol)},'w').write('evil')`]))).exitCode, 0);
  assert.equal(readFileSync(pol, 'utf8'), '{"version":"orig"}');
  const real = join(HOME, 'Library', 'Application Support', 'Potts', 'policy.json');
  const existed = existsSync(real);
  assert.notEqual((await sh(`echo evil > '${real}'`)).exitCode, 0);
  assert.equal(existsSync(real), existed);
});

for (const [name, target] of [
  ['~/.ssh', join(HOME, '.ssh')],
  ['~/Library/Keychains', join(HOME, 'Library', 'Keychains')],
  ['Potts home', join(HOME, 'Library', 'Application Support', 'Potts')],
  ['~/.openclaw', join(HOME, '.openclaw')],
  ['~/Library/Messages', join(HOME, 'Library', 'Messages')],
  ['~/Library/Mail', join(HOME, 'Library', 'Mail')],
  ['owner project checkouts', join(HOME, 'Projects')],
  ['gateway logs in /tmp', '/tmp/openclaw'],
] as const) {
  test(`reading ${name} is denied`, { skip: skip || (!existsSync(target) && `${target} absent`) }, async () => {
    const ls = await runner.run(spec(['/bin/ls', target]));
    assert.notEqual(ls.exitCode, 0, `ls ${name} must fail`);
    assert.equal(ls.stdout, '');
  });
}

test('reading the gateway config and a keychain file is denied (head -c 1, no contents captured)', { skip }, async () => {
  for (const f of [join(HOME, '.openclaw', 'openclaw.json'), join(HOME, 'Library', 'Keychains', 'login.keychain-db')]) {
    if (!existsSync(f)) continue;
    const r = await sh(`head -c 1 '${f}' > /dev/null`);
    assert.notEqual(r.exitCode, 0, `${f} must be unreadable`);
  }
  const py = await runner.run(spec(['/usr/bin/python3', '-c', `import os; os.listdir(${JSON.stringify(join(HOME, '.ssh'))})`]));
  assert.notEqual(py.exitCode, 0);
});

test('network: TCP to a local listener fails from curl, python and node (positive control unsandboxed)', { skip }, async () => {
  const { connect } = await import('node:net');
  await new Promise<void>((res, rej) => connect(tcpPort, '127.0.0.1').on('connect', function (this: import('node:net').Socket) { this.destroy(); res(); }).on('error', rej)); // reachable unsandboxed
  assert.notEqual((await runner.run(spec(['/usr/bin/curl', '-sS', '-m', '5', `http://127.0.0.1:${tcpPort}/`]))).exitCode, 0);
  assert.notEqual((await runner.run(spec(['/usr/bin/python3', '-c', `import socket; socket.create_connection(('127.0.0.1', ${tcpPort}), 5)`]))).exitCode, 0);
  const n = await runner.run(spec([NODE, '-e', `const s=require('net').connect(${tcpPort},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3))`]));
  assert.equal(n.exitCode, 3);
  assert.notEqual((await runner.run(spec(['/usr/bin/curl', '-sS', '-m', '5', 'https://example.com/']))).exitCode, 0);
});

test('network: the broker Unix socket cannot be reached', { skip }, async () => {
  const n = await runner.run(spec([NODE, '-e', `const s=require('net').connect(${JSON.stringify(unixPath)});s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3))`]));
  assert.equal(n.exitCode, 3);
});

test('network allowlist: only the listed localhost port is reachable', { skip }, async () => {
  const ok = await runner.run(spec([NODE, '-e', `const s=require('net').connect(${tcpPort},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3))`], { network: { mode: 'allowlist', hosts: [`localhost:${tcpPort}`] } }));
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(ok.enforcement.network, true);
  const other = await runner.run(spec([NODE, '-e', `const s=require('net').connect(${tcpPort},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3))`], { network: { mode: 'allowlist', hosts: [`localhost:${tcpPort === 65535 ? 1 : tcpPort + 1}`] } }));
  assert.equal(other.exitCode, 3);
  const m = mapNetworkPolicy({ mode: 'allowlist', hosts: ['api.anthropic.com'] });
  assert.equal(m.enforced, false);
  assert.deepEqual(m.allow, [{ host: '*', port: 443 }]);
  const strict = createSandboxExecRunner({ workspaceRoot: root, strictNetwork: true });
  await assert.rejects(strict.run(spec(['/usr/bin/true'], { network: { mode: 'allowlist', hosts: ['api.anthropic.com'] } })), IsolationError);
});

test('symlink inside the workspace pointing outside: write through it fails', { skip }, async () => {
  symlinkSync(outside, join(job, 'escape'));
  symlinkSync(join(outside, 'victim.txt'), join(job, 'victim-link'));
  assert.notEqual((await sh('echo pwned > escape/new.txt')).exitCode, 0);
  assert.notEqual((await sh('echo pwned > victim-link')).exitCode, 0);
  assert.equal(existsSync(join(outside, 'new.txt')), false);
  assert.equal(readFileSync(join(outside, 'victim.txt'), 'utf8'), 'keep me');
  if (existsSync(join(HOME, '.ssh'))) {
    symlinkSync(join(HOME, '.ssh'), join(job, 'ssh'));
    assert.notEqual((await runner.run(spec(['/bin/ls', 'ssh/']))).exitCode, 0);
  }
});

test('path traversal with ../ fails, and so does a sibling job workspace', { skip }, async () => {
  assert.notEqual((await sh('echo x > ../../outside/trav.txt')).exitCode, 0);
  assert.equal(existsSync(join(outside, 'trav.txt')), false);
  const sib = join(runner.workspaceRoot, 'job2');
  mkdirSync(sib, { recursive: true });
  assert.notEqual((await sh(`echo x > '${sib}/x.txt'`)).exitCode, 0);
  assert.notEqual((await runner.run(spec(['/bin/ls', sib]))).exitCode, 0);
});

test('GUI / keychain / privilege binaries cannot be executed (osascript, open -a Messages, security, sudo)', { skip }, async () => {
  for (const argv of [
    ['/usr/bin/osascript', '-e', 'return 1'],
    ['/usr/bin/open', '-a', 'Messages'],
    ['/usr/bin/security', 'find-generic-password', '-s', 'potts', '-a', 'ingress-hmac-key', '-w'],
    ['/usr/bin/sudo', '-n', 'true'],
    ['/usr/bin/pbpaste'],
  ]) {
    const r = await runner.run(spec(argv));
    assert.notEqual(r.exitCode, 0, argv.join(' '));
    assert.equal(r.stdout, '');
  }
  // Via a shell and via an interpreter's subprocess API as well.
  assert.notEqual((await sh('osascript -e "return 1"')).exitCode, 0);
  assert.notEqual((await runner.run(spec(['/usr/bin/python3', '-c', 'import subprocess,sys; sys.exit(subprocess.call(["/usr/bin/open","-a","Messages"]))']))).exitCode, 0);
  assert.notEqual((await runner.run(spec([NODE, '-e', 'require("child_process").execFileSync("/usr/bin/security",["list-keychains"])']))).exitCode, 0);
});

test('a copied security/open binary still cannot reach the keychain or LaunchServices', { skip }, async () => {
  copyFileSync('/usr/bin/security', join(job, 'sec'));
  copyFileSync('/usr/bin/open', join(job, 'op'));
  const kc = join(HOME, 'Library', 'Keychains', 'login.keychain-db');
  const s = await runner.run(spec([join(job, 'sec'), 'show-keychain-info', kc]));
  assert.notEqual(s.exitCode, 0);
  const o = await runner.run(spec([join(job, 'op'), '-a', 'PottsNoSuchApplication']));
  assert.notEqual(o.exitCode, 0);
  assert.doesNotMatch(o.stderr, /Unable to find application/, 'must not have reached LaunchServices');
});

test('process listing of other processes is not available', { skip }, async () => {
  const r = await runner.run(spec(['/bin/ps', '-axo', 'user,args']));
  assert.notEqual(r.exitCode, 0);
});

test('environment is exact and credential-looking variables are refused', { skip }, async () => {
  process.env.POTTS_ADV_SECRET_PROBE = 'should-not-leak';
  const r = await runner.run(spec(['/usr/bin/env']));
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.stdout, /POTTS_ADV_SECRET_PROBE/);
  delete process.env.POTTS_ADV_SECRET_PROBE;
  await assert.rejects(runner.run(spec(['/usr/bin/true'], { env: { PATH: '/usr/bin', GITHUB_TOKEN: 'x' } })), WorkerEnvError);
  await assert.rejects(runner.run(spec(['/usr/bin/true'], { env: { PATH: '/usr/bin', MY_API_KEY: 'x' } })), WorkerEnvError);
  await assert.rejects(runner.run(spec(['/usr/bin/true'], { env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x' } })), WorkerEnvError);
});

test('cwd outside the workspace root, and unsafe roots, are refused', { skip }, async () => {
  await assert.rejects(runner.run(spec(['/usr/bin/true'], { cwd: outside })), IsolationError);
  await assert.rejects(runner.run(spec(['/usr/bin/true'], { cwd: join(job, '..', '..', 'outside') })), IsolationError);
  assert.throws(() => createSandboxExecRunner({ workspaceRoot: HOME }), IsolationError);
  if (existsSync(join(HOME, '.ssh'))) assert.throws(() => createSandboxExecRunner({ workspaceRoot: join(HOME, '.ssh') }), IsolationError);
  const link = join(base, 'root-link');
  symlinkSync(join(HOME, 'Library'), link);
  assert.throws(() => createSandboxExecRunner({ workspaceRoot: link }), IsolationError);
  assert.throws(() => createSandboxExecRunner({ workspaceRoot: root, readOnlyPaths: [join(HOME, 'Library', 'Keychains')] }), IsolationError);
});

test('timeout kills the whole process group; output is capped', { skip }, async () => {
  const t0 = Date.now();
  const r = await sh('sleep 30 & sleep 30; echo done', { timeoutMs: 800 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000);
  const big = await runner.run(spec([NODE, '-e', 'process.stdout.write("x".repeat(200000))'], { maxOutputBytes: 1000 }));
  assert.equal(big.outputTruncated, true);
  assert.equal(big.stdout.length, 1000);
});
