import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError, type ConnectorErrorCode } from './errors.ts';
import { postForm, readerGet, type FetchLike, type Sleep } from './http.ts';
import {
  MICROSOFT_DEFAULTS, MICROSOFT_FORBIDDEN_SCOPES, MICROSOFT_READ_SCOPES, MICROSOFT_SEND_FORBIDDEN_SCOPES, MICROSOFT_SEND_SCOPES, normalizeAddress,
  type CredentialPurpose, type MicrosoftOAuthConfig, type OAuthTokenSet,
} from './types.ts';

const ep = (c: MicrosoftOAuthConfig) => {
  const base = `${c.authorityBase ?? MICROSOFT_DEFAULTS.authorityBase}/${encodeURIComponent(c.tenant ?? MICROSOFT_DEFAULTS.tenant)}/oauth2/v2.0`;
  return { device: `${base}/devicecode`, token: `${base}/token`, graph: c.graphBase ?? MICROSOFT_DEFAULTS.graphBase };
};

const SCOPE_PARAM = MICROSOFT_READ_SCOPES.join(' ');
const scopeParam = (purpose: CredentialPurpose) => (purpose === 'send' ? MICROSOFT_SEND_SCOPES.join(' ') : SCOPE_PARAM);

/** AADSTS codes meaning the tenant requires an administrator to consent. Reported as a blocker, never retried. */
export const ADMIN_CONSENT_AADSTS = ['65001', '90094', '90095', '900941'];
/** AADSTS codes meaning the refresh token / session can no longer be used (re-consent needed). */
const STALE_AADSTS = ['700082', '700084', '70008', '50173', '700081', '70000', '50076', '50079', '50158', '50078', '54005'];

interface MsErrorBody {
  error?: string;
  error_description?: string;
  error_codes?: number[];
}

/** Maps an Entra ID error body to a connector error code. Exported for tests and for Graph 401/403 handling. */
export function classifyMicrosoftError(status: number, body: MsErrorBody | null): ConnectorError {
  const desc = body?.error_description ?? '';
  const codes = new Set<string>((body?.error_codes ?? []).map(String));
  for (const m of desc.matchAll(/AADSTS(\d+)/g)) codes.add(m[1]!);
  const first = [...codes][0];
  const providerError = first ? `AADSTS${first}` : (body?.error ?? `http_${status}`);
  const mk = (code: ConnectorErrorCode, message: string): ConnectorError => ({ code, message, providerError, status });
  if (ADMIN_CONSENT_AADSTS.some((c) => codes.has(c)) || /admin(istrator)? (consent|approval)|need admin approval/i.test(desc))
    return mk('admin_consent_required', 'the tenant requires administrator consent for this app (Mail.Read); ask organization IT or use an approved app. Not retried.');
  if (codes.has('65004') || body?.error === 'authorization_declined' || body?.error === 'access_denied') return mk('consent_denied', 'consent was declined');
  if (body?.error === 'expired_token') return mk('consent_timeout', 'the device code expired before sign-in completed');
  if (body?.error === 'invalid_grant' || body?.error === 'interaction_required' || STALE_AADSTS.some((c) => codes.has(c)))
    return mk('stale_auth', 'Microsoft refresh token is expired, revoked or needs interactive sign-in; the owner must reconnect the account');
  if (body?.error === 'invalid_client' || body?.error === 'unauthorized_client') return mk('config', `Microsoft rejected the app registration (${body.error}); enable "Allow public client flows"`);
  return mk('http_error', `Microsoft identity error (${providerError})`);
}

/**
 * Normalizes Graph scope strings ("https://graph.microsoft.com/Mail.Read" → "Mail.Read") and validates them.
 * read: Mail.Read and nothing that writes. send: Mail.Send + Mail.ReadWrite, never shared-mailbox or settings scopes.
 */
export function checkMicrosoftScopes(scope: string, purpose: CredentialPurpose = 'read'): Result<string, ConnectorError> {
  const granted = scope.split(/\s+/).filter(Boolean).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ''));
  const lower = granted.map((s) => s.toLowerCase());
  if (purpose === 'send') {
    const bad = MICROSOFT_SEND_FORBIDDEN_SCOPES.filter((f) => lower.includes(f.toLowerCase()));
    if (bad.length) return cerr('scope_rejected', `Microsoft granted scopes Potts never accepts (${bad.join(', ')})`);
    const missing = ['mail.send', 'mail.readwrite'].filter((m) => !lower.includes(m));
    if (missing.length) return cerr('scope_rejected', `send credential is missing ${missing.join(', ')}`);
    return ok(granted.join(' '));
  }
  const forbidden = MICROSOFT_FORBIDDEN_SCOPES.filter((f) => lower.includes(f.toLowerCase()));
  if (forbidden.length) return cerr('scope_rejected', `Microsoft granted write-capable scopes (${forbidden.join(', ')}); Potts only accepts Mail.Read`);
  if (!lower.includes('mail.read')) return cerr('scope_rejected', 'Mail.Read was not granted');
  return ok(granted.join(' '));
}

interface MsTokenBody extends MsErrorBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

function toTokenSet(body: MsTokenBody, scope: string, address: string, clock: Clock, prevRefresh?: string): OAuthTokenSet {
  return {
    provider: 'microsoft',
    accessToken: body.access_token!,
    accessTokenExpiresAt: new Date(clock.nowMs() + (body.expires_in ?? 3600) * 1000).toISOString(),
    refreshToken: body.refresh_token ?? prevRefresh ?? '',
    scope,
    tokenType: body.token_type ?? 'Bearer',
    accountAddress: address,
    obtainedAt: clock.nowIso(),
  };
}

