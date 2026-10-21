/**
 * Restore from a backup without replaying anything (plan Phase 8: "Restore must
 * not replay sends, revive revoked credentials or reactivate expired approvals").
 *
 * The daemon must be stopped. The backup DB is copied to a scratch file,
 * migrated, its audit chain verified, then made safe BEFORE it replaces the
 * live DB:
 *   1. Revocations and pauses are authoritative: every runtime control row in the
 *      current DB and in the latest audit-head journal record is merged in.
 *      Provider-side revoked account status rows are merged too. (OAuth tokens
 *      live in the Keychain and are never restored, so a revoked grant stays gone.)
 *   2. Sent-operation records are authoritative: every dispatch in the current DB
 *      that may have reached a provider (dispatching/succeeded/uncertain/
 *      reconciled_sent) is copied in (with its action and approval rows), and the
 *      action takes the current DB's status; "dispatching" becomes "uncertain".
 *   3. No dispatch is left in flight: dispatching → uncertain (reconcile before retry).
 *   4. No approval is revived: every pending/approved approval is expired, and
 *      every action still waiting (held / awaiting_approval / ready) is cancelled.
 *      The owner proposes again if still wanted.
 *   5. Pending owner notifications are dropped; active alert-call incidents cancelled.
 *   6. Memory tombstones from the current DB and the journal are re-applied.
 *   7. A `restore` audit entry records the backup id/head and the previous head.
 * The old DB files are moved to restore-previous/<time>/ (never deleted).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { openDatabase, withTransaction, type Db } from '../store/db.ts';
import { migrate } from '../store/migrate.ts';
import { createAuditLedger } from '../audit/ledger.ts';
import { createApprovalStore } from '../approvals/store.ts';
import { createMemoryStore } from '../memory/store.ts';
import { readTombstoneJournal } from '../memory/tombstones.ts';
import type { Tombstone } from '../memory/types.ts';
import { appendAuditHead, lastAuditHead, readAuditHeads } from '../daemon/audit-head.ts';
import { daemonRunning } from '../daemon/daemon.ts';
import { MANIFEST, verifyBackup, type BackupManifest } from './backup.ts';

export interface RestoreReport {
  backupId: string;
  backupCreatedAt: string;
  dryRun: boolean;
  backupAuditEntries: number;
  previousHead: { seq: number; hash: string } | null;
  controlsMerged: string[];
  revokedStatusMerged: string[];
  sentRecordsMerged: string[];
  dispatchesMarkedUncertain: string[];
  approvalsExpired: number;
  actionsCancelled: number;
  notificationsDropped: number;
  alertIncidentsCancelled: number;
  tombstonesReapplied: number;
  configRestored: string[];
  movedPreviousTo: string | null;
}

type Row = Record<string, unknown>;
const SENT_STATES = ['dispatching', 'succeeded', 'uncertain', 'reconciled_sent'];

function copyRow(src: Db, dst: Db, table: string, where: string, ...args: (string | number)[]): number {
  const rows = src.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args) as Row[];
  let n = 0;
  for (const r of rows) {
    const cols = Object.keys(r);
    const res = dst.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(cols.map((c) => r[c]) as (string | number | null)[]));
    n += Number(res.changes);
  }
  return n;
}

function updateRow(src: Db, dst: Db, table: string, id: string): void {
  const r = src.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  if (!r) return;
  const cols = Object.keys(r).filter((c) => c !== 'id');
  dst.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(cols.map((c) => r[c]) as (string | number | null)[]), id);
}

export function controlsRows(db: Db): { scope: string; state: 'paused' | 'revoked'; reason: string | null; setBy: string; setAt: string }[] {
  return (db.prepare('SELECT scope, state, reason, set_by, set_at FROM controls ORDER BY scope').all() as { scope: string; state: 'paused' | 'revoked'; reason: string | null; set_by: string; set_at: string }[])
    .map((r) => ({ scope: r.scope, state: r.state, reason: r.reason, setBy: r.set_by, setAt: r.set_at }));
}

export interface RestoreOptions {
  home: string;
  backupPath: string;
  clock: Clock;
  confirm: boolean;
  /** Also restore potts.json/accounts.json/projects.json (never policy.json, which is owner-edited). Default false. */
  restoreConfig?: boolean;
  /** Ignore the daemon lock (tests that stopped the daemon in-process). */
  ignoreLock?: boolean;
}

