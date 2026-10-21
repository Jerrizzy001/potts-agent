import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryReceiptAccepted } from '../../integrations/openclaw/potts-broker-plugin/lib/delivery-receipt.ts';

test('recognizes modern iMessage receipts and rejects partial, wrong-target, dry-run and failed deliveries', () => {
  const channel = 'imessage', target = '+14165550123';
  const valid = { action: 'send', channel, dryRun: false, messageId: 'apple-guid', payload: { channel, to: target, deliveryStatus: 'sent', payloadOutcomes: [{ status: 'sent' }] } };
  const accepts = (v: unknown) => deliveryReceiptAccepted(JSON.stringify(v), channel, target);
  assert.equal(accepts(valid), true);
  assert.equal(accepts({...valid,messageId:'unknown'}),false);
  assert.equal(accepts({...valid,messageId:'  '}),false);
  assert.equal(accepts({...valid,messageId:'ok'}),true);
  assert.equal(accepts({ ...valid, dryRun: true }), false);
  assert.equal(accepts({ ...valid, sentBeforeError: true }), false);
  assert.equal(accepts({ ...valid, error: 'timeout' }), false);
  assert.equal(accepts({ ...valid, payload: { ...valid.payload, to: '+14165550456' } }), false);
  assert.equal(accepts({ ...valid, payload: { ...valid.payload, payloadOutcomes: [{ status: 'sent' }, { status: 'failed' }] } }), false);
  assert.equal(accepts({ ...valid, payload: { ...valid.payload, deliveryStatus: 'failed' } }), false);
  assert.equal(accepts({ ok: true }), true);
  for (const bad of [{ok:true,messageId:'unknown'},{ok:true,deliveryStatus:'pending'},{ok:true,deliveryStatus:'failed'},{...valid,ok:true,channel:'telegram'},{...valid,ok:true,payload:{...valid.payload,to:'wrong'}},{...valid,ok:true,payload:{...valid.payload,payloadOutcomes:[{status:'sent'},{status:'failed'}]}}]) assert.equal(accepts(bad),false);
  assert.equal(accepts({...valid,ok:true}),true);
  assert.equal(accepts({ ok: false }), false);
  assert.equal(deliveryReceiptAccepted('log says "ok": true', channel, target), false);
});
