/**
 * Writer TokenProvider (WP-7 contract) over the WP-4 OAuth token store.
 *
 *  purpose "lookup" → the READER credential (account id), e.g. gmail.readonly / Mail.Read,
 *                     used only by lookup() to reconcile an uncertain send.
 *  purpose "send"   → a SEPARATE send credential stored under "<accountId>.send"
 *                     (Keychain service potts-oauth). Readers never hold it.
 *
 * Every requested scope must be in the stored grant; otherwise the token is
 * refused (the writer then rejects definitively — nothing is sent).
 */
import type { Clock } from '../core/clock.ts';
import type { AccountRegistry } from '../core/config.ts';
import type { TokenProvider } from '../connectors/writers/writer-support.ts';
import { tokenProviderFor, type ProviderConfigs } from '../connectors/oauth/session.ts';
import { credentialIdFor } from '../connectors/oauth/types.ts';
import type { TokenStore } from '../connectors/oauth/token-store.ts';
import type { AccountStatusStore } from '../connectors/oauth/status.ts';
import type { FetchLike } from '../connectors/oauth/http.ts';

export const sendCredentialId = (accountId: string) => credentialIdFor(accountId, 'send');

const short = (s: string) => s.slice(s.lastIndexOf('/') + 1).toLowerCase();

export function createWriterTokenProvider(o: { accounts: AccountRegistry; tokenStore: TokenStore; statusStore: AccountStatusStore; configs: ProviderConfigs; fetch: FetchLike; clock: Clock }): TokenProvider {
  return {
    async getAccessToken({ accountId, purpose, scopes }) {
      const acct = o.accounts.get(accountId);
      if (!acct) throw new Error(`account ${accountId} is not registered`);
      const provider = acct.kind === 'gmail' ? 'google' : acct.kind === 'outlook' ? 'microsoft' : null;
      if (!provider) throw new Error(`account ${accountId} has no OAuth credential`);
      const credPurpose = purpose === 'send' ? 'send' : 'read';
      const credId = credentialIdFor(accountId, credPurpose);
      const tp = tokenProviderFor(credId, provider, o.configs, { tokenStore: o.tokenStore, statusStore: o.statusStore, fetch: o.fetch, clock: o.clock }, credPurpose);
      const r = await tp.getAccessToken();
      if (!r.ok) throw new Error(`${purpose} credential unavailable: ${r.error.code}`);
      const set = await o.tokenStore.get(credId);
      const granted = new Set((set?.scope ?? '').split(/\s+/).filter(Boolean).map(short));
      const missing = scopes.filter((s) => !granted.has(short(s)));
      if (missing.length) throw new Error(`${purpose} credential lacks scope(s): ${missing.map(short).join(', ')}`);
      return r.value;
    },
  };
}
