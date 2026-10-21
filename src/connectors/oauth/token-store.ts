import { spawn } from 'node:child_process';
import type { OAuthTokenSet } from './types.ts';

/**
 * Where OAuth token bundles live. Production uses the macOS Keychain; tests
 * use the in-memory store. Implementations must never log token values.
 */
export interface TokenStore {
  get(accountId: string): Promise<OAuthTokenSet | undefined>;
  set(accountId: string, tokens: OAuthTokenSet): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export function createMemoryTokenStore(): TokenStore & { size(): number } {
  const m = new Map<string, string>();
  return {
    async get(id) {
      const v = m.get(id);
      return v ? (JSON.parse(v) as OAuthTokenSet) : undefined;
    },
    async set(id, t) {
      m.set(id, JSON.stringify(t));
    },
    async delete(id) {
      m.delete(id);
    },
    size: () => m.size,
  };
}

export interface SecurityRunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs /usr/bin/security with argv and optional stdin. Injected in tests. */
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityRunResult>;

export const defaultSecurityRunner: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** `security` exit status for "item not found". */
const ERR_NOT_FOUND = 44;

export interface KeychainTokenStoreOptions {
  /** Keychain service name for token items (default "potts-oauth"); item account = Potts account id. */
  service?: string;
  /** Optional explicit keychain file (default: the login/default keychain). */
  keychainPath?: string;
  runner?: SecurityRunner;
}

/**
 * macOS Keychain token store using the `security` CLI.
 *
 * - Read: `security find-generic-password -s <service> -a <account> -w` (secret goes to our stdout pipe only).
 * - Write: the secret is NEVER placed on any process argv. We run `security -i` (interactive mode, which reads
 *   commands from stdin) and send `add-generic-password -U -s <service> -a <account> -X <hex>` on stdin. The token
 *   bundle is hex-encoded, which also avoids any quoting issues in the interactive command parser.
 * - Delete: `security delete-generic-password -s <service> -a <account>`.
 *
 * Limitation: the item is created by /usr/bin/security, so /usr/bin/security is in the item's trusted-app list;
 * any process running as the owner's user that can execute `security` can read it. That is the same-user
 * boundary documented in docs/architecture/core.md; WP-2's OS isolation keeps the model/worker out of this user.
 */
export function createKeychainTokenStore(o: KeychainTokenStoreOptions = {}): TokenStore {
  const service = o.service ?? 'potts-oauth';
  const run = o.runner ?? defaultSecurityRunner;
  if (!NAME_RE.test(service)) throw new Error('keychain service name must match [A-Za-z0-9._-]');
  const kc = o.keychainPath ? [o.keychainPath] : [];
  if (o.keychainPath && /[\s"'\\]/.test(o.keychainPath)) throw new Error('keychain path must not contain spaces or quotes');
  const check = (id: string) => {
    if (!NAME_RE.test(id)) throw new Error('account id must match [A-Za-z0-9._-]');
  };
  return {
    async get(id) {
      check(id);
      const r = await run(['find-generic-password', '-s', service, '-a', id, '-w', ...kc]);
      if (r.code === ERR_NOT_FOUND) return undefined;
      if (r.code !== 0) throw new Error(`keychain read failed (exit ${r.code})`);
      const raw = r.stdout.replace(/\n$/, '');
      // `security -w` prints non-printable data as hex; our JSON is printable, but accept hex too.
      const text = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 && !raw.startsWith('{') ? Buffer.from(raw, 'hex').toString('utf8') : raw;
      try {
        return JSON.parse(text) as OAuthTokenSet;
      } catch {
        throw new Error('keychain item is not a Potts token bundle');
      }
    },
    async set(id, tokens) {
      check(id);
      const hex = Buffer.from(JSON.stringify(tokens), 'utf8').toString('hex');
      const cmd = `add-generic-password -U -s ${service} -a ${id} -l potts-oauth-${id} -X ${hex}${kc.length ? ' ' + kc[0] : ''}\n`;
      const r = await run(['-i'], cmd);
      // `security -i` returns 0 even when a sub-command fails, so check stderr too.
      if (r.code !== 0 || /error|could not|failed/i.test(r.stderr)) throw new Error(`keychain write failed (exit ${r.code})`);
    },
    async delete(id) {
      check(id);
      const r = await run(['delete-generic-password', '-s', service, '-a', id, ...kc]);
      if (r.code !== 0 && r.code !== ERR_NOT_FOUND) throw new Error(`keychain delete failed (exit ${r.code})`);
    },
  };
}
