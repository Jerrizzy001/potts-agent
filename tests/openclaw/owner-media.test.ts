import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerMediaTools, type Runner } from '../../integrations/openclaw/potts-broker-plugin/lib/owner-media.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';

function setup(sendOk = true, imessage = false) {
  const home = mkdtempSync(join(tmpdir(), 'potts-media-'));
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin', 'potts-say'), '#!/bin/sh\n', { mode: 0o755 });
  const ogg = join(home, 'v.ogg'); writeFileSync(ogg, 'OggS');
  const cfg = parsePluginConfig({ pottsHome: home, ownerTelegramId: '424242', ...(imessage ? { deliveryChannel: 'imessage', deliveryTarget: '+14165550123' } : {}) });
  assert.ok(cfg.ok);
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith('potts-say')) return { code: 0, stdout: `${ogg}\n`, stderr: '' };
    if (cmd.endsWith('ffmpeg')) { writeFileSync(args.at(-1)!, 'test-aac'); return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'browser') return { code: 0, stdout: args[1] === 'screenshot' ? `${ogg}\n` : 'ok', stderr: '' };
    return sendOk ? { code: 0, stdout: '{"ok": true}', stderr: '' } : { code: 1, stdout: '', stderr: 'telegram 400' };
  };
  const secrets = { get: async () => ({ ownerId: '424242', key: Buffer.alloc(32) }) };
  const tools = createOwnerMediaTools(cfg.value, secrets as never, { run, openclawCli: '/x/openclaw', sleep: async () => {}, outbox: join(home, 'outbox') });
  return { home, ogg, calls, voice: tools.find((t) => t.name === 'potts_send_voice')!, file: tools.find((t) => t.name === 'potts_send_file')!, shot: tools.find((t) => t.name === 'potts_send_screenshot')! };
}

test('send_voice renders then delivers only to the owner; no recipient parameter exists', async () => {
  const s = setup();
  try {
    assert.equal('to' in (s.voice.parameters.properties as object), false);
    const r = await s.voice.execute('1', { text: 'hey' });
    assert.equal((r.details as { sent: boolean }).sent, true);
    const send = s.calls.find((c) => c.cmd === '/x/openclaw')!;
    assert.deepEqual(send.args.slice(0, 6), ['message', 'send', '--channel', 'telegram', '--target', '424242']);
    assert.ok(send.args[7]!.startsWith(join(s.home, 'outbox') + '/'), 'staged into the outbox');
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('iMessage-only configuration routes voice, files and screenshots to the owner number', async () => {
  const s = setup(true, true);
  try {
    await s.voice.execute('voice', { text: 'hello' });
    await s.file.execute('file', { path: s.ogg });
    await s.shot.execute('shot', { url: 'https://example.com' });
    const sends = s.calls.filter(c => c.args[0] === 'message');
    assert.equal(sends.length, 3);
    for (const send of sends) assert.deepEqual(send.args.slice(0, 6), ['message', 'send', '--channel', 'imessage', '--target', '+14165550123']);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('unconfirmed CLI delivery remains uncertain', async () => {
  const s = setup(false);
  try {
    const r = await s.voice.execute('1', { text: 'hey' });
    assert.equal((r.details as { sent: boolean }).sent, false);
    assert.match(r.content[0]!.text, /^Delivery was not confirmed/);
    assert.equal((r.details as {uncertain:boolean}).uncertain,true);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('send_file refuses relative, missing and credential paths', async () => {
  const s = setup();
  try {
    for (const path of ['notes.txt', join(s.home, 'nope.pdf'), join(process.env.HOME!, '.openclaw', 'openclaw.json')]) {
      const r = await s.file.execute('1', { path });
      assert.equal((r.details as { sent: boolean }).sent, false, path);
    }
    const ok = await s.file.execute('1', { path: s.ogg, caption: 'here' });
    assert.equal((ok.details as { sent: boolean }).sent, true);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('send_screenshot opens the url, captures, and delivers the picture to the owner', async () => {
  const s = setup();
  try {
    const r = await s.shot.execute('1', { url: 'https://example.com', caption: 'dog' });
    assert.equal((r.details as { sent: boolean }).sent, true);
    assert.deepEqual(s.calls.map((c) => c.args.slice(0, 2).join(' ')), ['browser navigate', 'browser screenshot', 'message send']);
    assert.match((await s.shot.execute('2', { url: 'file:///etc/passwd' })).content[0]!.text, /^Not sent/);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test('native media adapter failure is uncertain and never falls back to a duplicate CLI send', async () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-native-media-'));
  try {
    const path = join(home, 'test.txt'); writeFileSync(path, 'test');
    const parsed = parsePluginConfig({ pottsHome: home, deliveryChannel: 'imessage', deliveryTarget: '+14165550123' });
    assert.ok(parsed.ok);
    let attempts = 0;
    const tools = createOwnerMediaTools(parsed.value, { get: async () => ({ ownerId: '+14165550123', key: Buffer.alloc(32) }) } as never, {
      outbox: join(home, 'outbox'),
      run: async () => { assert.fail('must not launch CLI fallback'); },
      deliverMedia: async () => { attempts++; throw new Error('interrupted after submission'); },
    });
    const r = await tools.find(t => t.name === 'potts_send_file')!.execute('one', { path });
    assert.equal((r.details as { uncertain: boolean }).uncertain, true);
    assert.equal(attempts, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native media requires affirmative acceptance and never retries missing or rejected receipts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-native-receipt-'));
  try {
    const path = join(home, 'test.txt'); writeFileSync(path, 'test');
    const parsed = parsePluginConfig({ pottsHome: home, deliveryChannel: 'imessage', deliveryTarget: '+14165550123' });
    assert.ok(parsed.ok);
    for (const receipt of [undefined, {}, { ok: false }, { messageId: 'unknown' }, { messageId: 'ok' }, { messageId: 'guid-123' }]) {
      let sends = 0;
      const tools = createOwnerMediaTools(parsed.value, { get: async () => ({ ownerId: '+14165550123', key: Buffer.alloc(32) }) } as never, {
        outbox: join(home, 'outbox'), run: async () => { assert.fail('no retry'); },
        deliverMedia: async () => { sends++; return receipt; },
      });
      const r = await tools.find(t => t.name === 'potts_send_file')!.execute('one', { path });
      assert.equal((r.details as {sent:boolean}).sent, ['ok','guid-123'].includes(receipt?.messageId ?? ''));
      assert.equal(sends, 1);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
