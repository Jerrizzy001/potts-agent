import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from './errors.ts';
import { postForm, readerGet, realSleep, type FetchLike } from './http.ts';
import { createPkcePair, randomState, safeEqualStr } from './pkce.ts';
import {
  GOOGLE_DEFAULTS, GOOGLE_FORBIDDEN_SCOPES, GOOGLE_GMAIL_READONLY, GOOGLE_GMAIL_SEND, GOOGLE_IDENTITY_SCOPES, GOOGLE_SEND_SCOPES, normalizeAddress,
  type CredentialPurpose, type GoogleOAuthConfig, type OAuthTokenSet,
} from './types.ts';

/** Scopes Potts accepts back from Google. Anything else (in particular any write scope) is rejected. */
const GOOGLE_ACCEPTED_SCOPES = new Set([GOOGLE_GMAIL_READONLY]);
/** A send credential: gmail.send plus identity scopes only. Never readonly/modify/compose/full mail. */
const GOOGLE_SEND_ACCEPTED_SCOPES = new Set<string>([GOOGLE_GMAIL_SEND, ...GOOGLE_IDENTITY_SCOPES]);

const ep = (c: GoogleOAuthConfig) => ({
  auth: c.authEndpoint ?? GOOGLE_DEFAULTS.authEndpoint,
  token: c.tokenEndpoint ?? GOOGLE_DEFAULTS.tokenEndpoint,
  revoke: c.revokeEndpoint ?? GOOGLE_DEFAULTS.revokeEndpoint,
  gmail: c.gmailApiBase ?? GOOGLE_DEFAULTS.gmailApiBase,
  userinfo: c.userinfoEndpoint ?? GOOGLE_DEFAULTS.userinfoEndpoint,
});

/**
 * Validates the granted scope string.
 * - read: must contain gmail.readonly and nothing that can write.
 * - send: must contain gmail.send, may contain only identity scopes besides it (no read, modify, compose or full mail).
 */
