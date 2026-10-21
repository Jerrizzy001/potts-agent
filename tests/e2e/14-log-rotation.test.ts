/**
 * WP-9: size-based rotation of the daemon's launchd stdout/stderr logs
 * (copy-truncate so launchd's O_APPEND descriptors keep working; keep N; 0600).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLogs } from '../../src/daemon/logrotate.ts';
import { makeHome, startWorld } from './_harness.ts';

const mode = (p: string) => statSync(p).mode & 0o777;

test('rotateLogs: rotates over the limit, keeps N generations, 0600, and an O_APPEND writer continues in the live file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-logs-'));
  try {
    const out = join(dir, 'daemon.out.log');
    const err = join(dir, 'daemon.err.log');
    // launchd-style writer: the descriptor stays open with O_APPEND across rotations.
    const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o644);
    writeFileSync(err, 'small\n', { mode: 0o644 });
    try {
      for (let gen = 1; gen <= 5; gen++) {
        writeSync(fd, `generation ${gen} `.padEnd(2000, 'x') + '\n');
        const r = rotateLogs(dir, { maxBytes: 1000, keep: 3 });
        assert.deepEqual(r.rotated, [out]);
        assert.equal(statSync(out).size, 0, 'live file truncated');
      }
      writeSync(fd, 'after rotation\n');
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(out, 'utf8'), 'after rotation\n', 'appends land at the start of the truncated live file (no hole)');
    assert.match(readFileSync(`${out}.1`, 'utf8'), /^generation 5 /);
    assert.match(readFileSync(`${out}.2`, 'utf8'), /^generation 4 /);
    assert.match(readFileSync(`${out}.3`, 'utf8'), /^generation 3 /);
    assert.equal(existsSync(`${out}.4`), false, 'only 3 generations kept');
    for (const p of [out, `${out}.1`, `${out}.2`, `${out}.3`, err]) assert.equal(mode(p), 0o600, p);
    assert.equal(readFileSync(err, 'utf8'), 'small\n', 'files under the limit are not rotated');
    // A smaller keep later removes the extra generations on the next rotation.
    writeFileSync(out, 'y'.repeat(5000));
    const r = rotateLogs(dir, { maxBytes: 1000, keep: 1 });
    assert.ok(r.removed.length >= 1);
    assert.equal(existsSync(`${out}.2`), false);
    assert.equal(readFileSync(`${out}.1`, 'utf8').length, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon wires log rotation from potts.json daemon.logRotation', async () => {
  const home = makeHome({ potts: (c) => ((c.daemon as Record<string, unknown>).logRotation = { maxBytes: 65536, keep: 2 }) });
  const w = await startWorld({ home, start: '2026-10-07T14:00:00Z' });
  try {
    const log = join(home, 'logs', 'daemon.err.log');
    writeFileSync(log, 'z'.repeat(70_000), { mode: 0o644 });
    assert.ok(w.d.jobIds.includes('logs:rotate'));
    const r = w.d.rotateLogs();
    assert.deepEqual(r.rotated, [log]);
    assert.equal(statSync(log).size, 0);
    assert.equal(mode(`${log}.1`), 0o600);
    // The scheduled job also rotates (every 10 minutes).
    writeFileSync(log, 'z'.repeat(70_000));
    await w.advance(11 * 60_000, 60_000);
    assert.equal(statSync(log).size, 0);
    assert.ok(existsSync(`${log}.2`));
  } finally {
    await w.close();
  }
});
