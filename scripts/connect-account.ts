#!/usr/bin/env node
/**
 * Owner-run account connection tool. Potts never runs this itself.
 *
 *   node --disable-warning=ExperimentalWarning scripts/connect-account.ts --account <id> [--purpose read|send] [--config <potts.json>] [--dry-run]
 *   node ... scripts/connect-account.ts --account <id> [--purpose read|send] --status
 *   node ... scripts/connect-account.ts --account <id> [--purpose read|send] --revoke
 *
 * purpose read (default)
 *   gmail:   installed-app loopback consent with PKCE, scope gmail.readonly ONLY.
 *   outlook: Microsoft device-code sign-in, scopes Mail.Read offline_access User.Read.
 * purpose send (separate consent; the reader never holds it)
 *   gmail:   gmail.send + openid email (identity check via OpenID userinfo).
 *   outlook: Mail.Send Mail.ReadWrite offline_access User.Read on the separate app connectors.microsoft.sendClientId.
 *
 * The consented mailbox must equal the account's registered address, otherwise
 * the grant is revoked/discarded and nothing is stored. Tokens go to the macOS
 * Keychain (service "potts-oauth", account "<id>" for read, "<id>.send" for
 * send); the DB only records status, consented address and granted scopes.
 * --revoke (read) also revokes the send credential and purges the account's
 * synced data with a deletion receipt. All logic lives in src/connectors/oauth/cli.ts.
 */
import { spawn } from 'node:child_process';
import { systemClock } from '../src/core/clock.ts';
import { resolvePottsHome } from '../src/store/home.ts';
import { realSleep, runConnectAccountCli } from '../src/connectors/oauth/index.ts';
import { memoryConfigFrom, openMemory } from '../src/memory/index.ts';

const home = resolvePottsHome();
runConnectAccountCli(process.argv.slice(2), {
  home,
  fetch,
  clock: systemClock,
  sleep: realSleep,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  openBrowser: (url) => {
    spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref();
  },
  memory: (db, cfg) => {
    const m = openMemory({ db, clock: systemClock, home, config: memoryConfigFrom(cfg) });
    return m.ok ? m.value : null;
  },
}).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
