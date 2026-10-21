/**
 * Seatbelt (sandbox-exec) profile generation.
 *
 * Seatbelt evaluates rules so that the LAST matching rule wins; the profile
 * therefore starts from `(deny default)`, opens broad system reads, closes the
 * sensitive roots again, and finally re-opens the task workspace.
 * (Verified on this Mac: tests/adversarial/sandbox-runner.test.ts.)
 *
 * `sandbox-exec` is deprecated by Apple and its language is undocumented.
 * It is used here as one layer; the dedicated `potts-worker` user is the
 * primary OS boundary.
 */
import { dirname } from 'node:path';
import type { NetworkPolicy } from './types.ts';

export type NetworkMode = 'none' | 'allowlist';
/** Seatbelt can only express "localhost:<port>" or "*:<port>". */
export interface NetworkAllowEntry {
  host: 'localhost' | '*';
  port: number;
}

/**
 * Maps WP-6's NetworkPolicy onto what Seatbelt can enforce.
 * "localhost:P", "127.0.0.1:P", "[::1]:P", "*:P" are exact; any hostname
 * ("api.anthropic.com[:P]") becomes "*:P" (default 443) and `enforced` is false.
 */
export function mapNetworkPolicy(p: NetworkPolicy): { mode: NetworkMode; allow: NetworkAllowEntry[]; enforced: boolean; hostnames: string[] } {
  if (!p || p.mode === 'none') return { mode: 'none', allow: [], enforced: true, hostnames: [] };
  if (p.mode !== 'allowlist' || !Array.isArray(p.hosts) || p.hosts.length === 0) throw new Error('network allowlist needs at least one host');
  const allow = new Map<string, NetworkAllowEntry>();
  const hostnames: string[] = [];
  for (const raw of p.hosts) {
    const m = /^(\*|localhost|127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/.exec(String(raw).trim());
    if (!m) throw new Error(`invalid network allowlist entry: ${raw}`);
    const host = m[1]!;
    const port = m[2] ? Number(m[2]) : host === '*' || ['localhost', '127.0.0.1', '[::1]'].includes(host) ? NaN : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`network allowlist entry needs a port: ${raw}`);
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (!isLocal && host !== '*') hostnames.push(host);
    const e: NetworkAllowEntry = { host: isLocal ? 'localhost' : '*', port };
    allow.set(`${e.host}:${e.port}`, e);
  }
  return { mode: 'allowlist', allow: [...allow.values()], enforced: hostnames.length === 0, hostnames };
}

/** Roots whose contents a worker must never read (re-allowed only for the workspace / explicit read-only paths). */
export const DENY_READ_ROOTS = [
  '/Users',
  '/Volumes',
  '/private/var/folders',
  '/private/tmp',
  '/private/var/tmp',
  '/private/var/root',
  '/private/var/db/sudo',
  '/Library/Keychains',
  '/Library/Application Support/com.apple.TCC',
] as const;

/**
 * Binaries that reach the owner's GUI session, Keychain, privileges or
 * clipboard. Denying their exec paths is belt-and-braces: a copied binary is
 * still stopped by the Mach-service, Apple Event and file rules.
 */
export const DENY_EXEC = [
  '/usr/bin/osascript',
  '/usr/bin/osacompile',
  '/usr/bin/open',
  '/usr/bin/security',
  '/usr/bin/sudo',
  '/usr/bin/su',
  '/usr/bin/login',
  '/bin/launchctl',
  '/usr/bin/shortcuts',
  '/usr/bin/automator',
  '/usr/sbin/screencapture',
  '/usr/bin/pbcopy',
  '/usr/bin/pbpaste',
  '/usr/bin/defaults',
  '/usr/bin/tccutil',
  '/usr/sbin/networksetup',
  '/usr/bin/dscl',
] as const;

/** Device files ordinary programs need. */
const DEVICE_RW = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/dtracehelper', '/dev/fd'] as const;

export interface SandboxProfileInput {
  /** Realpaths of the writable roots (the job workspace first). */
  writablePaths: string[];
  /** Realpaths of extra read-only roots. */
  readOnlyPaths?: string[];
  network: NetworkMode;
  networkAllow?: NetworkAllowEntry[];
  machServices?: string[];
}

export function sbplString(s: string): string {
  if (/[\u0000-\u001f]/.test(s)) throw new Error('control characters are not allowed in sandbox paths');
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  let d = dirname(p);
  while (d !== '/' && d !== '.') {
    out.push(d);
    d = dirname(d);
  }
  out.push('/');
  return out;
}

export function buildSandboxProfile(i: SandboxProfileInput): string {
  const ro = i.readOnlyPaths ?? [];
  const rw = i.writablePaths;
  if (!rw.length) throw new Error('at least one writable path is required');
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    `(deny process-exec ${DENY_EXEC.map((p) => `(literal ${sbplString(p)})`).join(' ')})`,
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(deny file-read* ${DENY_READ_ROOTS.map((p) => `(subpath ${sbplString(p)})`).join(' ')})`,
    // stat() of the path leading to the workspace / read-only roots (no directory listing, no contents).
    `(allow file-read-metadata ${[...new Set([...rw.flatMap(ancestors), ...ro.flatMap(ancestors)])].map((p) => `(literal ${sbplString(p)})`).join(' ')})`,
    `(allow file-read* ${[...rw, ...ro].map((p) => `(subpath ${sbplString(p)})`).join(' ')})`,
    `(allow file-read* file-write-data file-ioctl ${DEVICE_RW.map((p) => `(literal ${sbplString(p)})`).join(' ')} (subpath "/dev/fd"))`,
    `(allow file-write* ${rw.map((p) => `(subpath ${sbplString(p)})`).join(' ')})`,
  ];
  const mach = new Set(i.machServices ?? []);
  if (i.network === 'allowlist') {
    const allow = i.networkAllow ?? [];
    if (!allow.length) throw new Error('network allowlist is empty');
    for (const a of allow) {
      if ((a.host !== 'localhost' && a.host !== '*') || !Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error('invalid network allow entry');
      lines.push(`(allow network-outbound (remote tcp ${sbplString(`${a.host}:${a.port}`)}))`);
    }
    if (allow.some((a) => a.host === '*')) {
      // Name resolution for non-localhost destinations.
      lines.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
      mach.add('com.apple.dnssd.service');
    }
    lines.push('(allow system-socket)');
  }
  for (const m of mach) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(m)) throw new Error('invalid mach service name');
    lines.push(`(allow mach-lookup (global-name ${sbplString(m)}))`);
  }
  return lines.join('\n') + '\n';
}
