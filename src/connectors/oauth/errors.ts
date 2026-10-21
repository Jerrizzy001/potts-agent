import { err, type Err } from '../../core/result.ts';

/**
 * Connector-level error codes (WP-4). Kept separate from the core ErrorCode
 * union so connectors can add codes without editing WP-1 files.
 *
 * - stale_auth: refresh token revoked/expired (invalid_grant) or consent no longer valid.
 *   The owner must re-run scripts/connect-account.ts. Never silently ignored.
 * - admin_consent_required: the tenant (e.g. organization) requires an administrator to consent
 *   (AADSTS65001 / AADSTS90094). A blocker, not retried.
 * - account_mismatch: the consented identity is not the registered address.
 * - scope_rejected: the provider granted scopes broader/narrower than the read-only set.
 * - feed_stale: a school feed could not be read; data is unknown, not empty.
 */
export type ConnectorErrorCode =
  | 'not_connected'
  | 'stale_auth'
  | 'admin_consent_required'
  | 'revoked'
  | 'paused'
  | 'account_mismatch'
  | 'scope_rejected'
  | 'consent_denied'
  | 'consent_timeout'
  | 'state_mismatch'
  | 'rate_limited'
  | 'http_error'
  | 'network'
  | 'invalid_response'
  | 'feed_stale'
  | 'blocked_url'
  | 'config';

export interface ConnectorError {
  code: ConnectorErrorCode;
  message: string;
  status?: number;
  retryAfterMs?: number;
  /** Provider error code (e.g. "invalid_grant", "AADSTS65001"); never contains secrets. */
  providerError?: string;
}

export const cerr = (code: ConnectorErrorCode, message: string, extra: Omit<ConnectorError, 'code' | 'message'> = {}): Err<ConnectorError> =>
  err({ code, message, ...extra });

/** Statuses recorded per connected account (connector_accounts.status). */
export type AccountAuthStatus = 'not_connected' | 'connected' | 'stale_auth' | 'admin_consent_required' | 'revoked' | 'error';
