/**
 * Daemon configuration loading. Reads $POTTS_HOME/potts.json (+ accounts.json,
 * projects.json, policy.json) and reports every problem as an Issue instead of
 * throwing, so the daemon can start in a degraded mode and `--check` can print
 * a complete readiness table.
 *
 * Fatal issues (the daemon refuses to start): no/invalid potts.json, an
 * insecure or invalid policy file. Everything else degrades the affected
 * feature to `not_connected`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateConfig, type LoadedConfig } from '../core/config.ts';
import { buildPolicy, DEFAULT_POLICY, loadPolicyFile, type LoadedPolicy } from '../policy/document.ts';
import { loadProjectsFile, type ProjectRegistry } from '../delegation/projects.ts';

export type IssueLevel = 'fatal' | 'error' | 'warn' | 'info';
export interface Issue {
  level: IssueLevel;
  area: string;
  message: string;
}

export interface DaemonSection {
  readSocket: boolean;
  memoryControlSocket: boolean;
  ownerChannel: 'plugin-socket' | 'none';
  ownerChannelSocket: string | null;
  auditHeadIntervalMinutes: number;
  tickMs: number;
  autoExecuteReady: boolean;
  /** Re-read policy.json when its mtime changes (SIGHUP always reloads). */
  policyWatch: boolean;
  /** Size-based rotation of logs/daemon.out.log and daemon.err.log (copy-truncate, 0600). */
  logRotation: { maxBytes: number; keep: number };
}

export interface BackupSection {
  enabled: boolean;
  dir: string;
  keep: number;
  dailyTime: string;
}

export const DEFAULT_DAEMON: DaemonSection = {
  readSocket: true,
  memoryControlSocket: true,
  ownerChannel: 'plugin-socket',
  ownerChannelSocket: null,
  auditHeadIntervalMinutes: 15,
  tickMs: 5000,
  autoExecuteReady: true,
  policyWatch: true,
  logRotation: { maxBytes: 10 * 1024 * 1024, keep: 5 },
};

export const DEFAULT_BACKUP: BackupSection = { enabled: true, dir: 'backups', keep: 14, dailyTime: '03:30' };

export interface DaemonConfig {
  home: string;
  configPath: string;
  config: LoadedConfig | null;
  policy: LoadedPolicy | null;
  policySource: 'file' | 'default' | null;
  /** Absolute path of policy.json (whether or not it exists). */
  policyPath: string | null;
  projects: ProjectRegistry | null;
  projectsPath: string | null;
  daemon: DaemonSection;
  backup: BackupSection & { absDir: string };
  issues: Issue[];
}

export const fatal = (issues: readonly Issue[]) => issues.filter((i) => i.level === 'fatal');

function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Loads every config document from the Potts home. Never throws. */
export function loadDaemonConfig(home: string, opts: { configPath?: string; skipPolicyOwnershipCheck?: boolean } = {}): DaemonConfig {
  const issues: Issue[] = [];
  const configPath = opts.configPath ?? join(home, 'potts.json');
  const out: DaemonConfig = {
    home, configPath, config: null, policy: null, policySource: null, policyPath: null, projects: null, projectsPath: null,
    daemon: { ...DEFAULT_DAEMON }, backup: { ...DEFAULT_BACKUP, absDir: join(home, DEFAULT_BACKUP.dir) }, issues,
  };
  if (!existsSync(configPath)) {
    issues.push({ level: 'fatal', area: 'config', message: `${configPath} not found (copy config/potts.example.json there and edit it)` });
    return out;
  }
  const m = modeOf(configPath);
  if (m !== null && (m & 0o022) !== 0) issues.push({ level: 'error', area: 'config', message: `${configPath} is group/world writable (mode ${m.toString(8)}); chmod 600` });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    issues.push({ level: 'fatal', area: 'config', message: `cannot parse ${configPath}: ${(e as Error).message}` });
    return out;
  }
  let accountsDoc: unknown;
  const af = raw.accountsFile;
  if (typeof af === 'string') {
    const ap = isAbsolute(af) ? af : resolve(dirname(configPath), af);
    if (!existsSync(ap)) {
      issues.push({ level: 'warn', area: 'accounts', message: `${ap} not found; no accounts are registered (every account capability is not_connected)` });
      raw = { ...raw };
      delete raw.accountsFile;
      if (!raw.accounts) raw.accounts = [];
    } else {
      try {
        accountsDoc = JSON.parse(readFileSync(ap, 'utf8'));
      } catch (e) {
        issues.push({ level: 'fatal', area: 'accounts', message: `cannot parse ${ap}: ${(e as Error).message}` });
        return out;
      }
    }
  }
  const v = validateConfig(raw, accountsDoc);
  if (!v.ok) {
    issues.push({ level: 'fatal', area: 'config', message: v.error.message });
    return out;
  }
  const cfg = v.value;
  cfg.sourcePath = resolve(configPath);
  out.config = cfg;

  const d = (cfg.daemon ?? {}) as Partial<DaemonSection>;
  out.daemon = { ...DEFAULT_DAEMON, ...d, ownerChannelSocket: d.ownerChannelSocket ?? null, logRotation: { ...DEFAULT_DAEMON.logRotation, ...(d.logRotation ?? {}) } };
  const b = (cfg.backup ?? {}) as Partial<BackupSection>;
  const backup = { ...DEFAULT_BACKUP, ...b };
  out.backup = { ...backup, absDir: isAbsolute(backup.dir) ? backup.dir : join(home, backup.dir) };

  // Policy: owner-only file. Missing → built-in defaults (the most restrictive settings); insecure/invalid → fatal.
  const policyPath = isAbsolute(cfg.policy.file) ? cfg.policy.file : join(dirname(configPath), cfg.policy.file);
  out.policyPath = policyPath;
  if (!existsSync(policyPath)) {
    const p = buildPolicy({ ...DEFAULT_POLICY, policyVersion: cfg.policy.version });
    if (p.ok) {
      out.policy = p.value;
      out.policySource = 'default';
    }
    issues.push({ level: 'warn', area: 'policy', message: `${policyPath} not found; using the built-in default policy (version ${cfg.policy.version}). Create it from config/policy.example.json (owner-only, chmod 600).` });
  } else {
    const p = loadPolicyFile(policyPath, { expectedVersion: cfg.policy.version, ...(opts.skipPolicyOwnershipCheck ? { skipOwnershipCheck: true } : {}) });
    if (!p.ok) issues.push({ level: 'fatal', area: 'policy', message: p.error.message });
    else {
      out.policy = p.value;
      out.policySource = 'file';
      const pm = modeOf(policyPath);
      if (pm !== null && (pm & 0o044) !== 0) issues.push({ level: 'warn', area: 'policy', message: `${policyPath} is readable by other users (mode ${pm.toString(8)}); chmod 600 recommended` });
    }
  }

  // Projects registry: optional.
  const ps = cfg.projects as { file?: string } | undefined;
  if (ps?.file) {
    const pp = isAbsolute(ps.file) ? ps.file : join(dirname(configPath), ps.file);
    out.projectsPath = pp;
    if (!existsSync(pp)) issues.push({ level: 'warn', area: 'projects', message: `${pp} not found; delegation and release are not_connected` });
    else {
      const r = loadProjectsFile(pp);
      if (!r.ok) issues.push({ level: 'error', area: 'projects', message: r.error.message });
      else out.projects = r.value;
    }
  }
  return out;
}
