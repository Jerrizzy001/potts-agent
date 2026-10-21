/**
 * `--check`: validates config, secrets (presence only — values are never
 * printed), file permissions and prerequisites, and prints a readiness table
 * plus the capability status. Starts nothing and writes nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { isSecretRef, resolveSecretRef, type SecretResolverOptions } from '../core/secrets.ts';
import { computeCapabilities, type Capability } from '../status/model.ts';
import { connectSocket } from '../broker/server.ts';
import { renderStatusTable } from '../status/render.ts';
import type { ControlSnapshot } from '../broker/broker.ts';
import { loadDaemonConfig, type DaemonConfig } from './config.ts';
import { daemonRunning } from './daemon.ts';

export type CheckLevel = 'OK' | 'WARN' | 'FAIL' | 'OFF';
export interface CheckRow {
  item: string;
  level: CheckLevel;
  detail: string;
}

export interface CheckReport {
  rows: CheckRow[];
  ok: boolean;
  text: string;
}

function mode(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

function nodeVersionOk(v = process.versions.node): boolean {
  const [a, b] = v.split('.').map(Number);
  return a! > 24 || (a === 24 && b! >= 12);
}

/** The executable the installed LaunchAgent runs (ProgramArguments[0]), or null when no plist is installed. macOS privacy grants (Full Disk Access, Automation) attach to this file. */
export function launchAgentExecutable(plist = join(homedir(), 'Library', 'LaunchAgents', 'local.potts.daemon.plist')): string | null {
  if (!existsSync(plist) || !existsSync('/usr/bin/plutil')) return null;
  const r = spawnSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', plist], { encoding: 'utf8', timeout: 5_000 });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v.startsWith('/') ? v : null;
}

/** Opens the DB read-only (no WAL changes, no chmod, no migrations). */
function openReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function controlsFrom(db: DatabaseSync | null, cfg: DaemonConfig): ControlSnapshot | null {
  if (!db || !cfg.config) return null;
  try {
    const rows = db.prepare('SELECT scope, state, reason, set_by, set_at FROM controls').all() as { scope: string; state: 'paused' | 'revoked'; reason: string | null; set_by: string; set_at: string }[];
    const paused = new Set(Object.entries(cfg.config.integrations.paused ?? {}).filter(([, v]) => v).map(([k]) => k));
    let global = cfg.config.integrations.pauseAll === true;
    const revoked: string[] = [];
    for (const r of rows) {
      if (r.scope === 'global' && r.state === 'paused') global = true;
      else if (r.scope.startsWith('integration:')) paused.add(r.scope.slice(12));
      else if (r.scope.startsWith('account:') && r.state === 'revoked') revoked.push(r.scope.slice(8));
    }
    return { globalPaused: global, pausedIntegrations: [...paused].sort(), revokedAccounts: revoked.sort(), runtime: rows.map((r) => ({ scope: r.scope, state: r.state, reason: r.reason, setBy: r.set_by, setAt: r.set_at })) };
  } catch {
    return null;
  }
}