export function checkGoogleScopes(scope: string, purpose: CredentialPurpose = 'read'): Result<string, ConnectorError> {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (purpose === 'send') {
    const unexpected = granted.filter((s) => !GOOGLE_SEND_ACCEPTED_SCOPES.has(s));
    if (unexpected.length) return cerr('scope_rejected', `Google granted scopes beyond gmail.send (${unexpected.join(', ')}); a send credential may hold only gmail.send`);
    if (!granted.includes(GOOGLE_GMAIL_SEND)) return cerr('scope_rejected', 'gmail.send was not granted');
    return ok(granted.join(' '));
  }
  const forbidden = granted.filter((s) => (GOOGLE_FORBIDDEN_SCOPES as readonly string[]).includes(s));
  if (forbidden.length) return cerr('scope_rejected', `Google granted write-capable scopes (${forbidden.join(', ')}); Potts only accepts gmail.readonly`);
  const unexpected = granted.filter((s) => !GOOGLE_ACCEPTED_SCOPES.has(s));
  if (unexpected.length) return cerr('scope_rejected', `Google granted unexpected scopes (${unexpected.join(', ')}); re-run consent without include_granted_scopes`);
  if (!granted.includes(GOOGLE_GMAIL_READONLY)) return cerr('scope_rejected', 'gmail.readonly was not granted');
  return ok(granted.join(' '));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function mapGoogleTokenError(status: number, body: TokenResponse | null): ConnectorError {
  const e = body?.error ?? `http_${status}`;
  if (e === 'invalid_grant')
    return { code: 'stale_auth', message: 'Google refresh token is expired or revoked (invalid_grant); the owner must reconnect the account', providerError: e, status };
  if (e === 'invalid_client' || e === 'unauthorized_client')
    return { code: 'config', message: `Google rejected the OAuth client (${e}); check the Desktop client id/secret`, providerError: e, status };
  if (e === 'access_denied') return { code: 'consent_denied', message: 'consent was denied', providerError: e, status };
  return { code: 'http_error', message: `Google token endpoint error (${e})`, providerError: e, status };
}

/** Exchanges a refresh token for a new access token. invalid_grant → stale_auth. */
export async function refreshGoogleToken(
  config: GoogleOAuthConfig, tokens: OAuthTokenSet, deps: { fetch: FetchLike; clock: Clock }, purpose: CredentialPurpose = 'read',
): Promise<Result<OAuthTokenSet, ConnectorError>> {
  const r = await postForm(deps.fetch, ep(config).token, {
    grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: config.clientId, client_secret: config.clientSecret,
  });
  if (!r.ok) return r;
  const body = r.value.body as TokenResponse | null;
  if (r.value.status !== 200 || !body?.access_token) return { ok: false, error: mapGoogleTokenError(r.value.status, body) };
  let scope = tokens.scope;
  if (body.scope) {
    const sc = checkGoogleScopes(body.scope, purpose);
    if (!sc.ok) return sc;
    scope = sc.value;
  }
  return ok({
    ...tokens,
    accessToken: body.access_token,
    accessTokenExpiresAt: new Date(deps.clock.nowMs() + (body.expires_in ?? 3600) * 1000).toISOString(),
    // Google normally does not rotate refresh tokens; keep the old one unless a new one is returned.
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    scope,
    tokenType: body.token_type ?? tokens.tokenType,
  });
}

/** Revokes a Google token at the provider. An already-invalid token counts as revoked. */
export async function revokeGoogleToken(config: GoogleOAuthConfig, token: string, deps: { fetch: FetchLike }): Promise<Result<'revoked' | 'already_invalid', ConnectorError>> {
  const r = await postForm(deps.fetch, ep(config).revoke, { token });
  if (!r.ok) return r;
  if (r.value.status === 200) return ok('revoked');
  const e = (r.value.body as { error?: string } | null)?.error;
  if (r.value.status === 400 && (e === 'invalid_token' || e === 'invalid_request')) return ok('already_invalid');
  return cerr('http_error', `Google revocation failed (${r.value.status})`, { status: r.value.status });
}

/** Reads the mailbox address the access token belongs to (gmail users/me/profile; works with gmail.readonly). */
export async function fetchGmailProfileAddress(config: GoogleOAuthConfig, accessToken: string, deps: { fetch: FetchLike; clock: Clock }): Promise<Result<string, ConnectorError>> {
  const r = await readerGet(`${ep(config).gmail}/users/me/profile`, {
    fetch: deps.fetch, clock: deps.clock, sleep: realSleep, maxRetries: 2, headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return r;
  const email = (r.value.body as { emailAddress?: string } | null)?.emailAddress;
  if (r.value.status !== 200 || !email) return cerr('invalid_response', `could not read Gmail profile (${r.value.status})`, { status: r.value.status });
  return ok(email);
}

/**
 * Reads the verified e-mail address of the Google account behind an access token (OpenID userinfo; needs the
 * `email` scope). Used for send-only grants, whose gmail.send scope cannot read users/me/profile.
 */
export async function fetchGoogleUserinfoAddress(config: GoogleOAuthConfig, accessToken: string, deps: { fetch: FetchLike; clock: Clock }): Promise<Result<string, ConnectorError>> {
  const r = await readerGet(ep(config).userinfo, {
    fetch: deps.fetch, clock: deps.clock, sleep: realSleep, maxRetries: 2, headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return r;
  const b = r.value.body as { email?: string; email_verified?: boolean | string } | null;
  if (r.value.status !== 200 || !b?.email) return cerr('invalid_response', `could not read the Google account identity (${r.value.status})`, { status: r.value.status });
  if (b.email_verified === false || b.email_verified === 'false') return cerr('account_mismatch', 'Google reports the account e-mail as unverified');
  return ok(b.email);
}

export interface GoogleConsentOptions {
  config: GoogleOAuthConfig;
  /** Registered address for this Potts account; the consented mailbox must equal it. */
  expectedAddress: string;
  fetch: FetchLike;
  clock: Clock;
  /** Opens the consent URL for the owner (CLI uses `open`). Tests simulate the browser. */
  openBrowser: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  /** read (default): gmail.readonly. send: a separate gmail.send grant (+ openid email for identity). */
  purpose?: CredentialPurpose;
}

/**
 * Installed-app loopback flow with PKCE (RFC 8252 + RFC 7636):
 * 1. listen on 127.0.0.1:<random port>; 2. open the consent URL (scope gmail.readonly only,
 * access_type=offline, prompt=consent, login_hint=<registered address>, no include_granted_scopes);
 * 3. receive the code, check `state`; 4. exchange code + verifier; 5. reject write scopes;
 * 6. verify the mailbox address equals the registered address, otherwise revoke and reject.
 * Nothing is persisted here; the caller stores the returned tokens.
 */
export async function runGoogleLoopbackConsent(o: GoogleConsentOptions): Promise<Result<OAuthTokenSet, ConnectorError>> {
  const pkce = createPkcePair();
  const state = randomState();
  const e = ep(o.config);
  const purpose = o.purpose ?? 'read';
  let server: Server | undefined;
  const callback = new Promise<Result<string, ConnectorError>>((resolveCb) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, msg: string, out: Result<string, ConnectorError>) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><title>Potts</title><p>${msg}</p>`);
        resolveCb(out);
      };
      const gotState = url.searchParams.get('state') ?? '';
      if (!safeEqualStr(gotState, state)) {
        finish(400, 'State mismatch. Close this window and run the command again.', cerr('state_mismatch', 'OAuth state mismatch (possible CSRF); aborted'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        finish(400, 'Consent was not granted. You can close this window.', cerr('consent_denied', `consent not granted (${error})`, { providerError: error }));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        finish(400, 'Missing authorization code.', cerr('invalid_response', 'callback without code'));
        return;
      }
      finish(200, 'Potts received the authorization. You can close this window.', ok(code));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const port = (server!.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const authUrl = new URL(e.auth);
    authUrl.search = new URLSearchParams({
      client_id: o.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: purpose === 'send' ? GOOGLE_SEND_SCOPES.join(' ') : GOOGLE_GMAIL_READONLY,
      access_type: 'offline',
      prompt: 'consent',
      login_hint: o.expectedAddress,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    }).toString();
    await o.openBrowser(authUrl.toString());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Result<string, ConnectorError>>((r) => {
      timer = setTimeout(() => r(cerr('consent_timeout', 'no consent callback received in time')), o.timeoutMs ?? 5 * 60_000);
    });
    const codeR = await Promise.race([callback, timeout]);
    clearTimeout(timer);
    if (!codeR.ok) return codeR;

    const tr = await postForm(o.fetch, e.token, {
      grant_type: 'authorization_code', code: codeR.value, code_verifier: pkce.verifier, redirect_uri: redirectUri,
      client_id: o.config.clientId, client_secret: o.config.clientSecret,
    });
    if (!tr.ok) return tr;
    const body = tr.value.body as TokenResponse | null;
    if (tr.value.status !== 200 || !body?.access_token) return { ok: false, error: mapGoogleTokenError(tr.value.status, body) };
    const revokeAndFail = async (error: ConnectorError): Promise<Result<OAuthTokenSet, ConnectorError>> => {
      await revokeGoogleToken(o.config, body.refresh_token ?? body.access_token!, { fetch: o.fetch });
      return { ok: false, error };
    };
    const sc = checkGoogleScopes(body.scope ?? '', purpose);
    if (!sc.ok) return revokeAndFail(sc.error);
    if (!body.refresh_token)
      return revokeAndFail({ code: 'invalid_response', message: 'Google returned no refresh token; remove the earlier Potts grant at myaccount.google.com/permissions and retry' });
    const prof = purpose === 'send' ? await fetchGoogleUserinfoAddress(o.config, body.access_token, o) : await fetchGmailProfileAddress(o.config, body.access_token, o);
    if (!prof.ok) return revokeAndFail(prof.error);
    if (normalizeAddress(prof.value) !== normalizeAddress(o.expectedAddress))
      return revokeAndFail({ code: 'account_mismatch', message: `consent was granted for a different mailbox than the registered address ${o.expectedAddress}; token revoked` });
    return ok({
      provider: 'google',
      accessToken: body.access_token,
      accessTokenExpiresAt: new Date(o.clock.nowMs() + (body.expires_in ?? 3600) * 1000).toISOString(),
      refreshToken: body.refresh_token,
      scope: sc.value,
      tokenType: body.token_type ?? 'Bearer',
      accountAddress: normalizeAddress(prof.value),
      obtainedAt: o.clock.nowIso(),
    });
  } finally {
    server!.closeAllConnections?.();
    server!.close();
  }
}
