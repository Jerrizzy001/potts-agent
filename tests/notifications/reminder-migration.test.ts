import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderExecutionFingerprint as fingerprint } from '../../src/notifications/reminder-migration.ts';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/store/db.ts';
import { migrate, MIGRATIONS_DIR } from '../../src/store/migrate.ts';

test('legacy disable may clear nextRunAtMs and stamp scheduleActivatedAtMs without executing', () => {
  const before = { nextRunAtMs:1792591200000, lastRunAtMs:100, lastRunStatus:'ok', lastDelivered:true };
  const after = { scheduleActivatedAtMs:1792557473054, lastDelivered:true, lastRunStatus:'ok', lastRunAtMs:100 };
  assert.equal(fingerprint(before), fingerprint(after));
  assert.equal(fingerprint(undefined), fingerprint({scheduleActivatedAtMs:123}));
});

test('execution and delivery races remain detectable after disable normalization', () => {
  const before = { nextRunAtMs:100, lastRunAtMs:10, lastRunStatus:'ok', lastDelivered:true };
  for(const patch of [{lastRunAtMs:100}, {lastRunStatus:'error'}, {lastDelivered:false}, {lastDeliveryError:'unconfirmed'}, {runningAtMs:99}, {queuedAtMs:98}, {runningReceiptId:'new'}, {futureReceiptField:'changed'}]) {
    assert.notEqual(fingerprint(before), fingerprint({...before,...patch,scheduleActivatedAtMs:200}),JSON.stringify(patch));
  }
});

test('existing 0640 database upgrades through 0641 without rewriting history or losing reminders', () => {
  const prior=mkdtempSync(join(tmpdir(),'potts-pre0641-'));
  const db=openDatabase(':memory:');
  try {
    for(const file of readdirSync(MIGRATIONS_DIR))if(/^\d{4}_.*\.sql$/.test(file)&&Number(file.slice(0,4))<=640)copyFileSync(join(MIGRATIONS_DIR,file),join(prior,file));
    migrate(db,{dir:prior});
    const original=db.prepare('SELECT sha256 FROM schema_migrations WHERE version=640').get();
    assert.equal((db.prepare('PRAGMA table_info(owner_notifications)').all() as {name:string}[]).some(c=>c.name==='expected_channel'),false);
    db.prepare('INSERT INTO owner_reminders (id,text,schedule_json,channel,target,next_due_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy-stable-id','Test reminder','{"kind":"at","at":"2026-10-22T12:00:00Z"}','imessage','+14165550123',1792670400000,'2026-10-21','2026-10-21');
    assert.ok(migrate(db).includes(641));
    assert.deepEqual(db.prepare('SELECT sha256 FROM schema_migrations WHERE version=640').get(),original);
    assert.equal((db.prepare('SELECT text FROM owner_reminders WHERE id=?').get('legacy-stable-id') as {text:string}).text,'Test reminder');
    const columns=(db.prepare('PRAGMA table_info(owner_notifications)').all() as {name:string}[]).map(c=>c.name);
    assert.ok(columns.includes('expected_channel')&&columns.includes('expected_target'));
    assert.deepEqual(migrate(db),[]);
  } finally {db.close();rmSync(prior,{recursive:true,force:true});}
});
