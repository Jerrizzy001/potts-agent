import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from '../../src/broker/testing.ts';
import { createAuditLedger } from '../../src/audit/index.ts';
import { openDatabase, migrate } from '../../src/store/index.ts';
import { createFakeClock } from '../../src/core/index.ts';

async function busyHarness() {
  const h = createTestHarness();
  const p = h.broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { body: 'hi' } }, 'openclaw');
  assert.ok(p.ok);
  assert.ok(h.approve(p.value.actionId).ok);
  await h.broker.execute(p.value.actionId);
  h.owner.handle(h.sign({ type: 'pause_all' }));
  h.owner.handle(h.sign({ type: 'resume', scope: 'global' }));
  h.owner.handle(h.sign({ type: 'revoke_account', accountId: 'gmail-work' }));
  h.owner.handle({ forged: true });
  return { h, actionId: p.value.actionId };
}

test('audit records the whole lifecycle and the chain verifies', async () => {
  const { h, actionId } = await busyHarness();
  try {
    const types = h.broker.audit.list({ limit: 1000 }).map((e) => e.type);
    for (const t of ['action_proposed', 'policy_decision', 'approval_requested', 'approval_granted', 'approval_consumed', 'dispatch_intent', 'dispatch_receipt', 'pause', 'resume', 'revocation', 'ingress_rejected'])
      assert.ok(types.includes(t as never), t);
    const v = h.broker.audit.verify();
    assert.ok(v.ok);
    // Audit stores hashes, not bodies.
    const prop = h.broker.audit.list({ actionId }).find((e) => e.type === 'action_proposed')!;
    assert.ok(!JSON.stringify(prop.data).includes('"hi"'));
    assert.match(String(prop.data.payloadHash), /^[0-9a-f]{64}$/);
  } finally {
    h.close();
  }
});

test('audit log is append-only at the DB level', async () => {
  const { h } = await busyHarness();
  try {
    assert.throws(() => h.db.exec("UPDATE audit_log SET actor = 'x' WHERE seq = 1"), /append-only/);
    assert.throws(() => h.db.exec('DELETE FROM audit_log WHERE seq = 1'), /append-only/);
  } finally {
    h.close();
  }
});

test('tampering (edit, delete, reorder, re-hash one row) is detected', async () => {
  for (const attack of ['edit', 'delete', 'rehash', 'forge_prev'] as const) {
    const { h } = await busyHarness();
    try {
      // Attacker with file access drops the triggers first.
      h.db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
      if (attack === 'edit') h.db.exec("UPDATE audit_log SET data_json = '{\"outcome\":\"allow\"}' WHERE seq = 2");
      if (attack === 'delete') h.db.exec('DELETE FROM audit_log WHERE seq = 3');
      if (attack === 'rehash') h.db.exec("UPDATE audit_log SET actor = 'owner', hash = '" + 'a'.repeat(64) + "' WHERE seq = 2");
      if (attack === 'forge_prev') h.db.exec("UPDATE audit_log SET prev_hash = '" + '0'.repeat(64) + "' WHERE seq = 4");
      const v = h.broker.audit.verify();
      assert.equal(v.ok, false, attack);
    } finally {
      h.close();
    }
  }
});

test('audit data is redacted defensively', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const ledger = createAuditLedger(db, createFakeClock());
  const e = ledger.append({ type: 'pause', actor: 'test', data: { botToken: 'secret-value', reason: 'ok' } });
  assert.equal(e.data.botToken, '[REDACTED]');
  assert.ok(ledger.verify().ok);
  assert.throws(() => ledger.append({ type: 'nope' as never, actor: 'x' }));
});