export function restoreBackup(o: RestoreOptions): Result<RestoreReport> {
  const v = verifyBackup(o.backupPath);
  if (!v.ok) return v;
  const manifest: BackupManifest = v.value;
  const bdir = o.backupPath.endsWith(MANIFEST) ? dirname(o.backupPath) : o.backupPath;
  if (!o.ignoreLock) {
    const pid = daemonRunning(o.home);
    if (pid) return perr('action_state', `the Potts daemon is running (pid ${pid}); stop it first (launchctl bootout gui/$(id -u)/local.potts.daemon)`);
  }
  const livePath = join(o.home, 'potts.db');
  const scratch = join(o.home, `potts.db.restoring-${process.pid}`);
  for (const s of ['', '-wal', '-shm']) rmSync(scratch + s, { force: true });
  copyFileSync(join(bdir, 'potts.db'), scratch);
  const report: RestoreReport = {
    backupId: manifest.id, backupCreatedAt: manifest.createdAt, dryRun: !o.confirm, backupAuditEntries: 0, previousHead: null, controlsMerged: [],
    revokedStatusMerged: [], sentRecordsMerged: [], dispatchesMarkedUncertain: [], approvalsExpired: 0, actionsCancelled: 0, notificationsDropped: 0,
    alertIncidentsCancelled: 0, tombstonesReapplied: 0, configRestored: [], movedPreviousTo: null,
  };
  let rdb: Db | null = null;
  let cur: Db | null = null;
  try {
    rdb = openDatabase(scratch);
    migrate(rdb, { clock: o.clock });
    const raudit = createAuditLedger(rdb, o.clock);
    const ver = raudit.verify();
    if (!ver.ok) return perr('invalid_input', `backup audit chain is broken at seq ${ver.brokenAtSeq}: ${ver.reason}; refusing to restore`);
    report.backupAuditEntries = ver.entries;

    if (existsSync(livePath)) {
      try {
        cur = openDatabase(livePath);
        migrate(cur, { clock: o.clock });
        const h = cur.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
        report.previousHead = h ?? null;
      } catch {
        cur = null; // live DB unreadable (the reason to restore): fall back to the journals
      }
    }
    const journalHead = lastAuditHead(o.home);
    if (!report.previousHead && journalHead) report.previousHead = { seq: journalHead.seq, hash: journalHead.hash };

    const approvals = createApprovalStore(rdb, raudit, o.clock);
    const now = o.clock.nowIso();
    const db = rdb;
    withTransaction(db, () => {
      // 1. controls (current DB rows + latest journal snapshot; never removes a restored pause/revocation)
      const ctl: { scope: string; state: string; reason: string | null; set_by: string; set_at: string }[] = [];
      if (cur) ctl.push(...(cur.prepare('SELECT * FROM controls').all() as typeof ctl));
      else {
        // Live DB unreadable: the latest exported controls snapshot is the best record of pauses/revocations.
        const heads = readAuditHeads(o.home).filter((r) => r.kind !== 'backup');
        for (const c of heads[heads.length - 1]?.controls ?? []) ctl.push({ scope: c.scope, state: c.state, reason: c.reason, set_by: c.setBy, set_at: c.setAt });
      }
      for (const c of ctl) {
        const existing = db.prepare('SELECT state FROM controls WHERE scope = ?').get(c.scope) as { state: string } | undefined;
        if (existing && (existing.state === 'revoked' || existing.state === c.state)) continue;
        db.prepare('INSERT INTO controls (scope, state, reason, set_by, set_at) VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET state = excluded.state, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at')
          .run(c.scope, c.state, c.reason, c.set_by, c.set_at);
        raudit.append({ type: c.state === 'revoked' ? 'revocation' : 'pause', actor: 'system:restore', data: { scope: c.scope, reason: `kept from pre-restore state: ${c.reason ?? ''}`.trim() } });
        report.controlsMerged.push(`${c.scope}=${c.state}`);
      }
      if (cur) {
        for (const r of cur.prepare("SELECT * FROM connector_accounts WHERE status = 'revoked'").all() as Row[]) {
          const mine = db.prepare('SELECT status FROM connector_accounts WHERE account_id = ?').get(r.account_id as string) as { status: string } | undefined;
          if (mine?.status === 'revoked') continue;
          db.prepare('DELETE FROM connector_accounts WHERE account_id = ?').run(r.account_id as string);
          copyRow(cur, db, 'connector_accounts', 'account_id = ?', r.account_id as string);
          report.revokedStatusMerged.push(String(r.account_id));
        }
      }
      // 2. sent-operation records from the current DB
      if (cur) {
        const sent = cur.prepare(`SELECT * FROM dispatches WHERE state IN (${SENT_STATES.map(() => '?').join(',')})`).all(...SENT_STATES) as Row[];
        for (const d of sent) {
          const actionId = d.action_id as string;
          const curAction = cur.prepare('SELECT status FROM actions WHERE id = ?').get(actionId) as { status: string } | undefined;
          if (!db.prepare('SELECT 1 FROM actions WHERE id = ?').get(actionId)) copyRow(cur, db, 'actions', 'id = ?', actionId);
          else updateRow(cur, db, 'actions', actionId); // the sent revision is the truth
          if (d.approval_id && !db.prepare('SELECT 1 FROM approvals WHERE id = ?').get(d.approval_id as string)) copyRow(cur, db, 'approvals', 'id = ?', d.approval_id as string);
          if (d.approval_id) db.prepare("UPDATE approvals SET status = 'used', used_at = COALESCE(used_at, ?), used_by_dispatch = ? WHERE id = ?").run(now, d.id as string, d.approval_id as string);
          const mine = db.prepare('SELECT state FROM dispatches WHERE id = ?').get(d.id as string) as { state: string } | undefined;
          const state = d.state === 'dispatching' ? 'uncertain' : (d.state as string);
          if (!mine) {
            // Remove a backup-era attempt of the same action that would violate the one-possible-send invariant.
            db.prepare(`DELETE FROM dispatches WHERE action_id = ? AND id != ? AND state IN (${SENT_STATES.map(() => '?').join(',')})`).run(actionId, d.id as string, ...SENT_STATES);
            db.prepare('DELETE FROM dispatches WHERE action_id = ? AND attempt = ? AND id != ?').run(actionId, d.attempt as number, d.id as string);
            copyRow(cur, db, 'dispatches', 'id = ?', d.id as string);
          }
          db.prepare('UPDATE dispatches SET state = ?, updated_at = ? WHERE id = ?').run(state, now, d.id as string);
          const st = state === 'uncertain' ? 'uncertain' : 'succeeded';
          db.prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?').run(curAction?.status === 'succeeded' ? 'succeeded' : st, now, actionId);
          if (!mine || mine.state !== state) report.sentRecordsMerged.push(`${actionId}:${state}`);
        }
      }
      // 3. nothing left in flight
      for (const r of db.prepare("SELECT id, action_id FROM dispatches WHERE state = 'dispatching'").all() as { id: string; action_id: string }[]) {
        db.prepare("UPDATE dispatches SET state = 'uncertain', error = 'restored from backup while in flight', updated_at = ? WHERE id = ?").run(now, r.id);
        db.prepare("UPDATE actions SET status = 'uncertain', updated_at = ? WHERE id = ?").run(now, r.action_id);
        raudit.append({ type: 'recovery', actor: 'system:restore', actionId: r.action_id, data: { dispatchId: r.id, result: 'marked_uncertain' } });
        report.dispatchesMarkedUncertain.push(r.action_id);
      }
      // 4. no revived approvals; nothing waiting is carried forward
      for (const a of db.prepare("SELECT id FROM approvals WHERE status IN ('pending','approved')").all() as { id: string }[]) {
        const r = approvals.close(a.id, 'expired', 'system:restore', `restored from backup ${manifest.id}; approvals are never revived`);
        if (r.ok) report.approvalsExpired++;
      }
      for (const a of db.prepare("SELECT id FROM actions WHERE status IN ('held','awaiting_approval','ready')").all() as { id: string }[]) {
        db.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, a.id);
        raudit.append({ type: 'action_cancelled', actor: 'system:restore', actionId: a.id, data: { reason: `restored from backup ${manifest.id}; propose again if still wanted` } });
        report.actionsCancelled++;
      }
      // 5. stale owner notifications and call incidents
      report.notificationsDropped = Number(db.prepare("UPDATE owner_notifications SET status = 'dropped', drop_reason = 'restored from backup', updated_at = ? WHERE status = 'pending'").run(now).changes);
      db.prepare("UPDATE owner_notifications SET status = 'uncertain', updated_at = ? WHERE status = 'sending'").run(now);
      report.alertIncidentsCancelled = Number(db.prepare("UPDATE owner_alert_incidents SET status = 'cancelled', status_reason = 'restored from backup', pending_action_id = NULL, updated_at = ? WHERE status = 'active'").run(now).changes);
    });

    // 6. memory tombstones: current DB + journal (outside the transaction: the store runs its own + checkpoint)
    const tomb: Omit<Tombstone, 'seq'>[] = [];
    if (cur) {
      for (const r of cur.prepare('SELECT * FROM memory_tombstones ORDER BY seq').all() as Row[])
        tomb.push({ entity: r.entity as Tombstone['entity'], entityId: String(r.entity_id), contentHash: (r.content_hash as string) ?? null, sourceId: (r.source_id as string) ?? null, reason: String(r.reason), receiptId: String(r.receipt_id), deletedAt: String(r.deleted_at) });
    }
    tomb.push(...readTombstoneJournal(join(o.home, 'memory', 'tombstones.jsonl')).tombstones);
    if (tomb.length) {
      const mem = createMemoryStore({ db, clock: o.clock });
      const rec = mem.reapplyTombstones(tomb);
      report.tombstonesReapplied = rec.counts.facts + rec.counts.factVersions + rec.counts.styleCorpus + rec.counts.styleExamples + rec.counts.sourcesRevoked;
    }
    // 7. audit entry
    raudit.append({
      type: 'restore', actor: 'system:restore',
      data: {
        backupId: manifest.id, backupCreatedAt: manifest.createdAt, backupHead: manifest.auditHead, previousHead: report.previousHead,
        controlsMerged: report.controlsMerged.length, sentRecordsMerged: report.sentRecordsMerged.length, approvalsExpired: report.approvalsExpired,
        actionsCancelled: report.actionsCancelled, dryRun: !o.confirm,
      },
    });
    const finalHead = raudit.head();
    const finalControls = controlsRows(db);
    if (!o.confirm) return ok(report);

    // Swap in: move the previous DB aside (never delete), then the restored file.
    cur?.close();
    cur = null;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    rdb = null;
    const prevDir = join(o.home, 'restore-previous', o.clock.nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'));
    mkdirSync(prevDir, { recursive: true, mode: 0o700 });
    for (const s of ['', '-wal', '-shm']) if (existsSync(livePath + s)) renameSync(livePath + s, join(prevDir, `potts.db${s}`));
    report.movedPreviousTo = existsSync(join(prevDir, 'potts.db')) ? prevDir : null;
    renameSync(scratch, livePath);
    for (const s of ['-wal', '-shm']) rmSync(scratch + s, { force: true });
    if (o.restoreConfig) {
      for (const name of ['potts.json', 'accounts.json', 'projects.json']) {
        const src = join(bdir, 'config', name);
        if (!existsSync(src)) continue;
        const dst = join(o.home, name);
        if (existsSync(dst)) copyFileSync(dst, join(prevDir, name));
        writeFileSync(dst, readFileSync(src), { mode: 0o600 });
        report.configRestored.push(name);
      }
    }
    appendAuditHead(o.home, { at: o.clock.nowIso(), kind: 'restore', seq: finalHead.seq, hash: finalHead.hash, controls: finalControls });
    return ok(report);
  } catch (e) {
    return perr('internal', `restore failed: ${(e as Error).message}`);
  } finally {
    try {
      cur?.close();
    } catch {
      /* closed */
    }
    try {
      rdb?.close();
    } catch {
      /* closed */
    }
    if (existsSync(scratch)) for (const s of ['', '-wal', '-shm']) rmSync(scratch + s, { force: true });
  }
}
