/** OwnerChannel: daemon -> plugin socket -> gateway Telegram delivery (fake deliver), and the CLI fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { startOwnerChannelServer, type OwnerDelivery } from '../../integrations/openclaw/potts-broker-plugin/lib/owner-channel.ts';
import { createOpenClawCliOwnerChannel, createPluginSocketOwnerChannel } from '../../src/owner/index.ts';
import { createFixture, SEND, TEST_OWNER_ID } from './fixture.ts';

test('owner channel starts before daemon creates run and refuses shared or symlink directories', async () => {
  const f = await createFixture();
  const dir = join(f.h.dir, 'r');
  const options = { socketPath: join(dir, 'oc.sock'), secrets: f.secrets,
    deliver: async () => ({ messageId: null }), approvalPrompt: (id: string) => f.owner.approvalPrompt(id) };
  try {
    const server = await startOwnerChannelServer(options);
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(options.socketPath).mode & 0o777, 0o600);
    await server.close();
    chmodSync(dir, 0o755);
    await assert.rejects(startOwnerChannelServer(options), /owner-only/);
    chmodSync(dir, 0o700);
    const target = join(f.h.dir, 'target'); mkdirSync(target, { mode: 0o700 });
    const link = join(f.h.dir, 'link'); symlinkSync(target, link);
    await assert.rejects(startOwnerChannelServer({ ...options, socketPath: join(link, 'oc.sock') }), /owner-only/);
  } finally { await f.close(); }
});

test('plugin socket: authenticated notify reaches only the owner; approval prompts carry exact content and bound buttons', async () => {
  const f = await createFixture();
  const delivered: OwnerDelivery[] = [];
  const socketPath = join(f.h.dir, 'owner-channel.sock');
  const server = await startOwnerChannelServer({ socketPath, secrets: f.secrets, deliver: async (d) => (delivered.push(d), { messageId: String(delivered.length) }), approvalPrompt: (id) => f.owner.approvalPrompt(id) });
  try {
    const ch = createPluginSocketOwnerChannel({ socketPath, key: f.h.key });
    const r = await ch.notify({ text: 'Morning brief ready' });
    assert.ok(r.ok);
    assert.deepEqual(delivered[0], { to: TEST_OWNER_ID, text: 'Morning brief ready', silent: false });
    const p = f.h.broker.propose(SEND, 'openclaw/potts');
    assert.ok(p.ok);
    const a = await ch.notifyApproval(p.value.approvalId!);
    assert.ok(a.ok);
    assert.equal(delivered[1]!.to, TEST_OWNER_ID);
    assert.match(delivered[1]!.text, /See you at 5/);
    assert.equal(delivered[1]!.presentation!.blocks.length, 2);
    assert.equal((await ch.notify({ text: 'x'.repeat(5000) })).ok, false);
    const wrong = createPluginSocketOwnerChannel({ socketPath, key: randomBytes(32) });
    const w = await wrong.notify({ text: 'spoof' });
    assert.equal(w.ok, false);
    assert.equal(delivered.length, 2);
  } finally {
    await server.close();
    await f.close();
  }
});

test('plugin socket: rate limit and unavailable socket', async () => {
  const f = await createFixture();
  const socketPath = join(f.h.dir, 'oc.sock');
  let n = 0;
  const server = await startOwnerChannelServer({ socketPath, secrets: f.secrets, deliver: async () => ({ messageId: String(++n) }), approvalPrompt: (id) => f.owner.approvalPrompt(id), maxPerMinute: 2 });
  try {
    const ch = createPluginSocketOwnerChannel({ socketPath, key: f.h.key });
    assert.ok((await ch.notify({ text: '1' })).ok);
    assert.ok((await ch.notify({ text: '2' })).ok);
    assert.equal((await ch.notify({ text: '3' })).ok, false);
    const gone = createPluginSocketOwnerChannel({ socketPath: join(f.h.dir, 'missing.sock'), key: f.h.key });
    assert.equal((await gone.notify({ text: 'x' })).ok, false);
  } finally {
    await server.close();
    await f.close();
  }
});

test('CLI fallback: fixed owner target, short text only, approval content never in argv', async () => {
  const calls: string[][] = [];
  const ch = createOpenClawCliOwnerChannel({ ownerChatId: TEST_OWNER_ID, openclawBin: '/bin/openclaw-fake', profile: 'potts-test', exec: async (_f, args) => (calls.push(args), { code: 0, stdout: '{"messageId":"77"}', stderr: '' }) });
  const r = await ch.notify({ text: 'Site down for 10 min' });
  assert.ok(r.ok && r.value.messageId === '77');
  assert.deepEqual(calls[0]!.slice(0, 8), ['--profile', 'potts-test', 'message', 'send', '--channel', 'telegram', '--target', TEST_OWNER_ID]);
  assert.equal((await ch.notify({ text: 'x'.repeat(400) })).ok, false);
  await ch.notifyApproval('apr_01K0000000000000000000000Z');
  assert.match(calls[1]!.join(' '), /Review it with \/papprove apr_/);
  assert.throws(() => createOpenClawCliOwnerChannel({ ownerChatId: '@someone', openclawBin: 'x' }));
});

test('post-dispatch timeout, thrown delivery and missing receipts remain uncertain through the real socket', async () => {
  const f = await createFixture();
  try {
    for (const mode of ['timeout', 'throw', 'missing', 'ack', 'id'] as const) {
      const socketPath = join(f.h.dir, `receipt-${mode}.sock`);
      let sends = 0;
      const server = await startOwnerChannelServer({ socketPath, secrets: f.secrets, approvalPrompt: id => f.owner.approvalPrompt(id), deliver: async () => {
        sends++;
        if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 100));
        if (mode === 'throw') throw new Error('connection lost after submission');
        return mode === 'ack' ? { messageId:null, accepted:true } : { messageId:mode === 'id' ? 'real-id' : null };
      } });
      try {
        const ch = createPluginSocketOwnerChannel({ socketPath, key:f.h.key, timeoutMs:mode === 'timeout' ? 30 : 1000 });
        const r = await ch.notify({ text:'test' });
        assert.equal(r.ok, mode === 'ack' || mode === 'id');
        if (!r.ok) assert.notEqual((r.error.details as {reason?:string})?.reason, 'unavailable', 'uncertainty must never become a retryable rejection');
        assert.equal(sends,1);
      } finally { await server.close(); }
    }
  } finally { await f.close(); }
});
