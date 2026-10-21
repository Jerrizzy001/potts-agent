import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngressVerifier } from '../../src/approvals/ingress.ts';
import { verifyOwnerControl } from '../../src/owner/owner-control.ts';
import { signOwnerIngress, signOwnerControl } from '../../integrations/openclaw/potts-broker-plugin/lib/ingress.ts';
const key = Buffer.alloc(32, 3);
const ownerSenderId = '+14165550199';
test('iMessage signed intents retain channel, owner, MAC and private-chat boundaries', () => {
 const fields = { source: 'imessage' as const, senderId: ownerSenderId, chatId: ownerSenderId, chatType: 'private' as const, updateId: 'cmd:1', receivedAt: new Date().toISOString(), intent: { type: 'pause_all' as const } };
 const proof = signOwnerIngress(key, fields);
 const verifier = createIngressVerifier({ key, ownerSenderId, source: 'imessage' });
 assert.equal(verifier.verify(proof).ok, true);
 assert.equal(createIngressVerifier({ key, ownerSenderId }).verify(proof).ok, false);
 for (const over of [{ source: 'telegram' as const }, { senderId: '+14165550198' }, { chatId: 'group:1' }]) assert.equal(verifier.verify(signOwnerIngress(key, { ...fields, ...over })).ok, false);
 assert.equal(verifier.verify({ ...proof, intent: { type: 'resume', scope: 'global' } }).ok, false);
});
test('iMessage memory controls bind configured source and owner', () => {
 const proof = signOwnerControl(key, { source: 'imessage', senderId: ownerSenderId, updateId: 'cmd:2', receivedAt: new Date().toISOString(), control: { type: 'memory_remember', text: 'test preference' } });
 assert.equal(verifyOwnerControl(proof, { key, ownerSenderId, source: 'imessage', expectType: 'memory_remember' }).ok, true);
 assert.equal(verifyOwnerControl(proof, { key, ownerSenderId }).ok, false);
 assert.equal(verifyOwnerControl(proof, { key, ownerSenderId: '+14165550198', source: 'imessage' }).ok, false);
});
