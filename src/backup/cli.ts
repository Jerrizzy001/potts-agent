#!/usr/bin/env node
/**
 *   npm run backup                              online backup into $POTTS_HOME/backups (rotated)
 *   npm run backup -- --list                    list backups
 *   npm run restore -- <backup-dir> [--confirm] [--restore-config]
 *       without --confirm: dry run (prints what would change; nothing is replaced)
 *       the daemon must be stopped first: launchctl bootout gui/$(id -u)/local.potts.daemon
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../core/clock.ts';
import { resolvePottsHome } from '../store/home.ts';
import { openDatabase } from '../store/db.ts';
import { migrate } from '../store/migrate.ts';
import { createAuditLedger } from '../audit/ledger.ts';
import { loadDaemonConfig } from '../daemon/config.ts';
import { createBackup, listBackups } from './backup.ts';
import { restoreBackup } from './restore.ts';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { home: { type: 'string' }, confirm: { type: 'boolean', default: false }, 'restore-config': { type: 'boolean', default: false }, list: { type: 'boolean', default: false } },
  });
  const cmd = positionals[0];
  const home = values.home ?? resolvePottsHome();
  const dc = loadDaemonConfig(home);
  if (cmd === 'backup') {
    if (values.list) {
      for (const b of listBackups(dc.backup.absDir)) console.log(b);
      return 0;
    }
    const dbPath = join(home, 'potts.db');
    if (!existsSync(dbPath)) {
      console.error(`no database at ${dbPath}`);
      return 2;
    }
    // SQLite allows a consistent VACUUM INTO while the daemon runs (WAL mode).
    const db = openDatabase(dbPath);
    try {
      migrate(db, { clock: systemClock });
      const r = createBackup({ home, db, clock: systemClock, audit: createAuditLedger(db, systemClock), dir: dc.backup.absDir, keep: dc.backup.keep, configPath: dc.configPath, reason: 'manual' });
      if (!r.ok) {
        console.error(r.error.message);
        return 1;
      }
      console.log(`backup written: ${r.value.path}`);
      console.log(`audit head: seq ${r.value.manifest.auditHead.seq} ${r.value.manifest.auditHead.hash.slice(0, 16)}…`);
      console.log(`files: ${Object.keys(r.value.manifest.files).join(', ')}`);
      if (r.value.removed.length) console.log(`rotated out: ${r.value.removed.join(', ')}`);
      return 0;
    } finally {
      db.close();
    }
  }
  if (cmd === 'restore') {
    const target = positionals[1];
    if (!target) {
      console.error('usage: npm run restore -- <backup-dir> [--confirm] [--restore-config]');
      return 2;
    }
    const r = restoreBackup({ home, backupPath: target, clock: systemClock, confirm: values.confirm === true, restoreConfig: values['restore-config'] === true });
    if (!r.ok) {
      console.error(`restore refused: ${r.error.message}`);
      return 1;
    }
    const x = r.value;
    console.log(`${x.dryRun ? 'DRY RUN (nothing replaced; add --confirm)' : 'RESTORED'} from ${x.backupId} (${x.backupCreatedAt})`);
    console.log(`backup audit chain verified: ${x.backupAuditEntries} entries`);
    console.log(`previous head: ${x.previousHead ? `seq ${x.previousHead.seq}` : 'none'}`);
    console.log(`controls kept (pauses/revocations): ${x.controlsMerged.length ? x.controlsMerged.join(', ') : 'none needed'}`);
    console.log(`revoked account status kept: ${x.revokedStatusMerged.join(', ') || 'none'}`);
    console.log(`sent-operation records kept: ${x.sentRecordsMerged.length}`);
    console.log(`in-flight dispatches marked uncertain: ${x.dispatchesMarkedUncertain.length}`);
    console.log(`approvals expired (never revived): ${x.approvalsExpired}; waiting actions cancelled: ${x.actionsCancelled}`);
    console.log(`owner notifications dropped: ${x.notificationsDropped}; alert incidents cancelled: ${x.alertIncidentsCancelled}`);
    console.log(`memory tombstones re-applied (rows deleted again): ${x.tombstonesReapplied}`);
    if (x.movedPreviousTo) console.log(`previous database kept at: ${x.movedPreviousTo}`);
    if (x.configRestored.length) console.log(`config restored: ${x.configRestored.join(', ')} (policy.json is never restored)`);
    return 0;
  }
  console.error('usage: cli.ts backup [--list] | restore <backup-dir> [--confirm] [--restore-config]');
  return 2;
}

main().then((c) => process.exit(c), (e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
