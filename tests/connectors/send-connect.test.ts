/**
 * WP-9: send-scope connect flow (connect-account --purpose send), send revoke,
 * and account data purge on revoke. Fake Google/Microsoft endpoints and an
 * in-memory token store; no Keychain, no real network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { createFakeClock } from '../../src/core/clock.ts';
import { createAccountRegistry } from '../../src/core/config.ts';
import { openDatabase } from '../../src/store/db.ts';
import { migrate } from '../../src/store/migrate.ts';
import {
  createAccountStatusStore, createMemoryTokenStore, listAccountPurgeReceipts, runConnectAccountCli, accountMemorySourceId,
  type ConnectCliDeps, type GoogleOAuthConfig, type OAuthTokenSet, type ProviderConfigs,
} from '../../src/connectors/oauth/index.ts';
import { createWriterTokenProvider } from '../../src/daemon/tokens.ts';
import { GMAIL_SEND_SCOPE } from '../../src/connectors/gmail/writer.ts';
import { GRAPH_SEND_SCOPES } from '../../src/connectors/outlook/writer.ts';
import { createMemoryStore } from '../../src/memory/store.ts';
import { createAuditLedger } from '../../src/audit/ledger.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const GMAIL = 'owner@example.com';
const OUTLOOK = 'owner@example.com';
const SEND_SCOPE_GRANT = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send';

function makeHome(opts: { sendClientId?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'potts-wp9-connect-'));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config/potts.example.json'), 'utf8')) as Record<string, any>;
  if (!opts.sendClientId) delete cfg.connectors.microsoft.sendClientId;
  else cfg.connectors.microsoft.sendClientId = '99999999-8888-7777-6666-555555555555';
  writeFileSync(join(home, 'potts.json'), JSON.stringify(cfg));
  const accts = JSON.parse(readFileSync(join(ROOT, 'config/accounts.example.json'), 'utf8')) as { accounts: { id: string; address: string; mode: string }[] };
  for (const a of accts.accounts) if (a.id === 'gmail-personal' || a.id === 'outlook-personal') a.mode = 'approval_required';
  writeFileSync(join(home, 'accounts.json'), JSON.stringify(accts));
  copyFileSync(join(ROOT, 'config/policy.example.json'), join(home, 'policy.json'));
  return home;
}

function googleCfg(s: FakeServer): GoogleOAuthConfig {
  return {
    clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', authEndpoint: `${s.base}/auth`, tokenEndpoint: `${s.base}/token`, revokeEndpoint: `${s.base}/revoke`,
    gmailApiBase: `${s.base}/gmail/v1`, userinfoEndpoint: `${s.base}/userinfo`,
  };
}

function harness(s: FakeServer, home: string, over: Partial<ConnectCliDeps> = {}) {
  const clock = createFakeClock('2026-10-06T14:00:00.000Z');
  const tokens = createMemoryTokenStore();
  const out: string[] = [];
  const err: string[] = [];
  const authUrls: URL[] = [];
  const configs: ProviderConfigs = {
    google: googleCfg(s),
    microsoft: { clientId: '00000000-0000-0000-0000-000000000000', authorityBase: s.base, graphBase: `${s.base}/graph` },
  };
  const deps: ConnectCliDeps = {
    home, fetch, clock, sleep: async (ms) => clock.advanceMs(ms), out: (l) => out.push(l), err: (l) => err.push(l),
    openBrowser: async (url) => {
      const u = new URL(url);
      authUrls.push(u);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('state', u.searchParams.get('state')!);
      redirect.searchParams.set('code', 'auth-code-1');
      await fetch(redirect);
    },
    tokenStore: () => tokens,
    resolveConfigs: async (conn) => {
      const c: ProviderConfigs = { ...configs };
      if (conn.microsoft?.sendClientId) c.microsoftSend = { clientId: conn.microsoft.sendClientId, authorityBase: s.base, graphBase: `${s.base}/graph` };
      return { ok: true, value: c };
    },
    ...over,
  };
  return { deps, clock, tokens, out, err, authUrls, configs };
}

function googleRoutes(s: FakeServer, o: { scope?: string; email?: string } = {}) {
  s.route('POST', '/token', (r) => {
    if (r.form.get('grant_type') === 'authorization_code') return { json: { access_token: 'g-send-at', refresh_token: 'g-send-rt', expires_in: 3599, scope: o.scope ?? SEND_SCOPE_GRANT, token_type: 'Bearer' } };
    if (r.form.get('grant_type') === 'refresh_token') return { json: { access_token: 'g-send-at-2', expires_in: 3599, scope: o.scope ?? SEND_SCOPE_GRANT, token_type: 'Bearer' } };
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  });
  s.route('GET', '/userinfo', (r) => (r.headers.authorization?.startsWith('Bearer ') ? { json: { sub: '42', email: o.email ?? 'Owner@Example.com', email_verified: true } } : { status: 401, json: {} }));
  s.route('POST', '/revoke', () => ({ status: 200, text: '' }));
}

const readSet = (provider: 'google' | 'microsoft', address: string): OAuthTokenSet => ({
  provider, accessToken: 'read-at', accessTokenExpiresAt: '2026-10-07T00:00:00.000Z', refreshToken: 'read-rt',
  scope: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read User.Read', tokenType: 'Bearer', accountAddress: address, obtainedAt: '2026-10-06T00:00:00.000Z',
});

test('Gmail --purpose send: gmail.send-only consent, identity verified, stored where the writer TokenProvider reads it', async () => {
  const s = await startFakeServer();
  const home = makeHome();
  try {
    googleRoutes(s);
    const h = harness(s, home);
    await h.tokens.set('gmail-personal', readSet('google', GMAIL));
    const code = await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send'], h.deps);
    assert.equal(code, 0, h.err.join('\n'));
    const u = h.authUrls[0]!;
    assert.equal(u.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.send');
    assert.equal(u.searchParams.get('login_hint'), GMAIL);
    assert.equal(u.searchParams.get('include_granted_scopes'), null);
    const send = await h.tokens.get('gmail-personal.send');
    assert.equal(send?.refreshToken, 'g-send-rt');
    assert.equal(send?.accountAddress, GMAIL);
    assert.equal((await h.tokens.get('gmail-personal'))?.refreshToken, 'read-rt', 'read credential untouched');
    assert.ok(!s.requests.some((r) => r.path.startsWith('/gmail/')), 'send consent never calls the Gmail read API');

    // The daemon's writer token provider finds it (same token store, same DB) and refreshes it with send rules.
    const db = openDatabase(join(home, 'potts.db'));
    try {
      const statusStore = createAccountStatusStore(db, h.clock);
      assert.equal(statusStore.get('gmail-personal.send')?.status, 'connected');
      const accounts = createAccountRegistry([{ id: 'gmail-personal', kind: 'gmail', address: GMAIL, mode: 'approval_required' }]);
      const tp = createWriterTokenProvider({ accounts, tokenStore: h.tokens, statusStore, configs: h.configs, fetch, clock: h.clock });
      assert.equal(await tp.getAccessToken({ accountId: 'gmail-personal', purpose: 'send', scopes: [GMAIL_SEND_SCOPE] }), 'g-send-at');
      h.clock.advanceMs(2 * 3600_000); // expired → refresh; a gmail.send grant must survive the refresh scope check
      assert.equal(await tp.getAccessToken({ accountId: 'gmail-personal', purpose: 'send', scopes: [GMAIL_SEND_SCOPE] }), 'g-send-at-2');
      await assert.rejects(tp.getAccessToken({ accountId: 'gmail-personal', purpose: 'lookup', scopes: [GMAIL_SEND_SCOPE] }), /lookup credential unavailable/, 'lookup never borrows the send credential');
    } finally {
      db.close();
    }

    const st: string[] = [];
    assert.equal(await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send', '--status'], { ...h.deps, out: (l) => st.push(l) }), 0);
    assert.match(st.join(''), /"accountId": "gmail-personal\.send"[\s\S]*"status": "connected"/);
  } finally {
    await s.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Gmail send consent for another mailbox, or with extra Gmail scopes, is revoked and nothing is stored', async () => {
  for (const variant of [{ email: 'someone.else@example.com', code: 'account_mismatch' }, { scope: `${SEND_SCOPE_GRANT} https://www.googleapis.com/auth/gmail.readonly`, code: 'scope_rejected' }]) {
    const s = await startFakeServer();
    const home = makeHome();
    try {
      googleRoutes(s, variant);
      const h = harness(s, home);
      assert.equal(await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send'], h.deps), 1);
      assert.match(h.err.join('\n'), new RegExp(variant.code));
      assert.equal(h.tokens.size(), 0);
      assert.equal(s.requests.find((r) => r.path === '/revoke')?.form.get('token'), 'g-send-rt');
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('Outlook --purpose send needs the separate send app registration and stores Mail.Send + Mail.ReadWrite under <id>.send', async () => {
  const s = await startFakeServer();
  const home = makeHome();
  try {
    const h = harness(s, home);
    assert.equal(await runConnectAccountCli(['--account', 'outlook-personal', '--purpose', 'send'], h.deps), 1);
    assert.match(h.err.join('\n'), /sendClientId/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const home2 = makeHome({ sendClientId: true });
  try {
    const devicePosts: URLSearchParams[] = [];
    s.route('POST', '/organizations/oauth2/v2.0/devicecode', (r) => {
      devicePosts.push(r.form);
      return { json: { device_code: 'dc', user_code: 'SEND-CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 } };
    });
    s.route('POST', '/organizations/oauth2/v2.0/token', (r) => {
      if (r.form.get('grant_type') === 'refresh_token')
        return { json: { access_token: 'ms-send-at-2', refresh_token: 'ms-send-rt-2', expires_in: 3600, scope: 'Mail.Send Mail.ReadWrite User.Read', token_type: 'Bearer' } };
      return { json: { access_token: 'ms-send-at', refresh_token: 'ms-send-rt', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/User.Read', token_type: 'Bearer' } };
    });
    s.route('GET', '/graph/me', () => ({ json: { mail: OUTLOOK, userPrincipalName: OUTLOOK } }));
    const h = harness(s, home2);
    assert.equal(await runConnectAccountCli(['--account', 'outlook-personal', '--purpose', 'send'], h.deps), 0, h.err.join('\n'));
    assert.equal(devicePosts[0]!.get('scope'), 'Mail.Send Mail.ReadWrite offline_access User.Read');
    assert.equal(devicePosts[0]!.get('client_id'), '99999999-8888-7777-6666-555555555555');
    assert.match(h.out.join('\n'), /SEND-CODE/);
    const set = await h.tokens.get('outlook-personal.send');
    assert.equal(set?.refreshToken, 'ms-send-rt');
    assert.equal(await h.tokens.get('outlook-personal'), undefined);
    const db = openDatabase(join(home2, 'potts.db'));
    try {
      const statusStore = createAccountStatusStore(db, h.clock);
      const accounts = createAccountRegistry([{ id: 'outlook-personal', kind: 'outlook', address: OUTLOOK, mode: 'approval_required' }]);
      const configs = (await h.deps.resolveConfigs!({ microsoft: { clientId: '00000000-0000-0000-0000-000000000000', sendClientId: '99999999-8888-7777-6666-555555555555' } }));
      assert.ok(configs.ok);
      const tp = createWriterTokenProvider({ accounts, tokenStore: h.tokens, statusStore, configs: configs.value, fetch, clock: h.clock });
      assert.equal(await tp.getAccessToken({ accountId: 'outlook-personal', purpose: 'send', scopes: GRAPH_SEND_SCOPES }), 'ms-send-at');
      h.clock.advanceMs(2 * 3600_000);
      assert.equal(await tp.getAccessToken({ accountId: 'outlook-personal', purpose: 'send', scopes: GRAPH_SEND_SCOPES }), 'ms-send-at-2');
      const refresh = s.requests.filter((r) => r.form.get('grant_type') === 'refresh_token').at(-1)!;
      assert.equal(refresh.form.get('client_id'), '99999999-8888-7777-6666-555555555555');
      assert.equal(refresh.form.get('scope'), 'Mail.Send Mail.ReadWrite offline_access User.Read');
    } finally {
      db.close();
    }
  } finally {
    await s.close();
    rmSync(home2, { recursive: true, force: true });
  }
});

test('--revoke --purpose send removes only the send credential; synced data and the read credential stay', async () => {
  const s = await startFakeServer();
  const home = makeHome();
  try {
    googleRoutes(s);
    const h = harness(s, home);
    assert.equal(await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send'], h.deps), 0);
    await h.tokens.set('gmail-personal', readSet('google', GMAIL));
    const db = openDatabase(join(home, 'potts.db'));
    seedMail(db, 'gmail-personal');
    db.close();
    assert.equal(await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send', '--revoke'], h.deps), 0, h.err.join('\n'));
    assert.equal(await h.tokens.get('gmail-personal.send'), undefined);
    assert.ok(await h.tokens.get('gmail-personal'));
    assert.equal(s.requests.filter((r) => r.path === '/revoke').at(-1)?.form.get('token'), 'g-send-rt');
    const db2 = openDatabase(join(home, 'potts.db'));
    try {
      assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE account_id = 'gmail-personal'").get() as { n: number }).n, 2);
      assert.equal(createAccountStatusStore(db2, h.clock).get('gmail-personal.send')?.status, 'revoked');
      assert.equal(listAccountPurgeReceipts(db2).length, 0);
    } finally {
      db2.close();
    }
  } finally {
    await s.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function seedMail(db: ReturnType<typeof openDatabase>, accountId: string): void {
  const ins = db.prepare(`INSERT INTO mail_items (account_id, provider_message_id, provider, to_json, cc_json, subject, body_text, labels_json, headers_json, attachments_json,
    content_hash, category, priority, classification_json, first_seen_at, updated_at) VALUES (?,?,?,'[]','[]',?,?,'[]','{}','[]','h','personal','normal','{}','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z')`);
  ins.run(accountId, 'm1', 'gmail', 'Dinner', 'See you at 7');
  ins.run(accountId, 'm2', 'gmail', 'Invoice', 'Amount due');
  ins.run('other-account', 'm3', 'gmail', 'Keep me', 'not revoked');
  db.prepare("INSERT INTO mail_sync_state (account_id, provider, cursor, status, updated_at) VALUES (?, 'gmail', 'hist-123', 'ok', '2026-10-06T00:00:00Z')").run(accountId);
  db.prepare("INSERT INTO mail_sync_log (id, account_id, started_at, finished_at, mode, outcome) VALUES ('l1', ?, 'a', 'b', 'full', 'ok')").run(accountId);
}

test('--revoke (read) revokes read + send credentials and purges synced mail, cursors and sourced memory with a receipt', async () => {
  const s = await startFakeServer();
  const home = makeHome();
  try {
    googleRoutes(s);
    const h = harness(s, home);
    assert.equal(await runConnectAccountCli(['--account', 'gmail-personal', '--purpose', 'send'], h.deps), 0);
    await h.tokens.set('gmail-personal', readSet('google', GMAIL));
    const db = openDatabase(join(home, 'potts.db'));
    seedMail(db, 'gmail-personal');
    const mem = createMemoryStore({ db, clock: h.clock });
    assert.ok(mem.registerSource({ id: accountMemorySourceId('gmail-personal'), kind: 'gmail', label: 'facts from gmail-personal' }).ok);
    assert.ok(mem.remember({ text: 'Dentist appointment Thursday', sourceId: accountMemorySourceId('gmail-personal'), status: 'inferred', confidence: 0.6 }).ok);
    assert.ok(mem.remember({ text: 'Owner prefers short replies', sourceId: 'src_owner', status: 'verified', confidence: 1 }).ok);
    db.close();

    const rout: string[] = [];
    const code = await runConnectAccountCli(['--account', 'gmail-personal', '--revoke'], { ...h.deps, out: (l) => rout.push(l), memory: (d) => createMemoryStore({ db: d, clock: h.clock }) });
    assert.equal(code, 0, h.err.join('\n'));
    assert.equal(h.tokens.size(), 0, 'both credentials deleted');
    assert.deepEqual(s.requests.filter((r) => r.path === '/revoke').map((r) => r.form.get('token')).sort(), ['g-send-rt', 'read-rt']);
    const report = JSON.parse(rout.slice(0, -1).join('\n')) as { purge: { id: string; counts: Record<string, number>; memory: { facts: number } } };
    assert.equal(report.purge.counts.mailItems, 2);
    assert.equal(report.purge.counts.mailSyncState, 1);
    assert.equal(report.purge.counts.mailSyncLog, 1);
    assert.equal(report.purge.memory.facts, 1);

    const db2 = openDatabase(join(home, 'potts.db'));
    try {
      migrate(db2);
      assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE account_id = 'gmail-personal'").get() as { n: number }).n, 0);
      assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM mail_items WHERE account_id = 'other-account'").get() as { n: number }).n, 1);
      assert.equal(db2.prepare("SELECT 1 FROM mail_sync_state WHERE account_id = 'gmail-personal'").get(), undefined);
      const mem2 = createMemoryStore({ db: db2, clock: h.clock });
      assert.equal(mem2.search('Dentist').length, 0);
      assert.equal(mem2.search('short replies').length, 1);
      const rec = listAccountPurgeReceipts(db2, 'gmail-personal');
      assert.equal(rec.length, 1);
      assert.equal(rec[0]!.id, report.purge.id);
      assert.equal(rec[0]!.counts.mailItems, 2);
      assert.ok(rec[0]!.memory?.receiptId);
      const audit = createAuditLedger(db2, h.clock).list({ limit: 50 }).filter((e) => e.type === 'account_purge');
      assert.equal(audit.length, 1);
      assert.ok(!JSON.stringify(audit).includes('Dentist') && !JSON.stringify(audit).includes('See you at 7'), 'receipt and audit are content-free');
      const st = createAccountStatusStore(db2, h.clock);
      assert.equal(st.get('gmail-personal')?.status, 'revoked');
      assert.equal(st.get('gmail-personal.send')?.status, 'revoked');
    } finally {
      db2.close();
    }
  } finally {
    await s.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dry-run --purpose send prints the plan without network or writes', async () => {
  const home = makeHome();
  try {
    const out: string[] = [];
    const code = await runConnectAccountCli(['--account', 'outlook-personal', '--purpose', 'send', '--dry-run'], {
      home, fetch: async () => { throw new Error('no network in dry run'); }, clock: createFakeClock('2026-10-06T14:00:00Z'), sleep: async () => {},
      out: (l) => out.push(l), err: (l) => out.push(l), openBrowser: () => { throw new Error('no browser'); },
    });
    assert.equal(code, 0);
    const plan = JSON.parse(out.join('\n')) as Record<string, unknown>;
    assert.deepEqual(plan.scopes, ['Mail.Send', 'Mail.ReadWrite', 'offline_access', 'User.Read']);
    assert.match(String(plan.tokenStore), /"outlook-personal\.send"/);
    assert.match(String(plan.missing), /sendClientId/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
