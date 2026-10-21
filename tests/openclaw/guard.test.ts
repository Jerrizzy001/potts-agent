import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOwnerCallback, checkOwnerCommand, createReplayCache } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import { parseCallbackPayload, callbackData, verifyApprovalCode } from '../../integrations/openclaw/potts-broker-plugin/lib/nonce.ts';
import { ownerCallback, ownerCmd, STRANGER_ID, TEST_OWNER_ID } from './fixture.ts';

test('command guard: only the owner, on Telegram, in the private chat, host-authorized, not an internal caller', () => {
  assert.equal(checkOwnerCommand(ownerCmd(), TEST_OWNER_ID).ok, true);
  const bad: [string, ReturnType<typeof ownerCmd>, string | null][] = [
    ['non-owner sender', ownerCmd('', { senderId: STRANGER_ID, from: `telegram:${STRANGER_ID}` }), TEST_OWNER_ID],
    ['owner in a group chat', ownerCmd('', { from: 'telegram:group:-100123' }), TEST_OWNER_ID],
    ['owner in a forum topic of a group', ownerCmd('', { from: 'telegram:group:-100123:topic:7' }), TEST_OWNER_ID],
    ['other channel (webchat)', ownerCmd('', { channel: 'webchat' }), TEST_OWNER_ID],
    ['internal gateway caller', ownerCmd('', { gatewayClientScopes: ['operator.write'] }), TEST_OWNER_ID],
    ['not host-authorized', ownerCmd('', { isAuthorizedSender: false }), TEST_OWNER_ID],
    ['missing sender', ownerCmd('', { senderId: undefined }), TEST_OWNER_ID],
    ['owner id not configured', ownerCmd(), null],
    ['sender id spoof with from mismatch', ownerCmd('', { from: `telegram:${STRANGER_ID}` }), TEST_OWNER_ID],
  ];
  for (const [name, ctx, owner] of bad) assert.equal(checkOwnerCommand(ctx, owner).ok, false, name);
});

test('callback guard: rejects non-owner, group, forum, other chat, unauthorized, missing callback id', () => {
  assert.equal(checkOwnerCallback(ownerCallback('a:x'), TEST_OWNER_ID).ok, true);
  const base = ownerCallback('a:x');
  const bad = [
    { ...base, senderId: STRANGER_ID },
    { ...base, isGroup: true },
    { ...base, isForum: true },
    { ...base, callback: { ...base.callback, chatId: '-100123' } },
    { ...base, auth: { isAuthorizedSender: false } },
    { ...base, channel: 'discord' },
    { ...base, callbackId: '' },
  ];
  for (const ctx of bad) assert.equal(checkOwnerCallback(ctx, TEST_OWNER_ID).ok, false);
});

test('callback payload parsing: missing nonce, malformed ids and extra parts are rejected', () => {
  const id = 'apr_01K0000000000000000000000Z';
  assert.deepEqual(parseCallbackPayload(`a:${id}`), { ok: false, reason: 'missing_nonce' });
  assert.deepEqual(parseCallbackPayload(`a:${id}:`), { ok: false, reason: 'missing_nonce' });
  assert.equal(parseCallbackPayload(`a:${id}:0123456789abcdef:extra`).ok, false);
  assert.equal(parseCallbackPayload(`x:${id}:0123456789abcdef`).ok, false);
  assert.equal(parseCallbackPayload(`a:apr_short:0123456789abcdef`).ok, false);
  assert.equal(parseCallbackPayload(`a:${id}:0123456789ABCDEF`).ok, false);
  assert.equal(parseCallbackPayload(`a:${id}:0123456789abcdef`).ok, true);
});

test('approval codes are bound to key, action, approval id and binding hash; callback data fits Telegram 64 bytes', () => {
  const key = Buffer.alloc(32, 7);
  const id = 'apr_01K0000000000000000000000Z';
  const data = callbackData(key, 'a', id, 'b'.repeat(64));
  assert.ok(Buffer.byteLength(data) <= 64, data);
  const code = data.split(':')[3]!;
  assert.equal(verifyApprovalCode(key, 'a', id, 'b'.repeat(64), code), true);
  assert.equal(verifyApprovalCode(key, 'd', id, 'b'.repeat(64), code), false);
  assert.equal(verifyApprovalCode(key, 'a', id, 'c'.repeat(64), code), false);
  assert.equal(verifyApprovalCode(Buffer.alloc(32, 8), 'a', id, 'b'.repeat(64), code), false);
});

test('replay cache refuses a repeated update reference', () => {
  const r = createReplayCache(3);
  assert.equal(r.claim('cb:1'), true);
  assert.equal(r.claim('cb:1'), false);
});

test('iMessage commands accept only configured owner private inbound context', () => {
  const id = '+14165550199';
  const ctx = ownerCmd('help', { channel: 'imessage', senderId: id, from: `imessage:${id}` });
  assert.equal(checkOwnerCommand(ctx, id, 'imessage').ok, true);
  for (const over of [{ senderId: '+14165550198' }, { from: 'imessage:group:2' }, { isGroup: true }, { isForwarded: true }, { isAuthorizedSender: false }, { gatewayClientScopes: ['operator.write'] }, { channel: 'telegram' }]) assert.equal(checkOwnerCommand({ ...ctx, ...over }, id, 'imessage').ok, false);
});
