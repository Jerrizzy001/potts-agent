/**
 * Fully wired daemon for the isolated OpenClaw test profile. All providers,
 * credentials and owner deliveries are synthetic; sockets and SQLite are real.
 * Prints {"home": ...} and runs until SIGTERM. Never used by production wiring.
 *   node tests/openclaw/support/run-test-broker.ts
 */
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, routeSite, startWorld, tokenSetFor } from '../../e2e/_harness.ts';

const key = process.env.POTTS_TEST_INGRESS_KEY;
if (!key || key.length < 32) throw new Error('set POTTS_TEST_INGRESS_KEY (>= 32 chars, test value only)');
const start = new Date().toISOString();
const home = makeHome({ accounts: [gmailAccount('approval_required')], potts: c => {
  c.writers = { lookupSettleSeconds: 600, accounts: [{ accountId: 'gmail-personal', enabled: true, kinds: ['send_message'] }] };
} });
const net = createFakeNet();
routeSite(net);
const gmail = routeGmail(net);
const w = await startWorld({ home, start, net,
  keychain: { 'potts/ingress-hmac-key': key, 'potts/google-oauth-client-secret': 'synthetic-client-secret' },
  tokens: {
    'gmail-personal': tokenSetFor('google', start),
    'gmail-personal.send': tokenSetFor('google', start, { scope: 'https://www.googleapis.com/auth/gmail.send' }),
  },
});
markConnected(w, 'gmail-personal', 'google');
markConnected(w, 'gmail-personal.send', 'google', 'https://www.googleapis.com/auth/gmail.send');
w.d.memory!.remember({ text: 'Potts harness fixture', sourceId: 'src_owner', status: 'verified', confidence: 1 });
await w.d.start({ timers: false });
process.stdout.write(JSON.stringify({ home }) + '\n');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(JSON.stringify({ actions: w.d.broker.list().map((a) => ({ id: a.id, kind: a.kind, status: a.status })), sends: gmail.sent.length }) + '\n');
  await w.close();
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
setInterval(() => w.clock.set(new Date().toISOString()), 1000);
