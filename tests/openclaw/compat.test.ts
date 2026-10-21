/** The plugin's self-contained crypto must stay wire-compatible with src/core + src/approvals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as plugin from '../../integrations/openclaw/potts-broker-plugin/lib/crypto.ts';
import { signOwnerIngress as pluginSign, ingressAuthResponse as pluginAuth, signOwnerControl } from '../../integrations/openclaw/potts-broker-plugin/lib/ingress.ts';
import { canonicalJson, hexEqual } from '../../src/core/hash.ts';
import { createIngressVerifier } from '../../src/approvals/ingress.ts';
import { ingressAuthResponse } from '../../src/broker/server.ts';
import { createFakeClock } from '../../src/core/clock.ts';
import { verifyOwnerControl } from '../../src/owner/index.ts';

const samples: unknown[] = [
  null, true, 0, -1.5, 'é\u0000"\\', [], {}, [1, 'a', null, { b: 2, a: 1 }], { z: { y: [3, { x: 'ü' }] }, a: undefined, m: new Date(0) },
  { type: 'approve', approvalId: 'apr_01K0000000000000000000000Z', bindingHash: 'a'.repeat(64) },
];

test('canonicalJson / hexEqual match src/core/hash.ts', () => {
  for (const s of samples) assert.equal(plugin.canonicalJson(s), canonicalJson(s));
  for (let i = 0; i < 200; i++) {
    const v = { n: Math.random(), s: randomBytes(8).toString('base64'), arr: [i, String(i)], nested: { k: i % 2 === 0 } };
    assert.equal(plugin.canonicalJson(v), canonicalJson(v));
  }
  assert.throws(() => plugin.canonicalJson(NaN));
  assert.equal(plugin.hexEqual('ab', 'AB'), hexEqual('ab', 'AB'));
});

test('a proof signed by the plugin verifies with the broker verifier; tampering breaks it', () => {
  const key = randomBytes(32);
  const clock = createFakeClock('2026-10-06T14:00:00.000Z');
  const v = createIngressVerifier({ key, ownerSenderId: '424242', clock });
  const fields = { source: 'telegram' as const, senderId: '424242', chatId: '424242', chatType: 'private' as const, updateId: 'cb:1', receivedAt: clock.nowIso(), intent: { type: 'pause_all' as const, reason: 'x' } };
  const proof = pluginSign(key, fields);
  assert.equal(v.verify(proof).ok, true);
  assert.equal(v.verify({ ...proof, intent: { type: 'resume', scope: 'global' } }).ok, false);
  assert.equal(v.verify(pluginSign(randomBytes(32), fields)).ok, false);
  assert.equal(pluginAuth(key, 'c'.repeat(64)), ingressAuthResponse(key, 'c'.repeat(64)));
});

test('owner-control proofs (memory forget) verify with src/owner and are domain-separated from ingress proofs', () => {
  const key = randomBytes(32);
  const clock = createFakeClock('2026-10-06T14:00:00.000Z');
  const p = signOwnerControl(key, { source: 'telegram', senderId: '424242', updateId: 'cmd:1', receivedAt: clock.nowIso(), control: { type: 'memory_forget', memoryId: 'm1' } });
  assert.equal(verifyOwnerControl(p, { key, ownerSenderId: '424242', clock, expectType: 'memory_forget' }).ok, true);
  assert.equal(verifyOwnerControl({ ...p, control: { type: 'memory_forget', memoryId: 'm2' } }, { key, ownerSenderId: '424242', clock }).ok, false);
  assert.equal(verifyOwnerControl(p, { key, ownerSenderId: '999', clock }).ok, false);
  const v = createIngressVerifier({ key, ownerSenderId: '424242', clock });
  assert.equal(v.verify({ ...p, chatId: '424242', chatType: 'private', intent: { type: 'pause_all' } }).ok, false);
});
