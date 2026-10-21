import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { perr, ok, type Result } from './result.ts';

/**
 * Secret references. Config files hold only references, never secret values:
 *   keychain:<service>/<account>   macOS login Keychain generic password
 *   env:<NAME>                     environment variable
 */
export const SECRET_REF_PATTERN = /^(keychain:[^/\s]+\/[^\s]+|env:[A-Z_][A-Z0-9_]*)$/;
export type SecretRef = string;

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === 'string' && SECRET_REF_PATTERN.test(v);
}

export interface SecretResolverOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; default runs `/usr/bin/security find-generic-password -w`. */
  keychainLookup?: (service: string, account: string) => Promise<string>;
}

const execFileP = promisify(execFile);
async function defaultKeychainLookup(service: string, account: string): Promise<string> {
  const { stdout } = await execFileP('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    timeout: 10_000,
  });
  return stdout.replace(/\n$/, '');
}

/**
 * Resolves a secret reference. Only trusted broker-side code should call this;
 * resolved values must never be logged, stored in the DB or sent to the model.
 */
export async function resolveSecretRef(ref: string, opts: SecretResolverOptions = {}): Promise<Result<string>> {
  if (!isSecretRef(ref)) return perr('secret_unresolved', 'not a valid secret reference');
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = (opts.env ?? process.env)[name];
    return v ? ok(v) : perr('secret_unresolved', `environment variable ${name} is not set`);
  }
  const rest = ref.slice('keychain:'.length);
  const slash = rest.indexOf('/');
  const service = rest.slice(0, slash);
  const account = rest.slice(slash + 1);
  try {
    const v = await (opts.keychainLookup ?? defaultKeychainLookup)(service, account);
    return v ? ok(v) : perr('secret_unresolved', `keychain item ${service}/${account} is empty`);
  } catch {
    return perr('secret_unresolved', `keychain item ${service}/${account} not found or access denied`);
  }
}
