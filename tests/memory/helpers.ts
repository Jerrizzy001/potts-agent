import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../../src/core/index.ts';
import { MIGRATIONS_DIR, migrate, openDatabase, type Db } from '../../src/store/index.ts';
import { createMemoryStore, type MemoryStore, type MemoryStoreOptions } from '../../src/memory/index.ts';

/**
 * Applies only the foundation (00xx) and WP-3 (02xx) migrations so these
 * tests do not depend on other packages' in-progress migrations.
 */
export function wp3MigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'potts-wp3-mig-'));
  for (const f of readdirSync(MIGRATIONS_DIR)) if (/^(00|02)\d\d_.*\.sql$/.test(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

export interface MemEnv {
  home: string;
  dbPath: string;
  db: Db;
  clock: FakeClock;
  memory: MemoryStore;
  journal: string;
  cleanup(): void;
}

export function memEnv(opts: Partial<Omit<MemoryStoreOptions, 'db' | 'clock'>> & { journal?: boolean } = {}): MemEnv {
  const home = mkdtempSync(join(tmpdir(), 'potts-wp3-home-'));
  mkdirSync(join(home, 'memory'), { recursive: true });
  const dbPath = join(home, 'potts.db');
  const db = openDatabase(dbPath);
  const clock = createFakeClock('2026-10-06T13:00:00.000Z');
  const migDir = wp3MigrationsDir();
  migrate(db, { dir: migDir, clock });
  rmSync(migDir, { recursive: true, force: true });
  const journal = join(home, 'memory', 'tombstones.jsonl');
  const { journal: useJournal, ...rest } = opts;
  const memory = createMemoryStore({ db, clock, ...(useJournal === false ? {} : { tombstoneJournalPath: journal }), ...rest });
  return {
    home,
    dbPath,
    db,
    clock,
    memory,
    journal,
    cleanup() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
