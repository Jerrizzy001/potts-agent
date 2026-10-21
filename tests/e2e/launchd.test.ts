import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHD_DIR = join(REPO, 'deploy', 'launchd');
const INSTALL = join(LAUNCHD_DIR, 'install-daemon.sh');
const UNINSTALL = join(LAUNCHD_DIR, 'uninstall-daemon.sh');
const LABEL = 'local.potts.daemon';

const hasPlutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' }).error === undefined;
const skip = hasPlutil ? false : 'plutil is unavailable (macOS only); skipping launchd tests';

interface Sandbox {
  root: string;
  agents: string;
  home: string;
  repo: string;
  launchctlLog: string;
  launchctl: string;
}

/** Temp sandbox whose paths contain spaces and XML-special characters. */
function makeSandbox(name: string, mainExit = 0): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'potts-launchd-'));
  const agents = join(root, 'Launch Agents');
  const home = join(root, 'Potts Home & <test>');
  const repo = join(root, 'repo with spaces', name);
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(repo, 'src', 'daemon'), { recursive: true });
  writeFileSync(join(repo, 'src', 'daemon', 'main.ts'), `if (process.argv.includes('--check')) { console.log('check home=' + process.env.POTTS_HOME); process.exit(${mainExit}); }\n`);
  const launchctlLog = join(root, 'launchctl.log');
  const launchctl = join(root, 'fake-launchctl');
  writeFileSync(launchctl, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}\nif [[ "$1" == "print" ]]; then echo "$2 = { state = running }"; fi\nexit 0\n`);
  chmodSync(launchctl, 0o755);
  return { root, agents, home, repo, launchctlLog, launchctl };
}

function run(script: string, sb: Sandbox, args: string[]) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAUNCH_AGENTS_DIR: sb.agents, LAUNCHCTL: sb.launchctl, POTTS_HOME: sb.home },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function extractPlist(out: string): string {
  const m = /----- BEGIN RENDERED PLIST -----\n([\s\S]*?)----- END RENDERED PLIST -----/.exec(out);
  assert.ok(m && m[1], 'rendered plist printed');
  return m[1];
}

function plutilRaw(file: string, keyPath: string): string {
  const r = spawnSync('plutil', ['-extract', keyPath, 'raw', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function launchctlCalls(sb: Sandbox): string[] {
  return existsSync(sb.launchctlLog) ? readFileSync(sb.launchctlLog, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe('launchd install/uninstall scripts', { skip }, () => {
  const sandboxes: Sandbox[] = [];
  const node = process.execPath;
  after(() => { for (const s of sandboxes) rmSync(s.root, { recursive: true, force: true }); });

  test('dry run renders a valid plist, writes nothing and never calls launchctl', () => {
    const sb = makeSandbox('dry'); sandboxes.push(sb);
    writeFileSync(join(sb.agents, 'ai.openclaw.gateway.plist'), 'x');
    writeFileSync(join(sb.agents, 'local.openclaw.qwen-server.plist'), 'x');
    const r = run(INSTALL, sb, ['--node', node, '--repo', sb.repo, '--home', sb.home, '--skip-check', '--print-plist']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /untouched: ai\.openclaw\.gateway/);
    assert.match(r.out, /untouched: local\.openclaw\.qwen-server/);
    assert.deepEqual(readdirSync(sb.agents).sort(), ['ai.openclaw.gateway.plist', 'local.openclaw.qwen-server.plist']);
    assert.equal(existsSync(sb.home), false, 'dry run must not create POTTS_HOME');
    assert.deepEqual(launchctlCalls(sb), []);

    const file = join(sb.root, 'rendered.plist');
    writeFileSync(file, extractPlist(r.out));
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    assert.equal(plutilRaw(file, 'Label'), LABEL);
    assert.equal(plutilRaw(file, 'KeepAlive.SuccessfulExit'), 'false');
    assert.equal(plutilRaw(file, 'RunAtLoad'), 'true');
    assert.equal(plutilRaw(file, 'ThrottleInterval'), '30');
    assert.equal(plutilRaw(file, 'ExitTimeOut'), '30');
    assert.equal(plutilRaw(file, 'Umask'), '63');
    const nodePath = plutilRaw(file, 'ProgramArguments.0');
    assert.ok(nodePath.startsWith('/'), 'absolute node path');
    assert.equal(nodePath, node);
    assert.equal(plutilRaw(file, 'ProgramArguments.2'), join(sb.repo, 'src', 'daemon', 'main.ts'));
    assert.equal(plutilRaw(file, 'WorkingDirectory'), sb.repo);
    assert.equal(plutilRaw(file, 'EnvironmentVariables.POTTS_HOME'), sb.home);
    assert.equal(plutilRaw(file, 'StandardErrorPath'), join(sb.home, 'logs', 'daemon.err.log'));
    assert.match(plutilRaw(file, 'EnvironmentVariables.PATH'), /(^|:)\/usr\/bin(:|$)/);
    assert.equal(plutilRaw(file, 'EnvironmentVariables.NODE_ENV'), 'production');
  });

  test('preflight --check failure refuses; success passes POTTS_HOME', () => {
    const bad = makeSandbox('bad', 3); sandboxes.push(bad);
    const r1 = run(INSTALL, bad, ['--node', node, '--repo', bad.repo, '--home', bad.home]);
    assert.notEqual(r1.code, 0);
    assert.match(r1.err, /--check failed/);
    const good = makeSandbox('good', 0); sandboxes.push(good);
    const r2 = run(INSTALL, good, ['--node', node, '--repo', good.repo, '--home', good.home]);
    assert.equal(r2.code, 0, r2.out + r2.err);
    assert.ok(r2.out.includes('check home=' + good.home));
    assert.deepEqual(launchctlCalls(good), []);
  });

  test('rejects relative node path, missing daemon entry, old node', () => {
    const sb = makeSandbox('rej'); sandboxes.push(sb);
    assert.notEqual(run(INSTALL, sb, ['--node', 'node', '--repo', sb.repo, '--skip-check']).code, 0);
    assert.notEqual(run(INSTALL, sb, ['--node', node, '--repo', sb.root, '--skip-check']).code, 0);
    const oldNode = join(sb.root, 'old-node');
    writeFileSync(oldNode, '#!/bin/bash\necho 22.1.0\n');
    chmodSync(oldNode, 0o755);
    const r = run(INSTALL, sb, ['--node', oldNode, '--repo', sb.repo, '--skip-check']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /older than 24\.12\.0/);
  });

  test('scripts never act on OpenClaw or qwen-server labels', () => {
    for (const script of [INSTALL, UNINSTALL]) {
      const src = readFileSync(script, 'utf8');
      assert.match(src, /readonly LABEL="local\.potts\.daemon"/);
      for (const line of src.split('\n')) {
        if (/openclaw|qwen/i.test(line)) {
          assert.doesNotMatch(line, /LAUNCHCTL"|launchctl\s+(bootout|bootstrap|kickstart|kill|unload|load|disable|enable|remove)|\b(rm|mv|cp|install|sed -i)\s/, `unsafe line in ${script}: ${line}`);
        }
        if (/"\$LAUNCHCTL"/.test(line)) {
          assert.match(line, /\$LABEL|"\$DOMAIN" "\$DEST"/, `launchctl call not scoped to LABEL: ${line}`);
        }
      }
      assert.doesNotMatch(src, /^\s*sudo\b|[|&;]\s*sudo\b|\$\(\s*sudo\b/m, 'no sudo invocations');
    }
  });

  test('--apply installs 0644 and only bootouts/bootstraps local.potts.daemon; uninstall moves it to backups', () => {
    const sb = makeSandbox('apply'); sandboxes.push(sb);
    writeFileSync(join(sb.agents, 'ai.openclaw.mac.plist'), 'keep');
    const dest = join(sb.agents, `${LABEL}.plist`);
    writeFileSync(dest, 'old contents');
    const r = run(INSTALL, sb, ['--apply', '--node', node, '--repo', sb.repo, '--home', sb.home, '--skip-check']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(statSync(dest).mode & 0o777, 0o644);
    assert.equal(spawnSync('plutil', ['-lint', dest]).status, 0);
    assert.equal(plutilRaw(dest, 'Label'), LABEL);
    assert.equal(readFileSync(join(sb.agents, 'ai.openclaw.mac.plist'), 'utf8'), 'keep');
    assert.equal(statSync(join(sb.home, 'logs')).mode & 0o777, 0o700);
    const backups = readdirSync(join(sb.home, 'backups', 'launchd'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(sb.home, 'backups', 'launchd', backups[0] ?? ''), 'utf8'), 'old contents');

    const uid = String(process.getuid?.() ?? '');
    const calls = launchctlCalls(sb);
    assert.deepEqual(calls, [
      `bootout gui/${uid}/${LABEL}`,
      `bootstrap gui/${uid} ${dest}`,
      `print gui/${uid}/${LABEL}`,
    ]);
    for (const c of calls) assert.doesNotMatch(c, /openclaw|qwen/);

    const dry = run(UNINSTALL, sb, ['--home', sb.home]);
    assert.equal(dry.code, 0, dry.err);
    assert.ok(existsSync(dest), 'uninstall dry run keeps plist');
    assert.equal(launchctlCalls(sb).length, 3);

    const u = run(UNINSTALL, sb, ['--apply', '--home', sb.home]);
    assert.equal(u.code, 0, u.out + u.err);
    assert.equal(existsSync(dest), false);
    const removed = readdirSync(join(sb.home, 'backups', 'launchd')).filter((f) => f.startsWith('removed-'));
    assert.equal(removed.length, 1);
    assert.equal(plutilRaw(join(sb.home, 'backups', 'launchd', removed[0] ?? ''), 'Label'), LABEL);
    assert.equal(launchctlCalls(sb).at(-1), `bootout gui/${uid}/${LABEL}`);
    assert.ok(existsSync(join(sb.agents, 'ai.openclaw.mac.plist')));
  });
});

before(() => {
  if (!hasPlutil) console.log('# launchd tests skipped: plutil not found');
});
