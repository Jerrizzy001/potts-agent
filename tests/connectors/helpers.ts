import { copyFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../../src/core/clock.ts';
import { openDatabase, type Db } from '../../src/store/db.ts';
import { MIGRATIONS_DIR, migrate } from '../../src/store/migrate.ts';
import type { OAuthTokenSet } from '../../src/connectors/oauth/types.ts';

export interface TestEnv {
  dir: string;
  db: Db;
  clock: FakeClock;
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
  close(): void;
}

/** Temp DB with only the foundation (0001) and WP-4 (03xx) migrations, so other packages' in-flight migrations cannot interfere. */
export function makeEnv(start = '2026-10-06T14:00:00.000Z'): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'potts-wp4-'));
  const mig = join(dir, 'migrations');
  mkdirSync(mig);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (/^(0001|03\d\d)_.*\.sql$/.test(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(mig, f));
  const clock = createFakeClock(start);
  const db = openDatabase(join(dir, 'potts.db'));
  migrate(db, { dir: mig, clock });
  const sleeps: number[] = [];
  return {
    dir, db, clock, sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advanceMs(ms);
    },
    close() {
      try {
        db.close();
      } catch {
        /* closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tokenSet(provider: 'google' | 'microsoft', clockIso: string, over: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    provider,
    accessToken: 'at-1',
    accessTokenExpiresAt: new Date(Date.parse(clockIso) + 3600_000).toISOString(),
    refreshToken: 'rt-1',
    scope: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read User.Read',
    tokenType: 'Bearer',
    accountAddress: provider === 'google' ? 'owner@example.com' : 'student@example.edu',
    obtainedAt: clockIso,
    ...over,
  };
}
