/**
 * Daemon smoke tests: in-process start against a temp POTTS_HOME with the
 * example config, readiness over the read socket, clean shutdown; and the real
 * entry point (main.ts) as a child process: --check writes nothing, and
 * SIGTERM drains and exits 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { validateConfig } from '../../src/core/config.ts';
import { join } from 'node:path';
import { connectSocket } from '../../src/broker/server.ts';
import { makeHome, startWorld, routeSite, createFakeNet, example } from './_harness.ts';
import { readAuditHeads } from '../../src/daemon/audit-head.ts';

const MAIN = join(import.meta.dirname, '../../src/daemon/main.ts');

test('daemon starts in-process with the example config, serves sockets, reports readiness, shuts down cleanly', async () => {
  const home = makeHome();
  const net = createFakeNet();
  routeSite(net);
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z', net });
  try {
    await w.d.start({ timers: false });
    for (const s of ['broker.sock', 'ingress.sock', 'read.sock', 'memory-control.sock']) {
      const p = join(home, 'run', s);
      assert.ok(existsSync(p), `${s} exists`);
      assert.equal(statSync(p).mode & 0o777, 0o600, `${s} is 0600`);
    }
    await w.advance(2 * 60_000);
    const c = await connectSocket(join(home, 'run', 'read.sock'));
    const r = await c.call('capabilities.status');
    c.close();
    assert.ok(r.ok);
    const caps = (r.result as { capabilities: { id: string; state: string; reason: string }[] }).capabilities;
    const byId = new Map(caps.map((x) => [x.id, x]));
    assert.equal(byId.get('telegram')!.state, 'approval_required');
    assert.equal(byId.get('broker')!.state, 'approval_required');
    assert.equal(byId.get('monitor:exampleapp')!.state, 'automatic', byId.get('monitor:exampleapp')!.reason);
    assert.equal(byId.get('telephony')!.state, 'not_connected');
    assert.equal(byId.get('writer:gmail-personal')!.state, 'not_connected');
    // The proposer socket has no owner/execute methods.
    const b = await connectSocket(join(home, 'run', 'broker.sock'));
    const bad = await b.call('execute', { actionId: 'act_x' });
    b.close();
    assert.equal(bad.ok, false);
    assert.equal(w.d.audit.verify().ok, true);
  } finally {
    await w.d.stop('test');
    for (const s of ['broker.sock', 'ingress.sock', 'read.sock', 'memory-control.sock', 'daemon.lock']) assert.ok(!existsSync(join(home, 'run', s)), `${s} removed`);
    const heads = readAuditHeads(home);
    assert.equal(heads[0]!.kind, 'startup');
    assert.equal(heads[heads.length - 1]!.kind, 'shutdown');
    rmSync(home, { recursive: true, force: true });
  }
});

test('a second daemon on the same home refuses to start (single instance)', async () => {
  const home = makeHome();
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z' });
  try {
    await assert.rejects(startWorld({ home, start: '2026-10-07T14:00:00Z' }), /another Potts daemon is running/);
  } finally {
    await w.close();
  }
});

test('missing optional config degrades to not_connected; missing potts.json is refused', async () => {
  const home = makeHome({ projects: null });
  rmSync(join(home, 'accounts.json'));
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z', keychain: {} });
  try {
    const caps = new Map(w.d.capabilities().map((c) => [c.id, c]));
    assert.equal(caps.get('delegation')!.state, 'not_connected');
    assert.ok(![...caps.keys()].some((k) => k.startsWith('mail:')));
  } finally {
    await w.close();
  }
  const empty = makeHome();
  rmSync(join(empty, 'potts.json'));
  await assert.rejects(startWorld({ home: empty, start: '2026-10-07T14:00:00Z' }), /not found/);
  rmSync(empty, { recursive: true, force: true });
});

function childHome(): string {
  const home = makeHome({
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false; // no real network from the child process
      c.daemon = { tickMs: 1000 };
    },
  });
  return home;
}

test('main.ts --check prints a readiness table and writes nothing', () => {
  const home = childHome();
  try {
    const before = readdirSync(home).sort();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, '--check'], { env: { ...process.env, POTTS_HOME: home, POTTS_KEYCHAIN: 'off' }, encoding: 'utf8' });
    assert.equal(r.status, 1, 'not ready: Keychain items are missing');
    assert.match(r.stdout, /secret:ingress key\s+FAIL/);
    assert.match(r.stdout, /Capabilities \(offline view/);
    assert.match(r.stdout, /Result: NOT READY/);
    assert.deepEqual(readdirSync(home).sort(), before, '--check created no files');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('main.ts runs as a process and exits 0 on SIGTERM after draining', async () => {
  const home = childHome();
  try {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], { env: { ...process.env, POTTS_HOME: home, POTTS_KEYCHAIN: 'off', POTTS_LOG_LEVEL: 'warn' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const sock = join(home, 'run', 'broker.sock');
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(sock), `daemon did not start: ${err}`);
    const code = await new Promise<number | null>((resolve) => {
      p.on('exit', (c) => resolve(c));
      p.kill('SIGTERM');
    });
    assert.equal(code, 0, err);
    assert.ok(!existsSync(sock));
    assert.ok(!existsSync(join(home, 'run', 'daemon.lock')));
    const heads = readFileSync(join(home, 'audit-heads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    assert.equal(heads[heads.length - 1]!.kind, 'shutdown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('example config (with the WP-8 daemon and backup sections) validates', () => {
  const c = example('potts');
  const accounts = example('accounts');
  const r = validateConfig(c, accounts);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  assert.deepEqual(Object.keys(c.daemon as object).sort(), ['auditHeadIntervalMinutes', 'autoExecuteReady', 'memoryControlSocket', 'ownerChannel', 'readSocket', 'tickMs']);
  const bad = validateConfig({ ...c, daemon: { ownerChannel: 'telegram-bot-api' } }, accounts);
  assert.equal(bad.ok, false, 'Potts never talks to the Bot API directly');
});
