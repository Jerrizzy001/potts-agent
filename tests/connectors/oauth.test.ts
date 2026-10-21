import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { makeEnv, tokenSet } from './helpers.ts';
import {
  brokerReadGate, brokerRevocationSink, checkGoogleScopes, checkMicrosoftScopes, classifyMicrosoftError, connectAccount, createAccessTokenProvider,
  createAccountStatusStore, createKeychainTokenStore, createMemoryTokenStore, createPkcePair, refreshGoogleToken, refreshMicrosoftToken, revokeAccount,
  runGoogleLoopbackConsent, tokenProviderFor, type GoogleOAuthConfig, type MicrosoftOAuthConfig, type SecurityRunner,
} from '../../src/connectors/oauth/index.ts';
import { createTestHarness } from '../../src/broker/testing.ts';

const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';

function googleConfig(s: FakeServer): GoogleOAuthConfig {
  return { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', authEndpoint: `${s.base}/auth`, tokenEndpoint: `${s.base}/token`, revokeEndpoint: `${s.base}/revoke`, gmailApiBase: `${s.base}/gmail/v1` };
}
function msConfig(s: FakeServer): MicrosoftOAuthConfig {
  return { clientId: '11111111-2222-3333-4444-555555555555', authorityBase: s.base, graphBase: `${s.base}/graph` };
}

/** Simulates the owner's browser: returns to the loopback redirect with a code. */
function browser(opts: { captured: { url?: URL }; state?: string; error?: string }) {
  return async (url: string) => {
    const u = new URL(url);
    opts.captured.url = u;
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', opts.state ?? u.searchParams.get('state')!);
    if (opts.error) redirect.searchParams.set('error', opts.error);
    else redirect.searchParams.set('code', 'auth-code-1');
    await fetch(redirect);
  };
}

function googleTokenRoute(s: FakeServer, captured: { url?: URL }, scope = GMAIL_RO) {
  s.route('POST', '/token', (r) => {
    if (r.form.get('grant_type') === 'authorization_code') {
      const challenge = captured.url!.searchParams.get('code_challenge');
      const ok = createHash('sha256').update(r.form.get('code_verifier')!).digest('base64url') === challenge && r.form.get('code') === 'auth-code-1';
      if (!ok) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3599, scope, token_type: 'Bearer' } };
    }
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  });
  s.route('POST', '/revoke', () => ({ status: 200, text: '' }));
}

test('PKCE pair is S256 of the verifier', () => {
  const p = createPkcePair();
  assert.equal(p.challenge, createHash('sha256').update(p.verifier).digest('base64url'));
  assert.ok(p.verifier.length >= 43);
});

test('scope checks reject write-capable scopes', () => {
  assert.ok(checkGoogleScopes(GMAIL_RO).ok);
  for (const bad of ['https://www.googleapis.com/auth/gmail.compose', 'https://mail.google.com/', `${GMAIL_RO} https://www.googleapis.com/auth/gmail.modify`, 'https://www.googleapis.com/auth/drive'])
    assert.equal(checkGoogleScopes(bad).ok, false, bad);
  assert.ok(checkMicrosoftScopes('https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read profile openid').ok);
  assert.equal(checkMicrosoftScopes('Mail.Read Mail.Send').ok, false);
  assert.equal(checkMicrosoftScopes('User.Read').ok, false);
});

test('Google loopback consent: PKCE, gmail.readonly only, login_hint, verified mailbox', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const captured: { url?: URL } = {};
    googleTokenRoute(s, captured);
    s.route('GET', '/gmail/v1/users/me/profile', (r) => (r.headers.authorization === 'Bearer g-at' ? { json: { emailAddress: 'Owner@Example.com', historyId: '1' } } : { status: 401, json: {} }));
    const r = await runGoogleLoopbackConsent({ config: googleConfig(s), expectedAddress: 'owner@example.com', fetch, clock: env.clock, openBrowser: browser({ captured }) });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    const u = captured.url!;
    assert.equal(u.searchParams.get('scope'), GMAIL_RO);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('login_hint'), 'owner@example.com');
    assert.equal(u.searchParams.get('include_granted_scopes'), null);
    assert.match(u.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(r.value.refreshToken, 'g-rt');
    assert.equal(r.value.accountAddress, 'owner@example.com');
    assert.equal(s.requests.filter((q) => q.path === '/revoke').length, 0);
  } finally {
    await s.close();
    env.close();
  }
});

