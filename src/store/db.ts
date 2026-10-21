import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

export type Db = DatabaseSync;

/**
 * Opens a SQLite database with WAL journaling, foreign keys and a busy
 * timeout. File databases are chmod 0600. Pass ":memory:" for tests that do
 * not need reopen semantics.
 */
export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = FULL;');
  if (path !== ':memory:') {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort; directory is 0700 anyway */
    }
  }
  return db;
}

let savepointSeq = 0;
/**
 * Runs fn inside a transaction (SAVEPOINT, so it nests). Rolls back on throw.
 * fn must be synchronous: node:sqlite is synchronous and an await inside would
 * let other work interleave with an open transaction.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const name = `sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error('withTransaction: fn must be synchronous');
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw e;
  }
}
