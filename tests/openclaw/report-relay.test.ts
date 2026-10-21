/** Worker reports: straight to the owner's Telegram chat, then a short transcript note for the coordinator (no model turn). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COORDINATOR_NOTE_MAX, OWNER_REPORT_MAX, relayWorkerReport, parseWorkerReport, ownerReportText, REPORT_FALLBACK, type RelayStatus } from '../../integrations/openclaw/potts-broker-plugin/lib/report-relay.ts';
import type { Spawner } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-task.ts';

const flush = () => new Promise((r) => setTimeout(r, 10));

function fixture(sendOutput: string | null, sendCode = 0, imessage = false) {
  const dir = mkdtempSync(join(tmpdir(), 'potts-relay-'));
  const calls: string[][] = [];
  const statuses: RelayStatus[] = [];
  const spawner: Spawner = (_cmd, args, o) => {
    calls.push(args);
    if (args[0] === 'message') { if (sendOutput !== null) writeFileSync(o.outFile, sendOutput); o.onExit(sendCode); o.onExit(sendCode); }
    else o.onExit(0);
  };
  const run = (text: string) => relayWorkerReport({
    spawner, cli: '/x/openclaw', cwd: dir, relayLog: join(dir, 'relay.log'), noteLog: join(dir, 'note.log'),
    ownerId: '424242', coordinatorAgentId: 'potts-coordinator', jobRef: 'Sol job sol_20261008000000_abcdef12', text,
    ...(imessage ? { deliveryChannel: 'imessage', deliveryTarget: '+14165550123' } : {}),
    onDelivery: (s) => statuses.push(s),
  });
  return { dir, calls, statuses, run, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a delivered report needs the CLI receipt and leaves one short note in the coordinator session', async () => {
  const f = fixture('{"ok": true}');
  try {
    await f.run(JSON.stringify({ version: 1, outcome: 'partial', ownerMessage: 'The basic checks passed. The full setup still needs testing.', detailedReport: 'INTERNAL_EVIDENCE '.repeat(500) }));
    await flush();
    assert.deepEqual(f.statuses, ['delivered'], 'duplicate exit signals settle once');
    assert.equal(f.calls.length, 2);
    const sent = f.calls[0]![f.calls[0]!.indexOf('-m') + 1]!;
    assert.ok(sent.length <= OWNER_REPORT_MAX);
    assert.equal(sent, 'Some work is still unfinished. The basic checks passed. The full setup still needs testing.');
    assert.ok(!sent.includes('INTERNAL_EVIDENCE'));
    assert.deepEqual(f.calls[1]!.slice(0, 3), ['gateway', 'call', 'chat.inject']);
    const params = JSON.parse(f.calls[1]![4]!) as { sessionKey: string; message: string; label: string };
    assert.equal(params.sessionKey, 'agent:potts-coordinator:telegram:direct:424242');
    assert.ok(params.message.startsWith('Sent the owner the report from Sol job') && params.message.length < COORDINATOR_NOTE_MAX + 200);
  } finally { f.close(); }
});

test('iMessage worker reports and follow-up context use the same channel and owner', async () => {
  const f = fixture('{"ok":true}', 0, true);
  try {
    await f.run('Done'); await flush();
    assert.deepEqual(f.calls[0]!.slice(0, 6), ['message', 'send', '--channel', 'imessage', '--target', '+14165550123']);
    assert.equal(JSON.parse(f.calls[1]![4]!).sessionKey, 'agent:potts-coordinator:imessage:direct:+14165550123');
  } finally { f.close(); }
});

test('missing acknowledgements stay uncertain; explicit rejection fails; neither is replayed', async () => {
  for (const [out, code] of [[null, 0], ['{"ok": false}', 0], ['{"ok": true}', 1]] as const) {
    const f = fixture(out, code);
    try {
      await f.run('Sol finished:\nshort report');
      await flush();
      assert.deepEqual(f.statuses, [out === '{"ok": false}' ? 'failed' : 'uncertain']);
      assert.match(JSON.parse(f.calls[1]![4]!).message, /do not resend it blindly/);
      assert.equal(f.calls.filter((c) => c[0] === 'message').length, 1, 'never retried');
    } finally { f.close(); }
  }
});


test('legacy, malformed, oversized and technical owner messages never leak raw reports or imply success', () => {
  const good = { version: 1, outcome: 'completed', ownerMessage: 'The fix is ready. The checks passed.', detailedReport: 'RAW_EVIDENCE' };
  for (const raw of ['Done. RAW_EVIDENCE', '{bad JSON', JSON.stringify({...good, ownerMessage:'x'.repeat(401)}), JSON.stringify({...good, ownerMessage:'Run openclaw memory status --index --agent main.'}), JSON.stringify({...good, outcome:'unknown'}), JSON.stringify({...good, detailedReport:''})]) {
    const parsed = parseWorkerReport(raw);
    assert.equal(parsed.ownerMessage, REPORT_FALLBACK);
    assert.equal(parsed.reportedOutcome, 'unknown');
    assert.equal(parsed.detailedReport, raw, 'keep the original evidence without truncation');
    assert.equal(ownerReportText(raw), REPORT_FALLBACK);
  }
  const raw = JSON.stringify(good);
  assert.equal(ownerReportText(raw), good.ownerMessage);
  assert.match(ownerReportText(raw, 'failed'), /couldn’t confirm/);
  assert.match(ownerReportText(raw, 'interrupted'), /may still be running/);
  assert.ok(!ownerReportText(raw, 'failed').includes('fix is ready'));
});

test('relay rejects a legacy technical dump instead of sending its first paragraph', async () => {
  const f = fixture('{"ok":true}', 0, true);
  try {
    await f.run('Everything passed.\nRAW_EVIDENCE\nHowever the actual integration failed.');
    await flush();
    const args = f.calls[0]!;
    assert.equal(args[args.indexOf('-m') + 1], REPORT_FALLBACK);
  } finally { f.close(); }
});