/** Refresh (Microsoft rotates refresh tokens; the new one is returned and must be stored). */
export async function refreshMicrosoftToken(
  config: MicrosoftOAuthConfig, tokens: OAuthTokenSet, deps: { fetch: FetchLike; clock: Clock }, purpose: CredentialPurpose = 'read',
): Promise<Result<OAuthTokenSet, ConnectorError>> {
  const r = await postForm(deps.fetch, ep(config).token, {
    grant_type: 'refresh_token', client_id: config.clientId, refresh_token: tokens.refreshToken, scope: scopeParam(purpose),
  });
  if (!r.ok) return r;
  const body = r.value.body as MsTokenBody | null;
  if (r.value.status !== 200 || !body?.access_token) return { ok: false, error: classifyMicrosoftError(r.value.status, body) };
  const sc = checkMicrosoftScopes(body.scope ?? tokens.scope, purpose);
  if (!sc.ok) return sc;
  return ok({ ...toTokenSet(body, sc.value, tokens.accountAddress, deps.clock, tokens.refreshToken), obtainedAt: tokens.obtainedAt });
}

/** Reads /me and returns {mail, userPrincipalName}. */
export async function fetchGraphIdentity(
  config: MicrosoftOAuthConfig, accessToken: string, deps: { fetch: FetchLike; clock: Clock; sleep: Sleep },
): Promise<Result<{ mail: string | null; upn: string | null }, ConnectorError>> {
  const r = await readerGet(`${ep(config).graph}/me?$select=mail,userPrincipalName`, {
    fetch: deps.fetch, clock: deps.clock, sleep: deps.sleep, maxRetries: 2, headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return r;
  const b = r.value.body as { mail?: string | null; userPrincipalName?: string | null } | null;
  if (r.value.status !== 200 || !b) return cerr('invalid_response', `could not read Graph /me (${r.value.status})`, { status: r.value.status });
  return ok({ mail: b.mail ?? null, upn: b.userPrincipalName ?? null });
}

export interface DeviceCodePrompt {
  verificationUri: string;
  userCode: string;
  message: string;
  expiresAt: string;
}

export interface MicrosoftConsentOptions {
  config: MicrosoftOAuthConfig;
  expectedAddress: string;
  fetch: FetchLike;
  clock: Clock;
  sleep: Sleep;
  /** Shows the code to the owner (CLI prints it). */
  onPrompt: (p: DeviceCodePrompt) => void | Promise<void>;
  /** read (default): Mail.Read. send: Mail.Send + Mail.ReadWrite (use a separate app registration). */
  purpose?: CredentialPurpose;
}

/**
 * OAuth 2.0 device authorization grant against the Microsoft identity
 * platform (tenant default "organizations"), scopes Mail.Read offline_access
 * User.Read. Admin-consent errors (AADSTS65001 etc.) return
 * `admin_consent_required` immediately. The signed-in identity (mail or UPN)
 * must equal the registered address.
 */
export async function runMicrosoftDeviceCodeConsent(o: MicrosoftConsentOptions): Promise<Result<OAuthTokenSet, ConnectorError>> {
  const e = ep(o.config);
  const purpose = o.purpose ?? 'read';
  const dr = await postForm(o.fetch, e.device, { client_id: o.config.clientId, scope: scopeParam(purpose) });
  if (!dr.ok) return dr;
  const d = dr.value.body as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; message?: string } & MsErrorBody | null;
  if (dr.value.status !== 200 || !d?.device_code || !d.user_code || !d.verification_uri) return { ok: false, error: classifyMicrosoftError(dr.value.status, d) };
  const deadline = o.clock.nowMs() + (d.expires_in ?? 900) * 1000;
  let interval = Math.max(1, d.interval ?? 5) * 1000;
  await o.onPrompt({
    verificationUri: d.verification_uri, userCode: d.user_code,
    message: d.message ?? `Open ${d.verification_uri} and enter code ${d.user_code}`, expiresAt: new Date(deadline).toISOString(),
  });
  for (;;) {
    if (o.clock.nowMs() >= deadline) return cerr('consent_timeout', 'device code expired before sign-in completed');
    await o.sleep(interval);
    const tr = await postForm(o.fetch, e.token, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: o.config.clientId, device_code: d.device_code,
    });
    if (!tr.ok) return tr;
    const body = tr.value.body as MsTokenBody | null;
    if (tr.value.status === 200 && body?.access_token) {
      const sc = checkMicrosoftScopes(body.scope ?? '', purpose);
      if (!sc.ok) return sc;
      if (!body.refresh_token) return cerr('invalid_response', 'no refresh token returned (offline_access not granted?)');
      const id = await fetchGraphIdentity(o.config, body.access_token, o);
      if (!id.ok) return id;
      const want = normalizeAddress(o.expectedAddress);
      const matched = [id.value.mail, id.value.upn].filter((x): x is string => !!x).map(normalizeAddress).includes(want);
      // Microsoft has no per-token revocation endpoint for public clients; the tokens are simply discarded.
      if (!matched) return cerr('account_mismatch', `signed-in account is not the registered address ${o.expectedAddress}; tokens discarded`);
      return ok(toTokenSet(body, sc.value, want, o.clock));
    }
    if (body?.error === 'authorization_pending') continue;
    if (body?.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    return { ok: false, error: classifyMicrosoftError(tr.value.status, body) };
  }
}
