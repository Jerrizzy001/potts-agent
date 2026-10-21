import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeTools, type Spawner } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-task.ts';
import { REPORT_FALLBACK } from '../../integrations/openclaw/potts-broker-plugin/lib/report-relay.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';

function fixture(spawner: Spawner) {
  const home = mkdtempSync(join(tmpdir(), 'potts-cc-reliable-'));
  const project = join(home, 'project'); mkdirSync(project);
  const cli = join(home, 'claude'); writeFileSync(cli, '#!/bin/sh\n', { mode: 0o700 });
  const cfg = parsePluginConfig({ pottsHome: home, ownerTelegramId: '424242' }); assert.ok(cfg.ok);
  const tools = createClaudeTools(cfg.value, { get: async () => ({ ownerId: '424242', key: Buffer.alloc(32) }) },
    { controls: async () => ({ paused: false }), spawner, claudeCli: cli, openclawCli: '/test/openclaw', now: () => new Date('2026-10-07T14:00:00Z') });
  return { home, project, cli, start: tools[0]!, status: tools[1]!,
    launch: () => tools[0]!.execute('start', { task: 'Fix the synthetic fixture', kind: 'debugging', project }),
    close: () => rmSync(home, { recursive: true, force: true }) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const detail = (r: { details: unknown }) => r.details as { ok: boolean; jobId: string; job: { status: string; summary?: string; reportDelivery?: { status: string } } };

test('Claude launch errors are recorded and do not wedge every subsequent coding job', async () => {
  let fail = true;
  const f = fixture(() => { if (fail) throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); });
  try {
    const first = await f.launch();
    assert.equal(detail(first).ok, false);
    assert.equal(detail(await f.status.execute('status', {})).job.status, 'failed');
    fail = false;
    assert.equal(detail(await f.launch()).ok, true);
  } finally { f.close(); }
});

test('duplicate process completion signals produce one job report and one relay', async () => {
  let completion: (() => void) | undefined;
  let relays = 0;let sent = '';
  const f = fixture((cmd, args, o) => {
    if (cmd === '/test/openclaw') { relays++; sent=args[args.indexOf('-m')+1]!; return; }
    completion = () => { writeFileSync(o.outFile, JSON.stringify({ result: 'Synthetic fix verified.' })); o.onExit(0); };
  });
  try {
    await f.launch();
    completion!(); completion!();
    await flush();
    assert.equal(relays, 1);
    assert.equal(sent, REPORT_FALLBACK, 'legacy output is saved, never relayed as an unchecked completion claim');
    assert.equal(detail(await f.status.execute('status', {})).job.summary, 'Synthetic fix verified.');
  } finally { f.close(); }
});

test('two jobs finishing within the same second preserve both job records', async () => {
  let completion: (() => void) | undefined;
  const f = fixture((cmd, _args, o) => {
    if (cmd === '/test/openclaw') return;
    completion = () => { writeFileSync(o.outFile, JSON.stringify({ result: 'Synthetic fix verified.' })); o.onExit(0); };
  });
  try {
    const first = detail(await f.launch()).jobId;
    completion!(); await flush();
    const second = detail(await f.launch()).jobId;
    assert.notEqual(first, second);
    assert.equal(detail(await f.status.execute('status', { jobId: first })).job.status, 'done');
    assert.equal(detail(await f.status.execute('status', { jobId: second })).job.status, 'running');
  } finally { f.close(); }
});

test('missing Claude output records failure without throwing from the exit callback', async () => {
  let completion: (() => void) | undefined;
  const f = fixture((cmd, _args, o) => { if (cmd !== '/test/openclaw') completion = () => o.onExit(0); });
  try {
    await f.launch();
    assert.doesNotThrow(() => completion!());
    await flush();
    assert.equal(detail(await f.status.execute('status', {})).job.status, 'failed');
  } finally { f.close(); }
});

test('failed owner relay is visible separately from a successful Claude job', async () => {
  const f = fixture((cmd, _args, o) => {
    if (cmd === '/test/openclaw') { writeFileSync(o.outFile,'{"ok":false}'); o.onExit(1); return; }
    writeFileSync(o.outFile, JSON.stringify({ result: 'Synthetic fix verified.' })); o.onExit(0);
  });
  try {
    const r = await f.launch(); await flush();
    const job = detail(await f.status.execute('status', { jobId: detail(r).jobId })).job;
    assert.equal(job.status, 'done');
    assert.equal(job.reportDelivery?.status, 'failed');
  } finally { f.close(); }
});

test('Claude JSON is parsed independently of stderr diagnostics', async () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-cc-stdio-'));
  try {
    const project = join(home, 'project'); mkdirSync(project);
    const cli = join(home, 'claude');
    writeFileSync(cli, '#!/bin/sh\nprintf \'{"result":"Synthetic result survived diagnostics."}\\n\'\nsleep 0.05\nprintf \'diagnostic after stdout\\n\' >&2\n', { mode: 0o700 });
    const cfg = parsePluginConfig({ pottsHome: home, ownerTelegramId: '424242' }); assert.ok(cfg.ok);
    const tools = createClaudeTools(cfg.value, { get: async () => null }, { controls: async () => ({ paused: false }), claudeCli: cli });
    const r = detail(await tools[0]!.execute('start', { task: 'Check the synthetic fixture', kind: 'debugging', project }));
    let job: ReturnType<typeof detail>['job'] | undefined;
    for (let i = 0; i < 40; i++) {
      job = detail(await tools[1]!.execute('status', { jobId: r.jobId })).job;
      if (job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job?.status, 'done');
    assert.equal(job?.summary, 'Synthetic result survived diagnostics.');
    assert.equal(JSON.parse(readFileSync(join(home, 'claude-jobs', r.jobId, 'output.json'), 'utf8')).result, job?.summary);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a real subprocess launch failure is never reported as a started Claude job', async () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-cc-launch-'));
  try {
    const project = join(home, 'project'); mkdirSync(project);
    const cli = join(home, 'claude'); writeFileSync(cli, '#!/potts-harness-no-such-interpreter\n', { mode: 0o700 });
    const cfg = parsePluginConfig({ pottsHome: home, ownerTelegramId: '424242' }); assert.ok(cfg.ok);
    const tools = createClaudeTools(cfg.value, { get: async () => null }, { controls: async () => ({ paused: false }), claudeCli: cli });
    const r = await tools[0]!.execute('start', { task: 'Check the synthetic fixture', kind: 'debugging', project });
    assert.equal(detail(r).ok, false);
    assert.match(r.content[0]!.text, /^Not started/);
    assert.equal(detail(await tools[1]!.execute('status', {})).job.status, 'failed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('failed Claude execution persists the exact selected owner update despite a model success claim', async () => {
  const rawReport = JSON.stringify({version:1,outcome:'completed',ownerMessage:'Everything is ready. The checks passed.',detailedReport:'FULL_MODEL_EVIDENCE'});
  let completion = () => {}; let sent = '';
  const f = fixture((cmd, args, o) => {
    if (cmd === '/test/openclaw') {
      if (args[0] === 'message') { sent = args[args.indexOf('-m')+1]!; writeFileSync(o.outFile,'{"ok":true}'); }
      o.onExit(0); return;
    }
    completion = () => { writeFileSync(o.outFile, JSON.stringify({result:rawReport,is_error:true})); o.onExit(1); };
  });
  try {
    await f.launch(); completion(); await flush();
    const {job} = (await f.status.execute('status', {})).details as {job:{status:string;reportedOutcome:string;ownerMessage:string;rawReport:string;summary:string;reportDelivery:{status:string}}};
    assert.equal(job.status,'failed'); assert.equal(job.reportedOutcome,'completed', 'model report is not execution proof');
    assert.equal(job.rawReport,rawReport); assert.equal(job.summary,'FULL_MODEL_EVIDENCE');
    assert.equal(job.ownerMessage,sent); assert.match(sent,/couldn’t confirm/); assert.ok(!sent.includes('Everything is ready'));
    assert.equal(job.reportDelivery.status,'delivered', 'delivery success does not turn failed execution into success');
  } finally { f.close(); }
});

test('direct Claude admission rejects key/token briefs before persisting or launching work', async () => {
  let launches=0;
  const f=fixture(()=>{launches++;});
  try {
    for(const task of ['Use api_key=' + 'sk-' + 'abcdefghijklmnopqrstuv' + ' to debug the connection', 'Use token=' + 'abcdef' + '1234567890 to inspect this project']) {
      const r=await f.start.execute('direct',{task,kind:'debugging',project:f.project});
      assert.equal(detail(r).ok,false);assert.match(r.content[0]!.text,/key or token/);
    }
    assert.equal(launches,0);
    assert.equal((await f.status.execute('status',{})).content[0]!.text,'No Claude jobs yet.');
    const allowed=await f.start.execute('direct',{task:'Use the login password the owner gave: ordinary-login-example',kind:'debugging',project:f.project});
    assert.equal(detail(allowed).ok,false,'login passwords are rejected before delegation');assert.equal(launches,0);
  } finally {f.close();}
});
