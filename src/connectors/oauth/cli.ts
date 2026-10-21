/**
 * Owner-run account connection CLI logic (scripts/connect-account.ts is a thin
 * wrapper). Potts never runs this itself. Every dependency with an external
 * effect (token store, HTTP, browser, clock) is injected so tests use fake
 * providers and an in-memory token store.
 *
 *   --account <id> [--purpose read|send] [--config <potts.json>]
 *     (default)  run the consent flow and store the credential
 *     --dry-run  print the plan; no network, no writes
 *     --status   print the stored status of the credential
 *     --revoke   revoke the credential. For purpose read (the default) this
 *                also revokes the send credential, if any, and purges every
 *                item synced from the account (mail, cursors, school data and
 *                memory facts sourced from it) with a deletion receipt.
 *                With --purpose send only the send credential is removed.
 *
 * purpose read: gmail.readonly (Gmail) / Mail.Read offline_access User.Read (Outlook), stored under "<id>".
 * purpose send: gmail.send + openid email (Gmail) / Mail.Send Mail.ReadWrite offline_access User.Read (Outlook,
 *               separate app registration connectors.microsoft.sendClientId), stored under "<id>.send", which is
 *               exactly where the daemon's writer TokenProvider looks for send credentials.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Clock } from '../../core/clock.ts';
import { loadConfig, type LoadedConfig } from '../../core/config.ts';
import type { Result } from '../../core/result.ts';
import { ensurePottsHome } from '../../store/home.ts';
import { openDatabase } from '../../store/db.ts';
import { migrate } from '../../store/migrate.ts';
import { createAuditLedger } from '../../audit/ledger.ts';
import { connectorsConfigFrom, resolveProviderConfigs, type ConnectorsConfig } from './config.ts';
import type { ConnectorError } from './errors.ts';
import type { FetchLike, Sleep } from './http.ts';
import type { DeviceCodePrompt } from './microsoft.ts';
import { purgeAccountData, type PurgeMemory } from './purge.ts';
import { connectAccount, revokeAccount, type ProviderConfigs } from './session.ts';
import { createAccountStatusStore } from './status.ts';
import { createKeychainTokenStore, type TokenStore } from './token-store.ts';
import {
  credentialIdFor, GOOGLE_GMAIL_READONLY, GOOGLE_SEND_SCOPES, MICROSOFT_READ_SCOPES, MICROSOFT_SEND_SCOPES, type OAuthProvider,
} from './types.ts';
import type { Db } from '../../store/db.ts';

export const CONNECT_USAGE = 'usage: connect-account.ts --account <id> [--purpose read|send] [--config <path>] [--dry-run | --status | --revoke]';

export interface ConnectCliDeps {
  home: string;
  fetch: FetchLike;
  clock: Clock;
  sleep: Sleep;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Opens the consent URL (production: /usr/bin/open). */
  openBrowser: (url: string) => void | Promise<void>;
  /** Default: macOS Keychain, service connectors.tokenStore.keychainService (potts-oauth). */
  tokenStore?: (conn: ConnectorsConfig) => TokenStore;
  /** Default: resolveProviderConfigs (reads the Google client secret reference). */
  resolveConfigs?: (conn: ConnectorsConfig) => Promise<Result<ProviderConfigs, ConnectorError>>;
  /** Memory store for purging facts sourced from a revoked account (default: none). */
  memory?: (db: Db, cfg: LoadedConfig) => PurgeMemory | null;
  consentTimeoutMs?: number;
}

