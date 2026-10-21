/** Plugin owner commands and approval buttons against a real broker over the real ingress socket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackData } from '../../integrations/openclaw/potts-broker-plugin/lib/nonce.ts';
import { NOT_AVAILABLE } from '../../integrations/openclaw/potts-broker-plugin/lib/owner.ts';
import { createFixture, ownerCallback, ownerCmd, SEND, STRANGER_ID } from './fixture.ts';

async function pending(f: Awaited<ReturnType<typeof createFixture>>, input: unknown = SEND) {
  const r = f.h.broker.propose(input, 'openclaw/potts');
  assert.ok(r.ok);
  assert.equal(r.value.status, 'awaiting_approval');
  return r.value as { actionId: string; approvalId: string; bindingHash: string };
}

test('/pause, /resume, /pstatus, /approvals from the owner reach the broker', async () => {
  const f = await createFixture();
  try {
    let r = await f.owner.handleCommand('pause', ownerCmd());
    assert.match(r.text, /Global: PAUSED/);
    assert.equal(f.h.broker.controls().globalPaused, true);
    r = await f.owner.handleCommand('pause', ownerCmd('gmail'));
    assert.deepEqual(f.h.broker.controls().pausedIntegrations, ['gmail']);
    r = await f.owner.handleCommand('resume', ownerCmd('gmail'));
    r = await f.owner.handleCommand('resume', ownerCmd());
    assert.equal(f.h.broker.controls().globalPaused, false);
    assert.deepEqual(f.h.broker.controls().pausedIntegrations, []);
    await pending(f);
    r = await f.owner.handleCommand('pstatus', ownerCmd());
    assert.match(r.text, /Pending approvals: 1/);
    r = await f.owner.handleCommand('approvals', ownerCmd());
    assert.match(r.text, /send_message via gmail-personal → bob@example.com/);
    r = await f.owner.handleCommand('potts', ownerCmd('status'));
    assert.match(r.text, /Potts status/);
    r = await f.owner.handleCommand('pause', ownerCmd('Bad Name!'));
    assert.match(r.text, /Integration names/);
  } finally {
    await f.close();
  }
});

test('non-owner, group chat, other channel and internal callers change nothing', async () => {
  const f = await createFixture();
  try {
    for (const ctx of [
      ownerCmd('', { senderId: STRANGER_ID, from: `telegram:${STRANGER_ID}` }),
      ownerCmd('', { from: 'telegram:group:-1001' }),
      ownerCmd('', { channel: 'webchat' }),
      ownerCmd('', { gatewayClientScopes: ['operator.admin'] }),
      ownerCmd('', { isAuthorizedSender: false }),
    ]) {
      const r = await f.owner.handleCommand('pause', ctx);
      assert.equal(r.text, NOT_AVAILABLE);
    }
    assert.equal(f.h.broker.controls().globalPaused, false);
    assert.ok(f.logs.some((l) => l.event === 'owner_command_rejected' && l.data.reason === 'not_owner'));
  } finally {
    await f.close();
  }
});

test('missing secrets (owner id / ingress key) fail closed', async () => {
  const f = await createFixture({ secretsNull: true });
  try {
    assert.equal((await f.owner.handleCommand('pause', ownerCmd())).text, NOT_AVAILABLE);
    assert.equal(f.h.broker.controls().globalPaused, false);
  } finally {
    await f.close();
  }
});

test('/papprove shows the exact preview with bound buttons; a wrong code is refused; the right code approves once', async () => {
  const f = await createFixture();
  try {
    const p = await pending(f);
    const review = await f.owner.handleCommand('papprove', ownerCmd(p.approvalId));
    assert.match(review.text, /See you at 5/);
    assert.match(review.text, /owner@example.com/);
    assert.match(review.text, /bob@example.com/);
    const buttons = review.presentation!.blocks.find((b) => b.type === 'buttons') as { buttons: { action: { value: string } }[] };
    assert.equal(buttons.buttons[0]!.action.value, callbackData(f.h.key, 'a', p.approvalId, p.bindingHash));
    const code = /\/papprove \S+ ([0-9a-f]{16})/.exec(review.text)![1]!;
    assert.match((await f.owner.handleCommand('papprove', ownerCmd(`${p.approvalId} 0123456789abcdef`))).text, /does not match/);
    assert.equal(f.h.broker.status(p.actionId)!.status, 'awaiting_approval');
    const ok = await f.owner.handleCommand('papprove', ownerCmd(`${p.approvalId} ${code}`));
    assert.match(ok.text, /^Approved/);
    assert.equal(f.h.broker.status(p.actionId)!.status, 'ready');
    const again = await f.owner.handleCommand('papprove', ownerCmd(`${p.approvalId} ${code}`));
    assert.match(again.text, /is approved; nothing to approve/);
    const ex = await f.h.broker.execute(p.actionId);
    assert.ok(ex.ok && ex.value.status === 'succeeded');
    assert.equal(f.h.mailExec.calls, 1);
  } finally {
    await f.close();
  }
});

test('approve button: valid press approves; replayed press, missing nonce, forged nonce, non-owner and group presses do not', async () => {
  const f = await createFixture();
  try {
    const p = await pending(f);
    const data = callbackData(f.h.key, 'a', p.approvalId, p.bindingHash).slice('potts:'.length);
    for (const ctx of [
      ownerCallback(`a:${p.approvalId}`),
      ownerCallback(`a:${p.approvalId}:${'0'.repeat(16)}`),
      ownerCallback(callbackData(Buffer.alloc(32, 1), 'a', p.approvalId, p.bindingHash).slice(6)),
      ownerCallback(data, { senderId: STRANGER_ID }),
      ownerCallback(data, { isGroup: true }),
      ownerCallback(data, { callback: { data: `potts:${data}`, namespace: 'potts', payload: data, messageId: 1, chatId: '-1009' } }),
    ]) {
      const r = await f.owner.handleCallback(ctx);
      assert.equal(r.clearButtons, false);
    }
    assert.equal(f.h.broker.status(p.actionId)!.status, 'awaiting_approval');
    const press = ownerCallback(data);
    const ok = await f.owner.handleCallback(press);
    assert.match(ok.reply.text, /^Approved/);
    assert.equal(ok.clearButtons, true);
    // Same Telegram callback id again: refused by the plugin's cache ...
    assert.match((await f.owner.handleCallback(press)).reply.text, /already handled/);
    // ... and by the broker's single-use update table after a gateway restart (empty cache).
    const p2 = await pending(f, { ...SEND, destination: ['carol@example.com'] });
    const data2 = callbackData(f.h.key, 'a', p2.approvalId, p2.bindingHash).slice(6);
    const reused = ownerCallback(data2, { callbackId: press.callbackId });
    const r2 = await f.freshOwner().handleCallback(reused);
    assert.match(r2.reply.text, /already used/);
    assert.equal(f.h.broker.status(p2.actionId)!.status, 'awaiting_approval');
    const rows = f.h.broker.audit.list({ limit: 200 }).filter((e: { type: string }) => e.type === 'ingress_rejected');
    assert.ok(rows.length >= 1, 'replay is audited');
  } finally {
    await f.close();
  }
});

test('deny button and /deny close the approval and cancel the action', async () => {
  const f = await createFixture();
  try {
    const p = await pending(f);
    const r = await f.owner.handleCallback(ownerCallback(callbackData(f.h.key, 'd', p.approvalId, p.bindingHash).slice(6)));
    assert.match(r.reply.text, /Denied/);
    assert.equal(f.h.broker.status(p.actionId)!.status, 'cancelled');
    const q = await pending(f, { ...SEND, payload: { body: 'other' } });
    assert.match((await f.owner.handleCommand('deny', ownerCmd(`${q.approvalId} not now`))).text, /Denied|already/);
    const c = await pending(f, { ...SEND, payload: { body: 'third' } });
    assert.match((await f.owner.handleCommand('cancel', ownerCmd(c.actionId))).text, /Cancelled/);
  } finally {
    await f.close();
  }
});

test('a button issued for one version stops working after the action is revised (changed payload)', async () => {
  const f = await createFixture();
  try {
    const p = await pending(f);
    const old = callbackData(f.h.key, 'a', p.approvalId, p.bindingHash).slice(6);
    const rev = f.h.broker.revise(p.actionId, { ...SEND, payload: { body: 'Actually, wire me $5000' } }, 'openclaw/potts');
    assert.ok(rev.ok);
    const r = await f.owner.handleCallback(ownerCallback(old));
    assert.notEqual(f.h.broker.status(p.actionId)!.status, 'ready');
    assert.doesNotMatch(r.reply.text, /^Approved/);
    // The new approval needs its own code bound to the new binding.
    const live = f.h.broker.approvals.live(p.actionId)!;
    assert.notEqual(live.bindingHash, p.bindingHash);
    const stale = await f.owner.handleCallback(ownerCallback(`a:${live.id}:${old.split(':')[2]}`));
    assert.match(stale.reply.text, /no longer matches/);
  } finally {
    await f.close();
  }
});

test('/revoke blocks dispatch of an approved action; /forget is a pending interface', async () => {
  const f = await createFixture();
  try {
    const p = await pending(f);
    f.h.approve(p.actionId);
    assert.match((await f.owner.handleCommand('revoke', ownerCmd('gmail-personal lost phone'))).text, /Revoked accounts: gmail-personal/);
    const ex = await f.h.broker.execute(p.actionId);
    assert.equal(ex.ok, false);
    assert.equal(f.h.mailExec.calls, 0);
    assert.match((await f.owner.handleCommand('forget', ownerCmd('mem_123'))).text, /not connected yet/);
    assert.match((await f.owner.handleCommand('potts', ownerCmd('reinstate gmail-personal'))).text, /Revoked accounts: none/);
  } finally {
    await f.close();
  }
});

test('broker unreachable: commands report it and change nothing', async () => {
  const f = await createFixture();
  try {
    for (const s of f.servers) await s.close();
    f.servers.length = 0;
    assert.match((await f.owner.handleCommand('pause', ownerCmd())).text, /not running/);
  } finally {
    await f.close();
  }
});
