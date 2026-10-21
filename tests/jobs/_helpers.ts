import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../../src/core/clock.ts';
import { openDatabase, type Db } from '../../src/store/db.ts';
import { migrate, MIGRATIONS_DIR } from '../../src/store/migrate.ts';

/**
 * Test DB with the WP-1 foundation + notification/job migrations only, so WP-5 tests are
 * not affected by other packages' in-progress migrations. Set
 * POTTS_TEST_ALL_MIGRATIONS=1 to apply every migration instead.
 */
export function wp5MigrationsDir(): string {
  if (process.env.POTTS_TEST_ALL_MIGRATIONS === '1') return MIGRATIONS_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'potts-wp5-mig-'));
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(MIGRATIONS_DIR)) if (/^(00\d\d|04\d\d|064[01])_.*\.sql$/.test(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

export interface TestEnv {
  dir: string;
  dbPath: string;
  db: Db;
  clock: FakeClock;
  migDir: string;
  reopen(): Db;
}

export function makeEnv(start: string): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'potts-wp5-'));
  const dbPath = join(dir, 'potts.db');
  const clock = createFakeClock(start);
  const migDir = wp5MigrationsDir();
  const db = openDatabase(dbPath);
  migrate(db, { dir: migDir, clock });
  return {
    dir,
    dbPath,
    db,
    clock,
    migDir,
    reopen() {
      const d = openDatabase(dbPath);
      migrate(d, { dir: migDir, clock });
      return d;
    },
  };
}

/** Toronto wall time → UTC ISO for readability in tests (EDT before 2026-11-01, EST after). */
export const T = (iso: string) => new Date(iso).toISOString();

/** Fake fetch: route by URL to a handler returning Response or throwing. */
export type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
export function fakeFetch(routes: Record<string, Route>, calls: string[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    for (const [prefix, h] of Object.entries(routes)) if (url.startsWith(prefix)) return h(url, init);
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${url}` } });
  };
}

export const netError = (code: string) => () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code, message: code } });
};
