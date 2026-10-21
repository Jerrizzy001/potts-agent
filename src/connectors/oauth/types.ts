export type OAuthProvider = 'google' | 'microsoft';

/**
 * What a stored credential is for. `read` credentials are the reader's
 * (gmail.readonly / Mail.Read) and live under the account id; `send`
 * credentials are separate grants (gmail.send / Mail.Send + Mail.ReadWrite)
 * stored under "<accountId>.send". Readers never hold a send credential.
 */
export type CredentialPurpose = 'read' | 'send';

/** Token-store / status-store key for an account credential: "<id>" (read) or "<id>.send" (send). */
export function credentialIdFor(accountId: string, purpose: CredentialPurpose = 'read'): string {
  return purpose === 'send' ? `${accountId}.send` : accountId;
}

/**
 * Token bundle persisted in a TokenStore (Keychain in production). Never
 * written to the DB, logs, or config. `accountAddress` is the identity that
 * was verified at consent time.
 */
export interface OAuthTokenSet {
  provider: OAuthProvider;
  accessToken: string;
  /** UTC ISO instant at which the access token expires. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** Space-separated scopes granted by the provider. */
  scope: string;
  tokenType: string;
  accountAddress: string;
  obtainedAt: string;
}

/** Only scope Potts ever requests from Google: read-only Gmail. */
export const GOOGLE_GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
/**
 * Google scopes that grant more than reading. If any appear in a token
 * response the token is revoked and rejected (gmail.compose can send; modify,
 * insert, send, settings and full mail.google.com are writes).
 */
export const GOOGLE_FORBIDDEN_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
] as const;

/** Google send consent: gmail.send only for mail, plus OpenID `email` so the consented mailbox can be verified (gmail.send cannot read the Gmail profile). */
export const GOOGLE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
export const GOOGLE_SEND_SCOPES = ['openid', 'email', GOOGLE_GMAIL_SEND] as const;
/** Identity scopes Google may echo back for an `openid email` request. They grant no mailbox access. */
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'] as const;

/** Delegated Microsoft Graph scopes requested for the Microsoft Outlook reader. */
export const MICROSOFT_READ_SCOPES = ['Mail.Read', 'offline_access', 'User.Read'] as const;
/** Microsoft scopes that would grant writes; rejected if granted. */
export const MICROSOFT_FORBIDDEN_SCOPES = ['Mail.Send', 'Mail.ReadWrite', 'Mail.Send.Shared', 'Mail.ReadWrite.Shared', 'MailboxSettings.ReadWrite'] as const;
/** Delegated Graph scopes for the Outlook SEND credential (the writer creates a draft, verifies it, then sends). */
export const MICROSOFT_SEND_SCOPES = ['Mail.Send', 'Mail.ReadWrite', 'offline_access', 'User.Read'] as const;
/** Never accepted on a send credential either (other mailboxes, mailbox settings). */
export const MICROSOFT_SEND_FORBIDDEN_SCOPES = ['Mail.Send.Shared', 'Mail.ReadWrite.Shared', 'MailboxSettings.ReadWrite'] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  /** Desktop-app client secret (Google treats it as non-confidential, but we still keep it out of the repo). */
  clientSecret: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
  /** Gmail API base used to verify the consented profile (users/me/profile). */
  gmailApiBase?: string;
  /** OpenID userinfo endpoint used to verify the mailbox of a send-only grant. */
  userinfoEndpoint?: string;
}

export interface MicrosoftOAuthConfig {
  clientId: string;
  /** Tenant: "organizations" (default), a tenant id, or a verified domain such as "example.edu". */
  tenant?: string;
  authorityBase?: string;
  graphBase?: string;
}

export const GOOGLE_DEFAULTS = {
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  gmailApiBase: 'https://gmail.googleapis.com/gmail/v1',
  userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
} as const;

export const MICROSOFT_DEFAULTS = {
  tenant: 'organizations',
  authorityBase: 'https://login.microsoftonline.com',
  graphBase: 'https://graph.microsoft.com/v1.0',
} as const;

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}
