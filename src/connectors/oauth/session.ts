import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from './errors.ts';
import type { FetchLike, Sleep } from './http.ts';
import type { AccountStatusStore } from './status.ts';
import type { TokenStore } from './token-store.ts';
import { refreshGoogleToken, revokeGoogleToken, runGoogleLoopbackConsent } from './google.ts';
import { refreshMicrosoftToken, runMicrosoftDeviceCodeConsent, type DeviceCodePrompt } from './microsoft.ts';
import { credentialIdFor, type CredentialPurpose, type GoogleOAuthConfig, type MicrosoftOAuthConfig, type OAuthProvider, type OAuthTokenSet } from './types.ts';

/** What readers use to authenticate. */
export interface AccessTokenProvider {
  readonly accountId: string;
  /** Returns a valid access token, refreshing if needed. `force` refreshes even if unexpired (after a 401). */
  getAccessToken(force?: boolean): Promise<Result<string, ConnectorError>>;
}

export interface TokenProviderOptions {
  accountId: string;
  provider: OAuthProvider;
  tokenStore: TokenStore;
  statusStore: AccountStatusStore;
  clock: Clock;
  refresh: (t: OAuthTokenSet) => Promise<Result<OAuthTokenSet, ConnectorError>>;
  /** Refresh this long before expiry (default 60 s). */
  skewMs?: number;
}

/**
 * Access-token provider with explicit failure states:
 * - status revoked / stale_auth / admin_consent_required are sticky: no token is
 *   returned until the owner reconnects (scripts/connect-account.ts);
 * - a refresh failing with invalid_grant marks the account `stale_auth`;
 * - an admin-consent error marks `admin_consent_required` (a blocker, not retried).
 */
export function createAccessTokenProvider(o: TokenProviderOptions): AccessTokenProvider {
  const skew = o.skewMs ?? 60_000;
  const mark = (status: 'stale_auth' | 'admin_consent_required' | 'error', reason: string, tokens?: OAuthTokenSet) => {
    const prev = o.statusStore.get(o.accountId);
    o.statusStore.set({
      accountId: o.accountId, provider: o.provider, status, statusReason: reason,
      consentedAddress: prev?.consentedAddress ?? tokens?.accountAddress ?? null, scopes: prev?.scopes ?? tokens?.scope ?? null,
    });
  };
  return {
    accountId: o.accountId,
    async getAccessToken(force = false) {
      const st = o.statusStore.get(o.accountId);
      if (st?.status === 'revoked') return cerr('revoked', `account ${o.accountId} access was revoked`);
      if (st?.status === 'stale_auth') return cerr('stale_auth', `account ${o.accountId} needs re-consent: ${st.statusReason ?? 'refresh failed'}`);
      if (st?.status === 'admin_consent_required') return cerr('admin_consent_required', `account ${o.accountId} is blocked: ${st.statusReason ?? 'admin consent required'}`);
      let tokens: OAuthTokenSet | undefined;
      try {
        tokens = await o.tokenStore.get(o.accountId);
      } catch (e) {
        return cerr('config', `token store read failed: ${(e as Error).message}`);
      }
      if (!tokens || !st || st.status === 'not_connected') return cerr('not_connected', `account ${o.accountId} is not connected`);
      if (!force && Date.parse(tokens.accessTokenExpiresAt) - skew > o.clock.nowMs()) return ok(tokens.accessToken);
      const r = await o.refresh(tokens);
      if (!r.ok) {
        if (r.error.code === 'stale_auth' || r.error.code === 'admin_consent_required') mark(r.error.code, r.error.message, tokens);
        else if (r.error.code === 'scope_rejected' || r.error.code === 'config') mark('error', r.error.message, tokens);
        return r;
      }
      await o.tokenStore.set(o.accountId, r.value);
      if (st.status !== 'connected') {
        o.statusStore.set({ accountId: o.accountId, provider: o.provider, status: 'connected', statusReason: null, consentedAddress: st.consentedAddress, scopes: r.value.scope });
      }
      return ok(r.value.accessToken);
    },
  };
}

