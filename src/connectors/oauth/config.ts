import { resolveSecretRef, type SecretResolverOptions } from '../../core/secrets.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from './errors.ts';
import type { ProviderConfigs } from './session.ts';

/** Typed view of the `connectors` config section (see config/potts.schema.json). */
export interface ConnectorsConfig {
  imessage?: { readEnabled: boolean; accountId: string };
  google?: { clientId: string; clientSecretRef: string };
  /** sendClientId: a SEPARATE public-client app registration used only for Outlook send credentials (Mail.Send, Mail.ReadWrite). */
  microsoft?: { clientId: string; tenant?: string; sendClientId?: string };
  tokenStore?: { keychainService?: string };
  mail?: {
    fullSyncQuery?: string;
    maxFullSyncMessages?: number;
    initialWindowDays?: number;
    schoolDomains?: string[];
    localClassifier?: { enabled?: boolean; baseUrl?: string; model?: string };
  };
}

export function connectorsConfigFrom(cfg: object | undefined): ConnectorsConfig {
  return ((cfg as { connectors?: unknown } | undefined)?.connectors as ConnectorsConfig | undefined) ?? {};
}

/** Resolves OAuth client settings (the Google client secret is read from its secret reference). Broker-side code only. */
export async function resolveProviderConfigs(c: ConnectorsConfig, secrets: SecretResolverOptions = {}): Promise<Result<ProviderConfigs, ConnectorError>> {
  const out: ProviderConfigs = {};
  if (c.google) {
    const s = await resolveSecretRef(c.google.clientSecretRef, secrets);
    if (!s.ok) return cerr('config', `Google client secret unavailable: ${s.error.message}`);
    out.google = { clientId: c.google.clientId, clientSecret: s.value };
  }
  Object.assign(out, microsoftConfigsFrom(c));
  return ok(out);
}

/** Microsoft reader and (optional) send app registrations; no secrets involved (public clients). */
export function microsoftConfigsFrom(c: ConnectorsConfig): Pick<ProviderConfigs, 'microsoft' | 'microsoftSend'> {
  if (!c.microsoft) return {};
  const tenant = c.microsoft.tenant ? { tenant: c.microsoft.tenant } : {};
  return {
    microsoft: { clientId: c.microsoft.clientId, ...tenant },
    ...(c.microsoft.sendClientId ? { microsoftSend: { clientId: c.microsoft.sendClientId, ...tenant } } : {}),
  };
}
