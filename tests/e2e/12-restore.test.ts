/**
 * Evidence: "Restore from backup" → revocations and sent-operation records
 * remain authoritative; no resurrected approvals; forgotten memory stays
 * forgotten; the audit chain verifies and records the restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, restoreBackup, verifyBackup } from '../../src/backup/index.ts';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, sendPayload, startWorld, tokenSetFor } from './_harness.ts';

test('E2E-12 restore keeps revocations and sent records, revives no approval, keeps forgets, verifies the audit chain', async () => {
  const start = '2026-10-07T15:00:00Z';
  const home = makeHome({
    accounts: [gmailAccount('approval_required'), gmailAccount('approval_required', 'gmail-work')],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      c.writers = { accounts: [{ accountId: 'gmail-personal', enabled: true }] };
    },
  });
  const net = createFakeNet();
  const gmail = routeGmail(net);
  const exp = '2026-10-12T00:00:00Z';
  const w = await startWorld({
    home, start, net, keychain: { 'potts/google-oauth-client-secret': 'cs' },
    tokens: {
      'gmail-personal': tokenSetFor('google', start, { accessTokenExpiresAt: exp }),
      'gmail-personal.send': tokenSetFor('google', start, { scope: 'https://www.googleapis.com/auth/gmail.send', accessTokenExpiresAt: exp }),
    },
  });
  try {
    markConnected(w, 'gmail-personal', 'google');
    markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send');
    const mem = w.d.memory!;
    const fact = mem.remember({ text: 'Alex prefers morning meetings', sourceId: 'src_owner', status: 'verified', confidence: 1 });
    assert.ok(fact.ok);
    // State at backup time: S and R approved but not yet dispatched (held by an integration pause), P pending approval.
    const S = w.d.broker.propose(sendPayload('bob@example.com', 'Approved before backup, sent after'), 'openclaw/potts');
    const R = w.d.broker.propose(sendPayload('rita@example.com', 'Approved before backup, never sent'), 'openclaw/potts');
    assert.ok(S.ok && R.ok);
    w.owner({ type: 'pause_integration', integration: 'gmail', reason: 'hold' });
    assert.ok(w.approve(S.value.actionId).ok);
    assert.ok(w.approve(R.value.actionId).ok);
    const P = w.d.broker.propose(sendPayload('pat@example.com', 'Pending at backup'), 'openclaw/potts');
    assert.ok(P.ok && P.value.status === 'held');
    w.owner({ type: 'resume', scope: 'integration:gmail' });
    await w.d.broker.execute(P.value.actionId); // re-decides → requests the approval (pending)
    const pApproval = w.d.broker.approvals.live(P.value.actionId)!;
    assert.equal(pApproval.status, 'pending');
    w.owner({ type: 'pause_integration', integration: 'gmail', reason: 'hold' });
    w.clock.advanceMs(60_000);
    const b = createBackup({ home, db: w.d.db, clock: w.clock, audit: w.d.audit, dir: join(home, 'backups'), keep: 3, configPath: join(home, 'potts.json'), reason: 'test' });
    assert.ok(b.ok, b.ok ? '' : b.error.message);
    assert.ok(verifyBackup(b.value.path).ok);
    assert.equal(statSync(join(b.value.path, 'potts.db')).mode & 0o777, 0o600);
    assert.equal(statSync(b.value.path).mode & 0o777, 0o700);

    // After the backup: S is sent, R is cancelled by the owner, gmail-work is revoked, the fact is forgotten.
    w.clock.advanceMs(60_000);
    w.owner({ type: 'cancel_action', actionId: R.value.actionId, reason: 'changed my mind' });
    w.owner({ type: 'resume', scope: 'integration:gmail' });
    await w.advance(30_000, 15_000);
    assert.equal(gmail.sent.length, 1);
    assert.equal(w.d.broker.getAction(S.value.actionId)!.status, 'succeeded');
    w.owner({ type: 'revoke_account', accountId: 'gmail-work', reason: 'compromised' });
    assert.ok(mem.forget(fact.value.id).ok);
    const whileRunning = restoreBackup({ home, backupPath: b.value.path, clock: w.clock, confirm: true });
    assert.ok(!whileRunning.ok && /daemon is running/.test(whileRunning.error.message), 'restore refuses while the daemon runs');
    await w.d.stop('maintenance');

    // Restore refuses while a daemon holds the lock, dry-runs without --confirm, then restores.
    const dry = restoreBackup({ home, backupPath: b.value.path, clock: w.clock, confirm: false });
    assert.ok(dry.ok && dry.value.dryRun);
    const r = restoreBackup({ home, backupPath: b.value.path, clock: w.clock, confirm: true });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    const rep = r.value;
    assert.ok(rep.controlsMerged.includes('account:gmail-work=revoked'));
    assert.ok(rep.sentRecordsMerged.some((x) => x.startsWith(S.value.actionId)));
    assert.ok(rep.approvalsExpired >= 1);
    assert.ok(rep.tombstonesReapplied >= 1);
    assert.ok(rep.movedPreviousTo && existsSync(join(rep.movedPreviousTo, 'potts.db')), 'previous DB kept, not deleted');

    // Start Potts on the restored DB and let it run.
    await w.restart();
    await w.advance(30 * 60_000, 60_000);
    // Sent record authoritative: S is succeeded and was never re-sent.
    assert.equal(w.d.broker.getAction(S.value.actionId)!.status, 'succeeded');
    assert.equal(gmail.sent.length, 1, 'no replayed send');
    // R (approved at backup time, cancelled after) and P (pending at backup time) are not revived.
    assert.equal(w.d.broker.getAction(R.value.actionId)!.status, 'cancelled');
    assert.equal(w.d.broker.getAction(P.value.actionId)!.status, 'cancelled');
    assert.equal(w.d.broker.approvals.get(pApproval.id)!.status, 'expired');
    assert.equal(w.d.broker.approvals.listPending().length, 0);
    // Revocation authoritative.
    assert.deepEqual(w.d.broker.controls().revokedAccounts, ['gmail-work']);
    // Forget authoritative.
    assert.equal(w.d.memory!.get(fact.value.id), undefined);
    // Audit chain verifies, the restore is recorded, and the exported-head check accepts the new baseline.
    assert.equal(w.d.audit.verify().ok, true);
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'restore'));
    assert.equal(w.d.runtime().problems.audit, undefined);
    assert.equal(w.d.broker.controls().globalPaused, false);
  } finally {
    await w.close();
  }
});

test('E2E-12b a tampered backup is refused; truncating the audit log is detected at startup and pauses everything', async () => {
  const start = '2026-10-07T15:00:00Z';
  const home = makeHome({ potts: (c) => { (c.monitoring as Record<string, unknown>).enabled = false; } });
  const w = await startWorld({ home, start });
  try {
    w.owner({ type: 'pause_all', reason: 'x' });
    w.owner({ type: 'resume', scope: 'global' });
    const b = createBackup({ home, db: w.d.db, clock: w.clock, audit: w.d.audit, dir: join(home, 'backups'), keep: 3, configPath: join(home, 'potts.json'), reason: 'test' });
    assert.ok(b.ok);
    // Tamper with the backup's config copy → checksum mismatch → refused.
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(b.value.path, 'config', 'potts.json'), ' ');
    const r = restoreBackup({ home, backupPath: b.value.path, clock: w.clock, confirm: true, ignoreLock: true });
    assert.equal(r.ok, false);
    // Real truncation while the daemon is stopped: drop the append-only trigger and cut the newest entries.
    await w.d.stop('maintenance');
    const { openDatabase } = await import('../../src/store/db.ts');
    const db = openDatabase(join(home, 'potts.db'));
    db.exec('DROP TRIGGER audit_log_no_delete');
    db.exec('DELETE FROM audit_log WHERE seq > (SELECT MAX(seq) - 3 FROM audit_log)');
    db.close();
    await w.restart();
    assert.match(w.d.runtime().problems.audit ?? '', /truncated/);
    assert.equal(w.d.broker.controls().globalPaused, true, 'integrity failure pauses all actions');
    assert.ok(w.d.audit.list({ limit: 1000 }).some((e) => e.type === 'integrity_alert'));
  } finally {
    await w.close();
  }
});