test('Google consent for a different mailbox is rejected, revoked and nothing is stored', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const captured: { url?: URL } = {};
    googleTokenRoute(s, captured);
    s.route('GET', '/gmail/v1/users/me/profile', () => ({ json: { emailAddress: 'someone.else@example.com' } }));
    const tokens = createMemoryTokenStore();
    const status = createAccountStatusStore(env.db, env.clock);
    const r = await connectAccount({
      accountId: 'gmail-personal', provider: 'google', expectedAddress: 'owner@example.com', configs: { google: googleConfig(s) }, tokenStore: tokens, statusStore: status,
      fetch, clock: env.clock, sleep: env.sleep, openBrowser: browser({ captured }), onDeviceCode: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, 'account_mismatch');
    assert.equal(tokens.size(), 0);
    assert.equal(status.get('gmail-personal'), undefined);
    const rev = s.requests.find((q) => q.path === '/revoke');
    assert.ok(rev, 'provider revocation endpoint called');
    assert.equal(rev.form.get('token'), 'g-rt');
  } finally {
    await s.close();
    env.close();
  }
});

test('Google grant with a write scope is rejected and revoked', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const captured: { url?: URL } = {};
    googleTokenRoute(s, captured, `${GMAIL_RO} https://www.googleapis.com/auth/gmail.send`);
    const r = await runGoogleLoopbackConsent({ config: googleConfig(s), expectedAddress: 'owner@example.com', fetch, clock: env.clock, openBrowser: browser({ captured }) });
    assert.equal(!r.ok && r.error.code, 'scope_rejected');
    assert.ok(s.requests.some((q) => q.path === '/revoke'));
  } finally {
    await s.close();
    env.close();
  }
});

test('Google callback with wrong state or denied consent fails closed', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const captured: { url?: URL } = {};
    googleTokenRoute(s, captured);
    const bad = await runGoogleLoopbackConsent({ config: googleConfig(s), expectedAddress: 'owner@example.com', fetch, clock: env.clock, openBrowser: browser({ captured, state: 'forged' }) });
    assert.equal(!bad.ok && bad.error.code, 'state_mismatch');
    const denied = await runGoogleLoopbackConsent({ config: googleConfig(s), expectedAddress: 'owner@example.com', fetch, clock: env.clock, openBrowser: browser({ captured, error: 'access_denied' }) });
    assert.equal(!denied.ok && denied.error.code, 'consent_denied');
    assert.equal(s.requests.filter((q) => q.path === '/token').length, 0);
  } finally {
    await s.close();
    env.close();
  }
});

test('Microsoft device code: pending, slow_down, success; identity verified', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    s.route('POST', '/organizations/oauth2/v2.0/devicecode', (r) => {
      assert.equal(r.form.get('scope'), 'Mail.Read offline_access User.Read');
      return { json: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, message: 'enter ABCD-EFGH' } };
    });
    let polls = 0;
    s.route('POST', '/organizations/oauth2/v2.0/token', () => {
      polls++;
      if (polls === 1) return { status: 400, json: { error: 'authorization_pending' } };
      if (polls === 2) return { status: 400, json: { error: 'slow_down' } };
      return { json: { access_token: 'm-at', refresh_token: 'm-rt', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read', token_type: 'Bearer' } };
    });
    s.route('GET', '/graph/me', () => ({ json: { mail: null, userPrincipalName: 'Student@Example.edu' } }));
    const tokens = createMemoryTokenStore();
    const status = createAccountStatusStore(env.db, env.clock);
    let prompt = '';
    const r = await connectAccount({
      accountId: 'outlook-work', provider: 'microsoft', expectedAddress: 'student@example.edu', configs: { microsoft: msConfig(s) }, tokenStore: tokens, statusStore: status,
      fetch, clock: env.clock, sleep: env.sleep, openBrowser: () => {}, onDeviceCode: (p) => void (prompt = p.userCode),
    });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    assert.equal(prompt, 'ABCD-EFGH');
    assert.deepEqual(env.sleeps, [5000, 5000, 10000]);
    assert.equal(status.get('outlook-work')?.status, 'connected');
    assert.equal(status.get('outlook-work')?.consentedAddress, 'student@example.edu');
    assert.equal((await tokens.get('outlook-work'))?.refreshToken, 'm-rt');
  } finally {
    await s.close();
    env.close();
  }
});

