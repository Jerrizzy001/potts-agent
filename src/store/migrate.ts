import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';
import { sha256Hex } from '../core/hash.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { PottsError } from '../core/result.ts';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sha256: string;
  sql: string;
}

export function listMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new PottsError('migration_failed', `migration file name must be NNNN_name.sql: ${f}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    out.push({ version: Number(m[1]), name: m[2]!, path: join(dir, f), sha256: sha256Hex(sql), sql });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version) throw new PottsError('migration_failed', `duplicate migration version ${out[i]!.version}`);
  }
  return out;
}

/**
 * Applies pending migrations in version order, each in its own transaction,
 * recording them in schema_migrations. Already-applied migrations whose file
 * content changed are rejected (migrations are immutable once applied).
 * Returns the versions applied by this call.
 */
export function migrate(db: Db, opts: { dir?: string; clock?: Clock } = {}): number[] {
  const clock = opts.clock ?? systemClock;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map<number, string>();
  for (const row of db.prepare('SELECT version, sha256 FROM schema_migrations').all() as { version: number; sha256: string }[]) {
    applied.set(row.version, row.sha256);
  }
  const done: number[] = [];
  for (const m of listMigrations(opts.dir)) {
    const prev = applied.get(m.version);
    if (prev !== undefined) {
      if (prev !== m.sha256) throw new PottsError('migration_failed', `migration ${String(m.version).padStart(4, "0")}_${m.name} was modified after being applied`);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(m.version, m.name, m.sha256, clock.nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new PottsError('migration_failed', `migration ${String(m.version).padStart(4, "0")}_${m.name} failed: ${(e as Error).message}`);
    }
    done.push(m.version);
  }
  return done;
}
