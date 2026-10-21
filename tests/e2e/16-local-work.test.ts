import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createAgentTools } from '../../integrations/openclaw/potts-broker-plugin/lib/tools.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { makeHome, startWorld, gmailAccount } from './_harness.ts';
import { runCheck } from '../../src/daemon/check.ts';

const START = '2026-10-07T14:00:00Z';
test('local script proposal -> daemon saves once -> model reads; forged scopes/paths and paused reads are blocked', async () => {
  const home = makeHome({ potts: c => { (c.monitoring as Record<string, unknown>).enabled = false; } });
  const w = await startWorld({ home, start: START });
  try {
    await w.d.start({ timers: false });
    const cfg = parsePluginConfig({ pottsHome: home, readSocket: join(home, 'run', 'read.sock'), ownerTelegramId: '424242' });
    assert.ok(cfg.ok); if (!cfg.ok) return;
    const tools = createAgentTools(cfg.value);
    const propose = tools.find(t => t.name === 'potts_propose_action')!;
    const content = tools.find(t => t.name === 'potts_read_content')!;
    const input = { kind: 'draft', scope: { taskId: 'owner-local-drafts' }, payload: { format: 'document', filename: 'hello.py', title: 'Example script', body: 'print("hello")\n' } };
    const r = await propose.execute('save', input);
    const result = r.details as { ok: boolean; actionId: string; status: string };
    assert.ok(result.ok); assert.equal(result.status, 'ready');
    await w.advance(30_000);
    assert.equal(w.d.broker.status(result.actionId)!.status, 'succeeded');
    const draft = w.d.drafts!.forAction(result.actionId)!;
    assert.ok(draft.filePath.endsWith('/hello.py'));
    assert.equal(readFileSync(join(w.d.drafts!.dir, draft.filePath), 'utf8'), input.payload.body);
    const read = await content.execute('read', { kind: 'draft', id: draft.id });
    assert.equal((read.details as { result: { content: string } }).result.content, input.payload.body);
    await w.restart();
    assert.equal(w.d.drafts!.forAction(result.actionId)!.id, draft.id);
    assert.ok((await w.d.broker.execute(result.actionId)).ok);
    assert.equal(w.d.drafts!.list().length, 1);
    for (const scope of [{ taskId: 'forged' }, { taskId: 'owner-local-drafts', projectId: 'exampleapp' }, { taskId: 'owner-local-drafts', sourceIds: ['private'] }]) {
      const bad = w.d.broker.propose({ ...input, scope }, 'openclaw/potts');
      assert.ok(bad.ok && bad.value.status === 'held');
    }
    const bad = w.d.broker.propose({ ...input, payload: { ...input.payload, filename: '../../escape.py' } }, 'openclaw/potts');
    assert.ok(bad.ok); if (bad.ok) { await w.advance(30_000); assert.equal(w.d.broker.status(bad.value.actionId)!.status, 'failed'); }
    assert.equal(w.d.drafts!.list().length, 1);
    assert.ok(w.owner({ type: 'pause_all' }).ok);
    await w.d.start({ timers: false });
    const pausedRead = await content.execute('paused', { kind: 'draft', id: draft.id });
    assert.equal((pausedRead.details as { ok: boolean }).ok, false);
    assert.equal(w.net.log.length, 0, 'saving files never contacts a provider');
  } finally { await w.close(); }
});

test('readiness uses live capabilities instead of claiming a running daemon is down', async () => {
  const home = makeHome({ potts: c => { (c.monitoring as Record<string, unknown>).enabled = false; } });
  const w = await startWorld({ home, start: START });
  try {
    await w.d.start({ timers: false });
    const r = await runCheck({ home, clock: w.clock, secrets: { keychainLookup: async (s, a) => w.keychain.get(`${s}/${a}`) ?? Promise.reject(new Error('missing')) } });
    assert.match(r.text, /Capabilities \(live daemon view\)/);
    assert.doesNotMatch(r.text, /daemon not running|runtime not verified/);
  } finally { await w.close(); }
});