export interface ProviderConfigs {
  google?: GoogleOAuthConfig;
  microsoft?: MicrosoftOAuthConfig;
  /**
   * Separate Entra app registration for Outlook SEND credentials (connectors.microsoft.sendClientId).
   * Microsoft tokens carry every scope consented to an app, so a send consent on the reader's app would
   * make the read-only reader's tokens write-capable; the send grant therefore lives on its own app.
   */
  microsoftSend?: MicrosoftOAuthConfig;
}

/** The provider config used for a credential purpose (Microsoft send uses its own app registration). */
export function providerConfigFor(provider: OAuthProvider, configs: ProviderConfigs, purpose: CredentialPurpose = 'read'): Result<GoogleOAuthConfig | MicrosoftOAuthConfig, ConnectorError> {
  if (provider === 'google') return configs.google ? ok(configs.google) : cerr('config', 'Google OAuth client is not configured (connectors.google)');
  if (purpose === 'send')
    return configs.microsoftSend ? ok(configs.microsoftSend) : cerr('config', 'Outlook send credentials need a separate app registration: set connectors.microsoft.sendClientId');
  return configs.microsoft ? ok(configs.microsoft) : cerr('config', 'Microsoft app registration is not configured (connectors.microsoft)');
}

/**
 * Builds the token provider for a stored credential, wiring the right refresh function. `credentialId` is the
 * account id (read) or "<accountId>.send" (send); `purpose` selects the scope rules used on refresh.
 */
export function tokenProviderFor(
  credentialId: string, provider: OAuthProvider, configs: ProviderConfigs,
  deps: { tokenStore: TokenStore; statusStore: AccountStatusStore; fetch: FetchLike; clock: Clock },
  purpose: CredentialPurpose = 'read',
): AccessTokenProvider {
  const refresh = (t: OAuthTokenSet): Promise<Result<OAuthTokenSet, ConnectorError>> => {
    const c = providerConfigFor(provider, configs, purpose);
    if (!c.ok) return Promise.resolve(c);
    return provider === 'google'
      ? refreshGoogleToken(c.value as GoogleOAuthConfig, t, deps, purpose)
      : refreshMicrosoftToken(c.value as MicrosoftOAuthConfig, t, deps, purpose);
  };
  return createAccessTokenProvider({ accountId: credentialId, provider, tokenStore: deps.tokenStore, statusStore: deps.statusStore, clock: deps.clock, refresh });
}

export interface ConnectAccountOptions {
  accountId: string;
  provider: OAuthProvider;
  /** Registered exact address (accounts.json "address"). */
  expectedAddress: string;
  configs: ProviderConfigs;
  tokenStore: TokenStore;
  statusStore: AccountStatusStore;
  fetch: FetchLike;
  clock: Clock;
  sleep: Sleep;
  openBrowser: (url: string) => void | Promise<void>;
  onDeviceCode: (p: DeviceCodePrompt) => void | Promise<void>;
  timeoutMs?: number;
  /** read (default) stores under the account id; send runs a separate send-scope consent and stores under "<id>.send". */
  purpose?: CredentialPurpose;
}

/**
 * Runs the owner consent flow for one account and persists the result. Only
 * the owner runs this (scripts/connect-account.ts). On admin-consent errors the
 * credential is marked `admin_consent_required`; on mismatch nothing is stored.
 * Returns the credential id the token was stored under.
 */
