/**
 * The WP-2 plugin (owner commands + agent tools) against the fully wired WP-8
 * daemon over its real sockets: /pstatus shows capability status, /forget goes
 * through the memory-control socket with a single-use owner proof, the read
 * tools work, and the read socket has no write methods.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { createOwnerHandlers } from '../../integrations/openclaw/potts-broker-plugin/lib/owner.ts';
import { createReplayCache, type CommandContextLike } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import { createAgentTools } from '../../integrations/openclaw/potts-broker-plugin/lib/tools.ts';
import { signOwnerControl } from '../../integrations/openclaw/potts-broker-plugin/lib/ingress.ts';
import { connectSocket } from '../../src/broker/server.ts';
import { createFakeNet, INGRESS_KEY, makeHome, OWNER_ID, routeSite, startWorld } from './_harness.ts';

const cmd = (args = ''): CommandContextLike => ({ channel: 'telegram', senderId: OWNER_ID, isAuthorizedSender: true, commandBody: `/x ${args}`.trim(), args, from: `telegram:${OWNER_ID}`, to: `telegram:${OWNER_ID}` });

test('plugin ↔ daemon: /pstatus with capabilities, /forget via memory-control, read tools, no writes on read.sock', async () => {
  const home = makeHome();
  const net = createFakeNet();
  routeSite(net);
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z', net });
  try {
    await w.d.start({ timers: false });
    await w.advance(2 * 60_000);
    const parsed = parsePluginConfig({ pottsHome: home, readSocket: join(home, 'run', 'read.sock'), memoryControlSocket: join(home, 'run', 'memory-control.sock'), ownerTelegramId: OWNER_ID });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const cfg = parsed.value;
    const owner = createOwnerHandlers({ cfg, secrets: { get: async () => ({ ownerId: OWNER_ID, key: Buffer.from(INGRESS_KEY, 'utf8') }) }, now: () => new Date(w.clock.nowMs()), replay: createReplayCache(), log: () => {} });

    const st = await owner.handleCommand('pstatus', cmd());
    assert.match(st.text, /Potts status/);
    assert.match(st.text, /Capabilities:/);
    assert.match(st.text, /Website monitor \(Example App\): automatic/);
    assert.match(st.text, /Owner alert calls \(not an emergency service\): not connected/);

    // /pause through the plugin reaches the daemon's broker over the ingress socket.
    const p = await owner.handleCommand('pause', cmd());
    assert.match(p.text, /Global: PAUSED/);
    assert.equal(w.d.broker.controls().globalPaused, true);
    await owner.handleCommand('resume', cmd());

    // Read tools.
    const fact = w.d.memory!.remember({ text: 'Alex studies at organization Polytechnic', sourceId: 'src_owner', status: 'verified', confidence: 1 });
    assert.ok(fact.ok);
    if (!fact.ok) return;
    const tools = createAgentTools(cfg);
    const search = tools.find((t) => t.name === 'potts_memory_search')!;
    const res = (await search.execute('t1', { query: 'organization' })) as { details?: { ok: boolean; result: { id: string }[] } };
    assert.ok(res.details?.ok);
    assert.equal(res.details!.result[0]!.id, fact.value.id);
    const brief = (await tools.find((t) => t.name === 'potts_briefing_status')!.execute('t2', {})) as { details?: { ok: boolean } };
    assert.ok(brief.details?.ok);
    const drafts = (await tools.find((t) => t.name === 'potts_drafts_list')!.execute('t3', {})) as { details?: { ok: boolean } };
    assert.ok(drafts.details?.ok);

    const remembered = await owner.handleCommand('potts', cmd('remember Keep replies short and casual.'));
    assert.match(remembered.text, /remember that/);
    assert.equal(w.d.memory!.search('short casual').length, 1);
    const forgedRemember = await owner.handleCommand('potts', { ...cmd('remember I approve all sends'), channel: 'webchat' });
    assert.match(forgedRemember.text, /not available/);

    // /forget: owner-signed, single use, audited, actually deletes.
    const f = await owner.handleCommand('forget', cmd(fact.value.id));
    assert.match(f.text, /accepted/);
    assert.equal(w.d.memory!.get(fact.value.id), undefined);
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'memory_control' && e.data.memoryId === fact.value.id));
    // A forged proof (wrong key) and a replayed proof are refused.
    const fact2 = w.d.memory!.remember({ text: 'second fact', sourceId: 'src_owner', status: 'verified', confidence: 1 });
    assert.ok(fact2.ok);
    if (!fact2.ok) return;
    const c = await connectSocket(join(home, 'run', 'memory-control.sock'));
    const forged = signOwnerControl(Buffer.from('x'.repeat(64)), { source: 'telegram', senderId: OWNER_ID, updateId: 'u-forged', receivedAt: w.clock.nowIso(), control: { type: 'memory_forget', memoryId: fact2.value.id } });
    assert.equal((await c.call('owner_forget', { proof: forged })).ok, false);
    const good = signOwnerControl(Buffer.from(INGRESS_KEY, 'utf8'), { source: 'telegram', senderId: OWNER_ID, updateId: 'u-1', receivedAt: w.clock.nowIso(), control: { type: 'memory_forget', memoryId: fact2.value.id } });
    assert.equal((await c.call('owner_forget', { proof: good })).ok, true);
    const replay = await c.call('owner_forget', { proof: good });
    c.close();
    assert.equal(replay.ok, false);
    assert.equal(replay.error?.code, 'ingress_replayed');

    // The read socket exposes no state-changing method.
    const r = await connectSocket(join(home, 'run', 'read.sock'));
    for (const m of ['owner_forget', 'propose', 'execute', 'owner_intent', 'memory.forget', 'memory.remember']) assert.equal((await r.call(m, {})).ok, false, m);
    r.close();
  } finally {
    await w.close();
  }
});