test('Microsoft AADSTS65001 is reported as admin_consent_required, not retried', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    s.route('POST', '/organizations/oauth2/v2.0/devicecode', () => ({ json: { device_code: 'dc', user_code: 'X', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 } }));
    let polls = 0;
    s.route('POST', '/organizations/oauth2/v2.0/token', () => {
      polls++;
      return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.', error_codes: [65001] } };
    });
    const tokens = createMemoryTokenStore();
    const status = createAccountStatusStore(env.db, env.clock);
    const r = await connectAccount({
      accountId: 'outlook-work', provider: 'microsoft', expectedAddress: 'student@example.edu', configs: { microsoft: msConfig(s) }, tokenStore: tokens, statusStore: status,
      fetch, clock: env.clock, sleep: env.sleep, openBrowser: () => {}, onDeviceCode: () => {},
    });
    assert.equal(!r.ok && r.error.code, 'admin_consent_required');
    assert.equal(polls, 1);
    assert.equal(status.get('outlook-work')?.status, 'admin_consent_required');
    assert.equal(tokens.size(), 0);
    assert.equal(classifyMicrosoftError(403, { error: 'access_denied', error_description: 'AADSTS90094: The grant requires admin permission.' }).code, 'admin_consent_required');
  } finally {
    await s.close();
    env.close();
  }
});

test('Microsoft sign-in as another user is rejected', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    s.route('POST', '/organizations/oauth2/v2.0/devicecode', () => ({ json: { device_code: 'dc', user_code: 'X', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 } }));
    s.route('POST', '/organizations/oauth2/v2.0/token', () => ({ json: { access_token: 'm-at', refresh_token: 'm-rt', expires_in: 3600, scope: 'Mail.Read User.Read' } }));
    s.route('GET', '/graph/me', () => ({ json: { mail: 'other@example.edu', userPrincipalName: 'other@example.edu' } }));
    const tokens = createMemoryTokenStore();
    const r = await connectAccount({
      accountId: 'outlook-work', provider: 'microsoft', expectedAddress: 'student@example.edu', configs: { microsoft: msConfig(s) }, tokenStore: tokens,
      statusStore: createAccountStatusStore(env.db, env.clock), fetch, clock: env.clock, sleep: env.sleep, openBrowser: () => {}, onDeviceCode: () => {},
    });
    assert.equal(!r.ok && r.error.code, 'account_mismatch');
    assert.equal(tokens.size(), 0);
  } finally {
    await s.close();
    env.close();
  }
});

test('token provider refreshes expired tokens; invalid_grant → stale_auth (sticky, explicit)', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    let refreshCalls = 0;
    let fail = false;
    s.route('POST', '/token', (r) => {
      refreshCalls++;
      assert.equal(r.form.get('grant_type'), 'refresh_token');
      if (fail) return { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      return { json: { access_token: `g-at-${refreshCalls}`, expires_in: 3600, scope: GMAIL_RO } };
    });
    const tokens = createMemoryTokenStore();
    const status = createAccountStatusStore(env.db, env.clock);
    await tokens.set('gmail-personal', tokenSet('google', env.clock.nowIso()));
    status.set({ accountId: 'gmail-personal', provider: 'google', status: 'connected', statusReason: null, consentedAddress: 'owner@example.com', scopes: GMAIL_RO });
    const p = tokenProviderFor('gmail-personal', 'google', { google: googleConfig(s) }, { tokenStore: tokens, statusStore: status, fetch, clock: env.clock });
    assert.deepEqual(await p.getAccessToken(), { ok: true, value: 'at-1' });
    assert.equal(refreshCalls, 0);
    env.clock.advanceSeconds(3600);
    assert.deepEqual(await p.getAccessToken(), { ok: true, value: 'g-at-1' });
    assert.equal((await tokens.get('gmail-personal'))?.refreshToken, 'rt-1', 'Google refresh token kept');
    fail = true;
    const r = await p.getAccessToken(true);
    assert.equal(!r.ok && r.error.code, 'stale_auth');
    assert.equal(status.get('gmail-personal')?.status, 'stale_auth');
    const again = await p.getAccessToken(true);
    assert.equal(!again.ok && again.error.code, 'stale_auth');
    assert.equal(refreshCalls, 2, 'no further refresh attempts once stale');
  } finally {
    await s.close();
    env.close();
  }
});

test('Microsoft refresh stores the rotated refresh token; AADSTS700082 → stale_auth', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    let n = 0;
    s.route('POST', '/organizations/oauth2/v2.0/token', () => {
      n++;
      if (n === 1) return { json: { access_token: 'm-at-2', refresh_token: 'm-rt-2', expires_in: 3600, scope: 'Mail.Read User.Read' } };
      return { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.' } };
    });
    const t = tokenSet('microsoft', env.clock.nowIso());
    const r1 = await refreshMicrosoftToken(msConfig(s), t, { fetch, clock: env.clock });
    assert.ok(r1.ok);
    assert.equal(r1.value.refreshToken, 'm-rt-2');
    const r2 = await refreshMicrosoftToken(msConfig(s), r1.value, { fetch, clock: env.clock });
    assert.equal(!r2.ok && r2.error.code, 'stale_auth');
    const g = await refreshGoogleToken({ clientId: 'x', clientSecret: 'y', tokenEndpoint: `${s.base}/nope` }, tokenSet('google', env.clock.nowIso()), { fetch, clock: env.clock });
    assert.equal(g.ok, false);
  } finally {
    await s.close();
    env.close();
  }
});

