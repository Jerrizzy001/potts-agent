import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePottsHome, ensurePottsHome, openDatabase, migrate, listMigrations } from '../../src/store/index.ts';

test('POTTS_HOME override and default', () => {
  assert.equal(resolvePottsHome({ POTTS_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(resolvePottsHome({}), join(homedir(), 'Library', 'Application Support', 'Potts'));
});

test('ensurePottsHome creates 0700 directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'potts-home-'));
  const home = join(base, 'Potts');
  const p = ensurePottsHome(home);
  for (const d of [p.home, p.runDir, p.logsDir]) assert.equal(statSync(d).mode & 0o777, 0o700);
});

test('database opens with WAL, foreign keys and 0600 file mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-db-'));
  const db = openDatabase(join(dir, 'a.db'));
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1);
  assert.equal(statSync(join(dir, 'a.db')).mode & 0o777, 0o600);
  db.close();
});

test('migrations apply in order, once, and are recorded', () => {
  const db = openDatabase(':memory:');
  const first = migrate(db);
  assert.ok(first.includes(1));
  assert.deepEqual(migrate(db), []);
  const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as any[];
  assert.equal(rows[0].name, 'foundation');
  assert.deepEqual(listMigrations().map((m) => m.version), rows.map((r) => r.version));
});

test('modified or misnamed migrations are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-mig-'));
  mkdirSync(join(dir, 'm'));
  writeFileSync(join(dir, 'm', '0001_a.sql'), 'CREATE TABLE a (x INTEGER);');
  writeFileSync(join(dir, 'm', '0002_b.sql'), 'CREATE TABLE b (x INTEGER);');
  const db = openDatabase(':memory:');
  assert.deepEqual(migrate(db, { dir: join(dir, 'm') }), [1, 2]);
  writeFileSync(join(dir, 'm', '0001_a.sql'), 'CREATE TABLE a (x INTEGER, y INTEGER);');
  assert.throws(() => migrate(db, { dir: join(dir, 'm') }), /modified/);
  writeFileSync(join(dir, 'm', 'bad.sql'), '');
  assert.throws(() => listMigrations(join(dir, 'm')), /NNNN_name/);
});

test('a failing migration rolls back and is not recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-mig2-'));
  writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
  writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half (x INTEGER); THIS IS NOT SQL;');
  const db = openDatabase(':memory:');
  assert.throws(() => migrate(db, { dir }), /0002_bad failed/);
  assert.equal((db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'half'").get() as any).n, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM schema_migrations').get() as any).n, 1);
});
