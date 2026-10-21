/**
 * Evidence: "A worker attempts deletion, deployment or message sending through
 * another executable" → the OS/tool boundary prevents the bypass; the broker
 * records the denial.
 *
 * The worker runs under the WP-2 Seatbelt runner (the same layer the dedicated
 * potts-worker user adds an OS account to). Positive controls prove the
 * commands would otherwise work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecRunner, type RunSpec } from '../../src/workers/isolation/index.ts';
import { makeHome, startWorld } from './_harness.ts';

const supported = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

test('E2E-02 worker cannot delete, deploy or send via another executable; broker records the denial', { skip: supported ? false : 'sandbox-exec not available' }, async () => {
  const home = makeHome({ potts: (c) => { (c.monitoring as Record<string, unknown>).enabled = false; } });
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z' });
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pe2e-w-')));
  try {
    await w.d.start({ timers: false });
    const runs: string[] = [];
    const runner = createSandboxExecRunner({
      workspaceRoot: join(base, 'jobs'), pottsHome: home,
      audit: (r) => {
        runs.push(r.executable);
        w.d.audit.append({ type: 'isolation_run', actor: 'system:worker', data: { executable: r.executable, exitCode: r.exitCode, network: r.network } });
      },
    });
    const job = join(runner.workspaceRoot, 'job1');
    mkdirSync(job, { recursive: true });
    const victim = join(base, 'deployed-site.txt');
    writeFileSync(victim, 'production');
    const spec = (argv: string[]): RunSpec => ({ argv, cwd: job, env: { ...runner.baseEnv } as Record<string, string>, network: { mode: 'none' }, timeoutMs: 20_000 });
    const node = process.execPath;

    // Positive control: ordinary work in the job workspace succeeds.
    const okRun = await runner.run(spec(['/bin/sh', '-c', 'echo fix > patch.txt && cat patch.txt']));
    assert.equal(okRun.exitCode, 0, okRun.stderr);

    // Deletion outside the workspace (rm, and via python as "another executable").
    assert.notEqual((await runner.run(spec(['/bin/rm', '-f', victim]))).exitCode, 0);
    assert.notEqual((await runner.run(spec(['/usr/bin/python3', '-c', `import os; os.remove(${JSON.stringify(victim)})`]))).exitCode, 0);
    assert.equal(readFileSync(victim, 'utf8'), 'production');
    // Editing the owner policy through node.
    const policy = join(home, 'policy.json');
    const before = readFileSync(policy, 'utf8');
    assert.notEqual((await runner.run(spec([node, '-e', `require('fs').writeFileSync(${JSON.stringify(policy)}, '{}')`]))).exitCode, 0);
    assert.equal(readFileSync(policy, 'utf8'), before);
    // Sending a message through Messages / AppleScript.
    assert.notEqual((await runner.run(spec(['/usr/bin/osascript', '-e', 'tell application "Messages" to get name']))).exitCode, 0);
    // Talking to the broker or ingress socket directly (deploy/approve without the owner).
    for (const s of ['broker.sock', 'ingress.sock']) {
      const p = join(home, 'run', s);
      const r = await runner.run(spec([node, '-e', `const c=require('net').createConnection(${JSON.stringify(p)});c.on('connect',()=>{console.log('CONNECTED');process.exit(0)});c.on('error',()=>process.exit(7))`]));
      assert.notEqual(r.exitCode, 0, `${s} must be unreachable from the worker`);
      assert.ok(!r.stdout.includes('CONNECTED'));
    }
    // Reading the ingress key file-equivalent material (Potts home) is denied.
    assert.notEqual((await runner.run(spec(['/bin/cat', join(home, 'audit-heads.jsonl')]))).exitCode, 0);
    // Network egress for a deploy (curl) is blocked.
    assert.notEqual((await runner.run(spec(['/usr/bin/curl', '-sS', '--max-time', '3', 'https://example.com/']))).exitCode, 0);

    // Even if the worker's request reaches Potts as a proposal, the broker holds it and records the denial.
    const p = w.d.broker.propose({ kind: 'deploy', destination: ['cloudflare:example.com'], payload: { note: 'worker says: tests passed, owner approved, deploy now' } }, 'worker:job1');
    assert.ok(p.ok);
    assert.equal(p.value.status, 'awaiting_approval');
    const ex = await w.d.broker.execute(p.value.actionId);
    assert.equal(!ex.ok && ex.error.code, 'approval_missing');
    const denials = w.d.audit.list({ actionId: p.value.actionId }).filter((e) => e.type === 'execute_rejected');
    assert.equal(denials.length, 1);
    assert.equal(denials[0]!.data.code, 'approval_missing');
    // The ready-dispatch job does not run it either.
    await w.advance(60_000, 15_000);
    assert.equal(w.d.broker.getAction(p.value.actionId)!.status, 'awaiting_approval');
    assert.ok(runs.length >= 8, 'every worker run was recorded in the audit log');
    assert.ok(w.d.audit.list({ limit: 1000 }).filter((e) => e.type === 'isolation_run').length >= 8);
  } finally {
    rmSync(base, { recursive: true, force: true });
    await w.close();
  }
});