test('revoke: provider revocation, local tokens deleted, status revoked, broker control revoked', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  const h = createTestHarness();
  try {
    s.route('POST', '/revoke', () => ({ status: 200, text: '' }));
    const tokens = createMemoryTokenStore();
    const status = createAccountStatusStore(env.db, env.clock);
    await tokens.set('gmail-personal', tokenSet('google', env.clock.nowIso()));
    status.set({ accountId: 'gmail-personal', provider: 'google', status: 'connected', statusReason: null, consentedAddress: 'owner@example.com', scopes: GMAIL_RO });
    const r = await revokeAccount({
      accountId: 'gmail-personal', provider: 'google', configs: { google: googleConfig(s) }, tokenStore: tokens, statusStore: status, fetch,
      sink: brokerRevocationSink(h.broker), actor: 'owner:test',
    });
    assert.deepEqual(r, { provider: 'revoked', localTokensDeleted: true, brokerMarked: true });
    assert.equal(s.requests.find((q) => q.path === '/revoke')?.form.get('token'), 'rt-1');
    assert.equal(tokens.size(), 0);
    assert.equal(status.get('gmail-personal')?.status, 'revoked');
    assert.ok(h.broker.controls().revokedAccounts.includes('gmail-personal'));
    const p = h.broker.propose({ kind: 'send_message', accountId: 'gmail-personal', destination: ['x@example.com'], payload: { body: 'hi' } }, 'test');
    assert.ok(p.ok);
    assert.equal(p.value.decision, 'deny');
    assert.equal(brokerReadGate(h.broker)('gmail-personal', 'gmail').ok, false);
    // Token provider refuses after revocation.
    const prov = createAccessTokenProvider({ accountId: 'gmail-personal', provider: 'google', tokenStore: tokens, statusStore: status, clock: env.clock, refresh: async () => { throw new Error('must not refresh'); } });
    const tr = await prov.getAccessToken();
    assert.equal(!tr.ok && tr.error.code, 'revoked');
    // Microsoft: no provider endpoint; local deletion still happens.
    await tokens.set('outlook-work', tokenSet('microsoft', env.clock.nowIso()));
    const m = await revokeAccount({ accountId: 'outlook-work', provider: 'microsoft', configs: {}, tokenStore: tokens, statusStore: status, fetch, actor: 'owner:test' });
    assert.equal(m.provider, 'not_supported');
    assert.equal(m.localTokensDeleted, true);
    assert.ok(m.note);
  } finally {
    h.close();
    await s.close();
    env.close();
  }
});

test('Keychain token store never puts the secret on argv', async () => {
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  let stored: string | null = null;
  const runner: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === '-i') {
      const m = /-X ([0-9a-f]+)/.exec(stdin ?? '');
      stored = m ? Buffer.from(m[1]!, 'hex').toString('utf8') : null;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') return stored ? { code: 0, stdout: stored + '\n', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
    if (args[0] === 'delete-generic-password') {
      const had = stored !== null;
      stored = null;
      return { code: had ? 0 : 44, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const ks = createKeychainTokenStore({ runner });
  assert.equal(await ks.get('gmail-personal'), undefined);
  const t = tokenSet('google', '2026-10-06T14:00:00.000Z', { refreshToken: 'super-secret-refresh "quoted" token' });
  await ks.set('gmail-personal', t);
  assert.deepEqual(await ks.get('gmail-personal'), t);
  for (const c of calls) assert.ok(!c.args.join(' ').includes('super-secret'), `secret leaked on argv: ${c.args.join(' ')}`);
  const add = calls.find((c) => c.args[0] === '-i')!;
  assert.match(add.stdin!, /^add-generic-password -U -s potts-oauth -a gmail-personal -l potts-oauth-gmail-personal -X [0-9a-f]+\n$/);
  await ks.delete('gmail-personal');
  await ks.delete('gmail-personal'); // not found is fine
  assert.equal(await ks.get('gmail-personal'), undefined);
  await assert.rejects(() => ks.get('bad id; rm'), /account id/);
});
