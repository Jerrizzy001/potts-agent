import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeTools, CLAUDE_DISALLOWED, type Spawner } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-task.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';

test('potts_claude: auto mode, push/deploy blocked, one job at a time, report relayed to the owner session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-cc-'));
  try {
    const proj = join(home, 'proj'); mkdirSync(proj);
    const cli = join(home, 'claude'); writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 });
    const cfg = parsePluginConfig({ pottsHome: home, ownerTelegramId: '424242' }); assert.ok(cfg.ok);
    const ownerMessage = 'The fix is ready. The checks passed.';
    const detailedReport = 'Changed a.ts; tests pass. ' + 'evidence '.repeat(1000);
    const rawReport = JSON.stringify({version:1,outcome:'completed',ownerMessage,detailedReport});
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    let finishFirst: (() => void) | undefined;
    const spawner: Spawner = (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o.cwd });
      if (cmd === cli) finishFirst = () => { writeFileSync(o.outFile, JSON.stringify({ result: rawReport, total_cost_usd: 0 })); o.onExit(0); };
    };
    let t = 0;
    const tools = createClaudeTools(cfg.value, { get: async () => ({ ownerId: '424242', key: Buffer.alloc(32) }) } as never,
      { controls: async () => ({ paused: false }), spawner, claudeCli: cli, openclawCli: '/x/openclaw', now: () => new Date(Date.UTC(2026, 9, 7, 5, 0, t++)) });
    const [start, status] = tools; const toolsControl = tools.control;
    assert.match((await start!.execute('0', { task: 'try the openclaw dir', kind: 'coding', project: join(process.env.HOME!, '.openclaw') })).content[0]!.text, /^Not started/, 'blocked before the scratch dir exists');
    const first = await start!.execute('1', { task: 'fix the thing please', kind: 'coding', project: home + '/../' + home.split('/').pop() + '/proj' }); assert.equal((first.details as {ok:boolean}).ok,true);
    const run = calls[0]!;
    assert.equal(run.cwd.endsWith('/proj'), true);
    assert.deepEqual(run.args.slice(run.args.indexOf('--model'), run.args.indexOf('--model')+6), ['--model', 'claude-opus-5-5', '--effort', 'medium', '--permission-mode', 'auto']);
    for (const d of CLAUDE_DISALLOWED) assert.ok(run.args.includes(d), d);
    const second = await start!.execute('2', { task: 'another task here', kind: 'debugging', project: proj });
    assert.equal((second.details as { state: string }).state, 'queued');
    await toolsControl({ jobId: (second.details as { jobId: string }).jobId, action: 'pause' });
    finishFirst!();
    await new Promise((r) => setTimeout(r, 10));
    const relay = calls.find((c) => c.cmd === '/x/openclaw')!;
    assert.deepEqual(relay.args.slice(0, 6), ['message', 'send', '--channel', 'telegram', '--target', '424242'], 'report goes straight to the owner chat');
    assert.equal(relay.args[relay.args.indexOf('-m') + 1]!, ownerMessage);
    assert.ok(!relay.args.includes('--deliver') && !relay.args.includes('agent'), 'no coordinator model turn for the report');
    const saved = await status!.execute('3', {jobId:(first.details as {jobId:string}).jobId});
    assert.match(saved.content[0]!.text, /done[\s\S]*Changed a\.ts/);
    const job = (saved.details as {job:{summary:string;rawReport:string;reportedOutcome:string}}).job;
    assert.equal(job.summary, detailedReport); assert.equal(job.rawReport, rawReport); assert.equal(job.reportedOutcome, 'completed');
    const brainstorm = calls.length;
    await start!.execute('5', { task: 'ideas for the landing page', kind: 'brainstorming' });
    const b = calls[brainstorm]!;
    assert.ok(b.cwd.endsWith('/claude-scratch') && b.args.includes('high'), 'brainstorm: scratch folder, high effort');
    for (const bad of ['/', home + '/nope', join(process.env.HOME!, '.openclaw')]) assert.match((await start!.execute('4', { task: 'try something bad', project: bad })).content[0]!.text, /^Not started/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