export async function connectAccount(o: ConnectAccountOptions): Promise<Result<{ address: string; scope: string; credentialId: string }, ConnectorError>> {
  const purpose = o.purpose ?? 'read';
  const credentialId = credentialIdFor(o.accountId, purpose);
  const c = providerConfigFor(o.provider, o.configs, purpose);
  if (!c.ok) return c;
  let r: Result<OAuthTokenSet, ConnectorError>;
  if (o.provider === 'google') {
    r = await runGoogleLoopbackConsent({ config: c.value as GoogleOAuthConfig, expectedAddress: o.expectedAddress, fetch: o.fetch, clock: o.clock, openBrowser: o.openBrowser, purpose, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  } else {
    r = await runMicrosoftDeviceCodeConsent({ config: c.value as MicrosoftOAuthConfig, expectedAddress: o.expectedAddress, fetch: o.fetch, clock: o.clock, sleep: o.sleep, onPrompt: o.onDeviceCode, purpose });
  }
  if (!r.ok) {
    if (r.error.code === 'admin_consent_required')
      o.statusStore.set({ accountId: credentialId, provider: o.provider, status: 'admin_consent_required', statusReason: r.error.message, consentedAddress: null, scopes: null });
    return r;
  }
  await o.tokenStore.set(credentialId, r.value);
  o.statusStore.set({
    accountId: credentialId, provider: o.provider, status: 'connected', statusReason: null,
    consentedAddress: r.value.accountAddress, scopes: r.value.scope, connectedAt: o.clock.nowIso(),
  });
  return ok({ address: r.value.accountAddress, scope: r.value.scope, credentialId });
}

/** Receives "this account is revoked" so the broker blocks every action on it. */
export interface RevocationSink {
  markRevoked(accountId: string, reason: string, actor: string): void;
}

/**
 * Adapter for an in-process broker (trusted daemon code only): sets the
 * `account:<id>` control to revoked and invalidates live approvals through the
 * broker's public, audited `revokeAccountFromSystem`. It only moves towards
 * safety; reinstatement stays owner-only.
 */
export function brokerRevocationSink(broker: {
  revokeAccountFromSystem(accountId: string, reason: string, actor: string): void;
}): RevocationSink {
  return {
    markRevoked(accountId, reason, actor) {
      broker.revokeAccountFromSystem(accountId, reason, actor);
    },
  };
}

export interface RevokeOptions {
  accountId: string;
  provider: OAuthProvider;
  configs: ProviderConfigs;
  tokenStore: TokenStore;
  statusStore: AccountStatusStore;
  fetch: FetchLike;
  sink?: RevocationSink;
  actor: string;
  reason?: string;
  /** read (default): the reader credential. send: only the "<id>.send" credential; the account and its data stay. */
  purpose?: CredentialPurpose;
}

export interface RevokeResult {
  /** Google: provider revocation endpoint called. Microsoft: no public-client revocation endpoint exists. */
  provider: 'revoked' | 'already_invalid' | 'not_supported' | 'no_tokens' | 'failed';
  localTokensDeleted: boolean;
  brokerMarked: boolean;
  note?: string;
}

/**
 * Revokes access for an account: provider revocation (Google), local token
 * deletion, status `revoked`, and broker control `account:<id>` revoked when a
 * sink is supplied. Local deletion and status happen even if the provider call fails.
 */
export async function revokeAccount(o: RevokeOptions): Promise<RevokeResult> {
  const purpose = o.purpose ?? 'read';
  const credId = credentialIdFor(o.accountId, purpose);
  let tokens: OAuthTokenSet | undefined;
  try {
    tokens = await o.tokenStore.get(credId);
  } catch {
    tokens = undefined;
  }
  let provider: RevokeResult['provider'] = 'no_tokens';
  let note: string | undefined;
  if (tokens && o.provider === 'google' && o.configs.google) {
    const r = await revokeGoogleToken(o.configs.google, tokens.refreshToken || tokens.accessToken, { fetch: o.fetch });
    provider = r.ok ? r.value : 'failed';
    if (!r.ok) note = `provider revocation failed (${r.error.message}); remove access at https://myaccount.google.com/permissions`;
  } else if (o.provider === 'microsoft') {
    provider = 'not_supported';
    note = 'Microsoft has no token revocation endpoint for public clients; remove the app at https://myapplications.microsoft.com (or https://myaccount.microsoft.com → Apps) to revoke consent';
  }
  let localTokensDeleted = false;
  try {
    await o.tokenStore.delete(credId);
    localTokensDeleted = true;
  } catch {
    localTokensDeleted = false;
  }
  const prev = o.statusStore.get(credId);
  o.statusStore.set({
    accountId: credId, provider: o.provider, status: 'revoked', statusReason: o.reason ?? `revoked by ${o.actor}`,
    consentedAddress: prev?.consentedAddress ?? tokens?.accountAddress ?? null, scopes: null,
  });
  let brokerMarked = false;
  if (o.sink && purpose === 'read') {
    o.sink.markRevoked(o.accountId, o.reason ?? 'account access revoked', o.actor);
    brokerMarked = true;
  }
  return { provider, localTokensDeleted, brokerMarked, ...(note ? { note } : {}) };
}
