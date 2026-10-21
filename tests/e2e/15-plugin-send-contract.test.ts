import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { createAgentTools } from '../../integrations/openclaw/potts-broker-plugin/lib/tools.ts';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, sendPayload, startWorld, tokenSetFor } from './_harness.ts';

const START = '2026-10-07T14:00:00Z';
test('Telegram tool -> actual daemon -> approval -> writer sends canonical content exactly once', async () => {
  const home = makeHome({ accounts: [gmailAccount('approval_required')], potts: c => {
    (c.monitoring as Record<string, unknown>).enabled = false;
    c.writers = { accounts: [{ accountId: 'gmail-personal', enabled: true, kinds: ['send_message'] }] };
  } });
  const net = createFakeNet(); const gmail = routeGmail(net);
  const w = await startWorld({ home, start: START, net, keychain: { 'potts/google-oauth-client-secret': 'test-client-secret' }, tokens: {
    'gmail-personal': tokenSetFor('google', START),
    'gmail-personal.send': tokenSetFor('google', START, { scope: 'https://www.googleapis.com/auth/gmail.send openid email' }),
  } });
  try {
    await w.d.start({ timers: false });
    markConnected(w, 'gmail-personal', 'google');
    markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send openid email');
    const config = parsePluginConfig({ pottsHome: home, brokerSocket: join(home, 'run', 'broker.sock'), ownerTelegramId: '424242' });
    assert.ok(config.ok); if (!config.ok) return;
    const tool = createAgentTools(config.value).find(t => t.name === 'potts_propose_action')!;
    const input = sendPayload('bob@example.com', 'Hi Bob, Thursday works.');
    const r = await tool.execute('send', input);
    const d = r.details as { ok: boolean; actionId: string; status: string };
    assert.ok(d.ok, JSON.stringify(r)); assert.equal(d.status, 'awaiting_approval');
    await w.advance(30_000); assert.equal(gmail.sent.length, 0);
    assert.ok(w.approve(d.actionId).ok);
    await w.advance(30_000); assert.equal(gmail.sent.length, 1);
    assert.equal(Buffer.from(gmail.sent[0]!.raw.split('\r\n\r\n')[1]!.trim(), 'base64').toString('utf8'), 'Hi Bob, Thursday works.');
    await w.advance(30_000); assert.equal(gmail.sent.length, 1);
    assert.equal(w.d.broker.status(d.actionId)!.status, 'succeeded');
  } finally { await w.close(); }
});