export async function runConnectAccountCli(argv: string[], d: ConnectCliDeps): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: argv,
      options: {
        account: { type: 'string' },
        config: { type: 'string' },
        purpose: { type: 'string', default: 'read' },
        'dry-run': { type: 'boolean', default: false },
        status: { type: 'boolean', default: false },
        revoke: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (e) {
    d.err(`${(e as Error).message}\n${CONNECT_USAGE}`);
    return 2;
  }
  if (values.help || !values.account) {
    d.out(CONNECT_USAGE);
    return values.help ? 0 : 2;
  }
  const purpose = values.purpose as string;
  if (purpose !== 'read' && purpose !== 'send') {
    d.err(`--purpose must be read or send\n${CONNECT_USAGE}`);
    return 2;
  }
  const cfgPath = (values.config as string | undefined) ?? join(d.home, 'potts.json');
  const cfgR = loadConfig(cfgPath);
  if (!cfgR.ok) {
    d.err(`config: ${cfgR.error.message}`);
    return 2;
  }
  const cfg = cfgR.value;
  const account = cfg.accounts.find((a) => a.id === values.account);
  if (!account) {
    d.err(`account "${String(values.account)}" is not registered in ${cfgPath}`);
    return 2;
  }
  const conn = connectorsConfigFrom(cfg);

  const provider: OAuthProvider | null = account.kind === 'gmail' ? 'google' : account.kind === 'outlook' ? 'microsoft' : null;
  if (!provider) {
    d.err(`account kind ${account.kind} is not an OAuth mail account`);
    return 2;
  }
  const credId = credentialIdFor(account.id, purpose);
  const service = conn.tokenStore?.keychainService ?? 'potts-oauth';

  if (values['dry-run']) {
    const scopes = purpose === 'send'
      ? (provider === 'google' ? [...GOOGLE_SEND_SCOPES] : [...MICROSOFT_SEND_SCOPES])
      : (provider === 'google' ? [GOOGLE_GMAIL_READONLY] : [...MICROSOFT_READ_SCOPES]);
    const msClient = purpose === 'send' ? conn.microsoft?.sendClientId : conn.microsoft?.clientId;
    d.out(JSON.stringify({
      account: account.id, address: account.address, provider, purpose,
      flow: provider === 'google' ? 'installed-app loopback + PKCE on 127.0.0.1:<random port>' : `device code, tenant ${conn.microsoft?.tenant ?? 'organizations'}`,
      scopes,
      clientConfigured: provider === 'google' ? !!conn.google : !!msClient,
      ...(provider === 'microsoft' && purpose === 'send' && !msClient ? { missing: 'connectors.microsoft.sendClientId (separate app registration for send)' } : {}),
      tokenStore: `macOS Keychain service "${service}", account "${credId}"`,
      identityCheck: purpose === 'send' && provider === 'google' ? 'OpenID userinfo e-mail must equal the registered address' : 'mailbox identity must equal the registered address',
      ...(values.revoke ? { revoke: purpose === 'read' ? 'read + send credentials, then purge synced data (receipt)' : 'send credential only' } : {}),
      pottsHome: d.home,
      network: 'none (dry run)',
    }, null, 2));
    return 0;
  }

  const paths = ensurePottsHome(d.home);
  const db = openDatabase(paths.db);
  try {
    migrate(db, { clock: d.clock });
    const statusStore = createAccountStatusStore(db, d.clock);
    const tokenStore = d.tokenStore ? d.tokenStore(conn) : createKeychainTokenStore({ service });

    if (values.status) {
      d.out(JSON.stringify(statusStore.get(credId) ?? { accountId: credId, status: 'not_connected' }, null, 2));
      return 0;
    }

    const configs = await (d.resolveConfigs ?? ((c: ConnectorsConfig) => resolveProviderConfigs(c)))(conn);
    if (!configs.ok) {
      d.err(configs.error.message);
      return 2;
    }

    if (values.revoke) {
      const base = { accountId: account.id, provider, configs: configs.value, tokenStore, statusStore, fetch: d.fetch, actor: 'owner:cli' };
      if (purpose === 'send') {
        const r = await revokeAccount({ ...base, purpose: 'send', reason: 'owner revoked the send credential via connect-account' });
        d.out(JSON.stringify({ credential: credId, ...r }, null, 2));
        d.out('The read credential and synced data are unchanged. Disable the writer (writers.accounts[].enabled=false) if you no longer want sends.');
        return r.localTokensDeleted ? 0 : 1;
      }
      const read = await revokeAccount({ ...base, purpose: 'read', reason: 'owner revoked via connect-account' });
      let send: Awaited<ReturnType<typeof revokeAccount>> | null = null;
      const sendCred = credentialIdFor(account.id, 'send');
      if ((await tokenStore.get(sendCred).catch(() => undefined)) || statusStore.get(sendCred)?.status === 'connected')
        send = await revokeAccount({ ...base, purpose: 'send', reason: 'owner revoked the account via connect-account' });
      const receipt = purgeAccountData({
        db, clock: d.clock, accountId: account.id, actor: 'owner:cli', reason: 'owner revoked the account via connect-account',
        memory: d.memory ? d.memory(db, cfg) : null, audit: createAuditLedger(db, d.clock),
      });
      d.out(JSON.stringify({ read, send, purge: receipt }, null, 2));
      d.out('Also block the account in the broker: send /revoke ' + account.id + ' in your private Telegram chat with the bot.');
      return read.localTokensDeleted && (!send || send.localTokensDeleted) ? 0 : 1;
    }

    d.out(`Connecting ${account.id} (${account.address}) via ${provider} for ${purpose === 'send' ? 'SENDING (separate send-only credential)' : 'reading'}. Sign in as exactly ${account.address}.`);
    if (provider === 'google') d.out('Note: while the Google OAuth app is in "Testing" status, refresh tokens expire after 7 days; Potts will then report stale_auth and you re-run this command.');
    const r = await connectAccount({
      accountId: account.id, provider, expectedAddress: account.address, configs: configs.value, tokenStore, statusStore, purpose,
      fetch: d.fetch, clock: d.clock, sleep: d.sleep, timeoutMs: d.consentTimeoutMs ?? 10 * 60_000,
      openBrowser: async (url) => {
        d.out(`\nOpen this URL if a browser did not open:\n${url}\n`);
        await d.openBrowser(url);
      },
      onDeviceCode: (p: DeviceCodePrompt) => d.out(`\n${p.message}\n(code expires ${p.expiresAt})\n`),
    });
    if (!r.ok) {
      d.err(`FAILED (${r.error.code}): ${r.error.message}`);
      if (r.error.code === 'admin_consent_required') d.err('This is a tenant policy blocker. Ask your administrator for admin consent or an approved app; Potts will not bypass it.');
      return 1;
    }
    d.out(`Connected ${r.value.credentialId} as ${r.value.address} with scopes: ${r.value.scope}`);
    d.out(
      purpose === 'send'
        ? `Stored as Keychain service "${service}", account "${r.value.credentialId}" (read by the daemon's writer). Sends still need approval_required mode, writers.accounts[].enabled=true and your approval of each message.`
        : `Set the account mode to "read_only" in accounts.json if it is still "not_connected".`,
    );
    return 0;
  } finally {
    db.close();
  }


}
