/**
 * Backups: a directory per backup under $POTTS_HOME/backups (0700) holding
 *   potts.db                 consistent snapshot via SQLite `VACUUM INTO`
 *                            (with secure_delete, forgotten rows are not carried over)
 *   config/<name>.json       potts.json, accounts.json, projects.json, policy.json (as found)
 *   memory/tombstones.jsonl  memory deletion journal (content-free)
 *   audit-heads.jsonl        exported audit heads (+ controls snapshots)
 *   manifest.json            sha256 + size of every file, audit head, schema migrations, time
 * Every file is 0600. Rotation keeps the newest `keep` backups.
 *
 * Backups contain no secrets (the config holds only secret references and
 * tokens live in the Keychain), but they do contain personal data and
 * memory items forgotten after the backup was taken, until they rotate out.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Db } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import type { AuditLedger } from '../audit/ledger.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { appendAuditHead, auditHeadsPath } from '../daemon/audit-head.ts';

export const BACKUP_PREFIX = 'potts-backup-';
export const MANIFEST = 'manifest.json';

export interface BackupManifest {
  format: 'potts-backup/v1';
  id: string;
  createdAt: string;
  reason: string;
  auditHead: { seq: number; hash: string };
  migrations: string[];
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
  removed: string[];
}

export function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function configFiles(configPath: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [{ name: 'potts.json', path: configPath }];
  if (!existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { accountsFile?: string; projects?: { file?: string }; policy?: { file?: string } };
    const rel = (f: string | undefined) => (f ? (isAbsolute(f) ? f : resolve(dirname(configPath), f)) : null);
    for (const [name, p] of [['accounts.json', rel(raw.accountsFile)], ['projects.json', rel(raw.projects?.file)], ['policy.json', rel(raw.policy?.file)]] as const)
      if (p && existsSync(p)) out.push({ name, path: p });
  } catch {
    /* unparseable config: back up potts.json only */
  }
  return out;
}

export interface CreateBackupOptions {
  home: string;
  /** Open handle on the live DB (the daemon's), or a path to open read-only-ish. */
  db: Db;
  clock: Clock;
  audit?: AuditLedger;
  dir: string;
  keep: number;
  configPath: string;
  reason: string;
}

export function createBackup(o: CreateBackupOptions): Result<BackupResult> {
  try {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
    const createdAt = o.clock.nowIso();
    let name = `${BACKUP_PREFIX}${stamp(createdAt)}`;
    for (let n = 2; existsSync(join(o.dir, name)); n++) name = `${BACKUP_PREFIX}${stamp(createdAt)}-${n}`;
    const out = join(o.dir, name);
    mkdirSync(out, { mode: 0o700 });
    // Record the backup in the audit log first, so the snapshot contains its own entry.
    o.audit?.append({ type: 'backup', actor: 'system:backup', data: { id: name, reason: o.reason } });
    const head = (o.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined) ?? { seq: 0, hash: '0'.repeat(64) };
    const migrations = (o.db.prepare('SELECT name FROM schema_migrations ORDER BY version').all() as { name: string }[]).map((r) => r.name);
    const dbOut = join(out, 'potts.db');
    o.db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
    const files: BackupManifest['files'] = {};
    const add = (rel: string) => {
      const p = join(out, rel);
      chmodSync(p, 0o600);
      files[rel] = { sha256: sha256File(p), bytes: statSync(p).size };
    };
    add('potts.db');
    mkdirSync(join(out, 'config'), { mode: 0o700 });
    for (const f of configFiles(o.configPath)) {
      copyFileSync(f.path, join(out, 'config', f.name));
      add(`config/${f.name}`);
    }
    const tomb = join(o.home, 'memory', 'tombstones.jsonl');
    if (existsSync(tomb)) {
      mkdirSync(join(out, 'memory'), { mode: 0o700 });
      copyFileSync(tomb, join(out, 'memory', 'tombstones.jsonl'));
      add('memory/tombstones.jsonl');
    }
    if (existsSync(auditHeadsPath(o.home))) {
      copyFileSync(auditHeadsPath(o.home), join(out, 'audit-heads.jsonl'));
      add('audit-heads.jsonl');
    }
    const manifest: BackupManifest = { format: 'potts-backup/v1', id: name, createdAt, reason: o.reason, auditHead: head, migrations, files };
    writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const controls = (o.db.prepare('SELECT scope, state, reason, set_by, set_at FROM controls ORDER BY scope').all() as { scope: string; state: 'paused' | 'revoked'; reason: string | null; set_by: string; set_at: string }[])
      .map((r) => ({ scope: r.scope, state: r.state, reason: r.reason, setBy: r.set_by, setAt: r.set_at }));
    appendAuditHead(o.home, { at: createdAt, kind: 'backup', seq: head.seq, hash: head.hash, controls });
    const removed = rotateBackups(o.dir, o.keep);
    return ok({ path: out, manifest, removed });
  } catch (e) {
    return perr('internal', `backup failed: ${(e as Error).message}`);
  }
}

export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(BACKUP_PREFIX) && existsSync(join(dir, n, MANIFEST)))
    .sort()
    .map((n) => join(dir, n));
}

/** Keeps the newest `keep` backups; removes older ones. Returns removed paths. */
export function rotateBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  const old = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
  for (const p of old) rmSync(p, { recursive: true, force: true });
  return old.map((p) => basename(p));
}

export type VerifyBackup = Result<BackupManifest>;

/** Checks the manifest and every file's sha256. */
export function verifyBackup(path: string): VerifyBackup {
  const dir = path.endsWith(MANIFEST) ? dirname(path) : path;
  const mp = join(dir, MANIFEST);
  if (!existsSync(mp)) return perr('not_found', `${mp} not found`);
  let m: BackupManifest;
  try {
    m = JSON.parse(readFileSync(mp, 'utf8')) as BackupManifest;
  } catch (e) {
    return perr('invalid_input', `manifest unreadable: ${(e as Error).message}`);
  }
  if (m.format !== 'potts-backup/v1' || !m.files?.['potts.db']) return perr('invalid_input', 'not a Potts backup manifest');
  for (const [rel, f] of Object.entries(m.files)) {
    const p = join(dir, rel);
    if (!existsSync(p)) return perr('invalid_input', `backup file missing: ${rel}`);
    if (sha256File(p) !== f.sha256) return perr('invalid_input', `backup file corrupted: ${rel} (sha256 mismatch)`);
  }
  return ok(m);
}