export async function runCheck(o: { home: string; clock: Clock; secrets?: SecretResolverOptions; skipPolicyOwnershipCheck?: boolean }): Promise<CheckReport> {
  const rows: CheckRow[] = [];
  const add = (item: string, level: CheckLevel, detail: string) => rows.push({ item, level, detail });
  add('node', nodeVersionOk() ? 'OK' : 'FAIL', `v${process.versions.node} (need >= 24.12)`);
  const hm = mode(o.home);
  if (hm === null) add('potts home', 'FAIL', `${o.home} does not exist (mkdir -p and chmod 700)`);
  else add('potts home', (hm & 0o077) === 0 ? 'OK' : 'WARN', `${o.home} mode ${hm.toString(8)}${(hm & 0o077) !== 0 ? ' (chmod 700 recommended)' : ''}`);
  const running = daemonRunning(o.home);
  add('daemon process', running ? 'OK' : 'OFF', running ? `running (pid ${running})` : 'not running');
  const exe = launchAgentExecutable();
  if (exe) add('daemon executable', existsSync(exe) ? 'OK' : 'FAIL', existsSync(exe) ? `${exe} (grant macOS Full Disk Access to this file for iMessage)` : `${exe} is missing; re-run deploy/launchd/install-daemon.sh --apply --node <path>`);

  const dc = loadDaemonConfig(o.home, o.skipPolicyOwnershipCheck ? { skipPolicyOwnershipCheck: true } : {});
  for (const i of dc.issues) add(`config:${i.area}`, i.level === 'fatal' || i.level === 'error' ? 'FAIL' : i.level === 'warn' ? 'WARN' : 'OK', i.message);
  if (dc.config) add('config', 'OK', `${dc.configPath} valid; ${dc.config.accounts.length} account(s)`);
  if (dc.policy) add('policy', dc.policySource === 'file' ? 'OK' : 'WARN', `${dc.policySource === 'file' ? 'policy.json' : 'built-in defaults'} version ${dc.policy.version}`);
  for (const f of ['potts.json', 'accounts.json', 'projects.json', 'policy.json']) {
    const m = mode(join(o.home, f));
    if (m !== null && (m & 0o022) !== 0) add(`perm:${f}`, 'FAIL', `mode ${m.toString(8)} is group/world writable`);
    else if (m !== null && (m & 0o044) !== 0) add(`perm:${f}`, 'WARN', `mode ${m.toString(8)}; chmod 600 recommended`);
  }

  const secretStatus: { ingressKey?: boolean; ownerId?: boolean } = {};
  const check = async (item: string, ref: string | undefined, required: boolean, why: string): Promise<boolean> => {
    if (!ref) {
      add(item, required ? 'FAIL' : 'OFF', `not configured (${why})`);
      return false;
    }
    if (!isSecretRef(ref)) {
      add(item, 'FAIL', 'not a keychain:/env: reference');
      return false;
    }
    const r = await resolveSecretRef(ref, o.secrets ?? {});
    add(item, r.ok ? 'OK' : required ? 'FAIL' : 'WARN', r.ok ? `${ref} present` : `${ref} missing (${why})`);
    return r.ok;
  };
  const cfg = dc.config;
  if (cfg) {
    secretStatus.ingressKey = await check('secret:ingress key', cfg.broker?.ingressKeyRef ?? 'keychain:potts/ingress-hmac-key', true, 'owner commands and approvals');
    if (cfg.owner.channel === 'imessage') {
      secretStatus.ownerId = /^\+[1-9]\d{7,14}$/.test(cfg.owner.imessageOwnerId ?? '');
      add('owner:imessage identity', secretStatus.ownerId ? 'OK' : 'FAIL', secretStatus.ownerId ? 'configured owner identity is valid' : 'owner.imessageOwnerId is missing or invalid');
    } else {
      secretStatus.ownerId = await check('secret:owner telegram id', cfg.owner.telegramOwnerIdRef, true, 'owner commands and approvals');
    }
    const conn = (cfg.connectors ?? {}) as { google?: { clientSecretRef: string } };
    const mailAccts = cfg.accounts.filter((a) => a.kind === 'gmail' && a.mode !== 'not_connected');
    if (conn.google) await check('secret:google client', conn.google.clientSecretRef, mailAccts.length > 0, 'Gmail readers');
    const mon = (cfg.monitoring ?? {}) as { sites?: { id: string; readiness?: { tokenRef: string } }[] };
    for (const s of mon.sites ?? []) if (s.readiness) await check(`secret:monitor ${s.id}`, s.readiness.tokenRef, false, 'readiness probe');
    const tel = cfg.telephony as { enabled?: boolean; twilio?: { accountSidRef: string; authTokenRef: string } } | undefined;
    if (tel?.enabled) {
      await check('secret:twilio sid', tel.twilio?.accountSidRef, true, 'owner alert calls');
      await check('secret:twilio auth', tel.twilio?.authTokenRef, true, 'owner alert calls');
      await check('secret:owner alert number', cfg.owner.alertPhoneRef, true, 'owner alert calls');
    } else add('telephony', 'OFF', 'telephony.enabled is false');
    const cc = (cfg.delegation as { claudeCode?: { enabled?: boolean; oauthTokenRef?: string } } | undefined)?.claudeCode;
    if (cc?.enabled) {
      if (cc.oauthTokenRef) await check('secret:claude worker token', cc.oauthTokenRef, false, 'Claude Code worker subscription token');
      add('worker isolation', existsSync('/usr/bin/sandbox-exec') ? 'OK' : 'FAIL', 'sandbox-exec present; dedicated user checked at daemon start');
    } else add('delegation', 'OFF', 'delegation.claudeCode.enabled is false');
    for (const p of dc.projects?.list() ?? []) {
      if (p.release?.enabled) for (const [k, ref] of Object.entries(p.release.credentialEnv ?? {})) await check(`secret:release ${p.id} ${k}`, ref, true, 'release executor');
    }
    const writers = ((cfg.writers as { accounts?: { accountId: string; enabled: boolean }[] } | undefined)?.accounts ?? []).filter((w) => w.enabled);
    add('writers', writers.length ? 'WARN' : 'OFF', writers.length ? `enabled for ${writers.map((w) => w.accountId).join(', ')}: needs send credentials "<account>.send" (scripts/connect-account.ts --account <id> --purpose send)` : 'all writers disabled (default)');
  }
  const db = openReadOnly(join(o.home, 'potts.db'));
  add('database', db ? 'OK' : 'OFF', db ? 'potts.db present' : 'potts.db not created yet (the daemon creates it on first start)');
  let controls = controlsFrom(db, dc);
  if (controls?.globalPaused) add('controls', 'WARN', 'global pause is active');
  let caps = computeCapabilities({ config: dc.config, policy: dc.policy, projects: dc.projects, db: db as never, clock: o.clock, controls, secrets: secretStatus });
  let liveStatus = false;
  if (running && existsSync(join(o.home, 'run', 'read.sock'))) {
    try {
      const client = await connectSocket(join(o.home, 'run', 'read.sock'));
      try {
        const response = await client.call('capabilities.status');
        if (response.ok) {
          const value = response.result as { capabilities: Capability[]; controls: ControlSnapshot };
          caps = value.capabilities;
          controls = value.controls;
          liveStatus = true;
        }
      } finally { client.close(); }
    } catch { /* Report the offline view honestly if the socket is unavailable. */ }
  }
  try {
    db?.close();
  } catch {
    /* closed */
  }
  const ok = !rows.some((r) => r.level === 'FAIL');
  const w = Math.max(...rows.map((r) => r.item.length), 8);
  const table = [`${'CHECK'.padEnd(w)}  LEVEL  DETAIL`, ...rows.map((r) => `${r.item.padEnd(w)}  ${r.level.padEnd(5)}  ${r.detail}`)].join('\n');
  const text = `Potts readiness (${o.home})\n\n${table}\n\nCapabilities (${liveStatus ? 'live daemon view' : 'offline view; runtime not verified'})\n\n${renderStatusTable(caps, controls)}\n\nResult: ${ok ? 'READY' : 'NOT READY'}`;
  return { rows, ok, text };
}
