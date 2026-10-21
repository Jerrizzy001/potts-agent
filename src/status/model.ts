/**
 * Capability status (plan Phase 8: "Keep a visible capability status").
 *
 * Each capability gets exactly one state, derived from real state (config,
 * broker controls, connector status rows, sync/feed state, scheduler rows,
 * registered executors) — never from what a feature claims about itself:
 *
 *   not_connected      not configured / credentials missing / disabled
 *   read_only          reads and summarises; cannot write anywhere
 *   draft_only         prepares drafts locally; nothing leaves the Mac
 *   approval_required  can act, but every protected action needs the owner's exact approval
 *   automatic          acts on its own within a named rule (the reason names the rule)
 *   paused             blocked by an owner/system pause
 *   stale              connected but data is old or the session expired
 *   blocked            cannot work until something is fixed (reason says what)
 */
import type { Db } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import type { AccountEntry, LoadedConfig } from '../core/config.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import type { ControlSnapshot } from '../broker/broker.ts';
import type { ProjectRegistry } from '../delegation/projects.ts';

export const CAPABILITY_STATES = ['not_connected', 'read_only', 'draft_only', 'approval_required', 'automatic', 'paused', 'stale', 'blocked'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export interface Capability {
  id: string;
  group: 'core' | 'accounts' | 'monitoring' | 'routine' | 'memory' | 'delegation' | 'writers' | 'support' | 'telephony';
  label: string;
  state: CapabilityState;
  reason: string;
  /** ISO time of the last successful activity, when known. */
  lastOk?: string | null;
}

/** What only a running daemon knows. Absent when computed offline (CLI). */
export interface RuntimeFacts {
  brokerSocket: boolean;
  ingressSocket: boolean;
  readSocket: boolean;
  memoryControlSocket: boolean;
  ingressKey: boolean;
  ownerId: boolean;
  ownerChannel: 'plugin-socket' | 'none';
  executors: string[];
  scheduler: boolean;
  telephonyWebhook: boolean;
  googleClient: boolean;
  /** Accounts that have a reader instance. */
  readers: string[];
  /** Feature-level problems found during startup (area → message). */
  problems: Record<string, string>;
}

export interface StatusInputs {
  config: LoadedConfig | null;
  policy: LoadedPolicy | null;
  projects: ProjectRegistry | null;
  db: Db | null;
  clock: Clock;
  controls: ControlSnapshot | null;
  runtime?: RuntimeFacts;
  /** Secrets presence when computed offline (CLI); keys: ingressKey, ownerId. */
  secrets?: { ingressKey?: boolean; ownerId?: boolean };
}

const MIN = 60_000;

function q<T>(db: Db | null, sql: string, ...args: (string | number)[]): T[] {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return []; // table missing (migrations not applied yet) → treated as "no data"
  }
}
function one<T>(db: Db | null, sql: string, ...args: (string | number)[]): T | undefined {
  return q<T>(db, sql, ...args)[0];
}

const ago = (clock: Clock, iso: string | null | undefined) => (iso ? clock.nowMs() - Date.parse(iso) : Number.POSITIVE_INFINITY);
const fmtAgo = (ms: number) => (ms === Number.POSITIVE_INFINITY ? 'never' : ms < 2 * MIN ? 'just now' : ms < 120 * MIN ? `${Math.round(ms / MIN)} min ago` : `${Math.round(ms / 3600_000)} h ago`);

export function computeCapabilities(i: StatusInputs): Capability[] {
  const out: Capability[] = [];
  const cfg = i.config;
  const c = i.controls ?? { globalPaused: false, pausedIntegrations: [], revokedAccounts: [], runtime: [] };
  const rt = i.runtime;
  const paused = (integ: string) => c.globalPaused || c.pausedIntegrations.includes(integ);
  const pausedWhy = (integ: string) => (c.globalPaused ? 'all actions paused by the owner (/resume to continue)' : `integration ${integ} paused (/resume ${integ})`);
  const daemonDown = !rt;

  // --- core -------------------------------------------------------------------------------------------------
  const ingressKey = rt ? rt.ingressKey : i.secrets?.ingressKey === true;
  const ownerId = rt ? rt.ownerId : i.secrets?.ownerId === true;
  const ownerInterfaceId = cfg?.owner.channel ?? 'telegram';
  const ownerInterfaceLabel = `${ownerInterfaceId === 'imessage' ? 'iMessage' : 'Telegram'} owner interface`;
  let tg: Capability;
  if (!cfg) tg = { id: ownerInterfaceId, group: 'core', label: ownerInterfaceLabel, state: 'not_connected', reason: 'potts.json missing' };
  else if (!ingressKey || !ownerId)
    tg = { id: ownerInterfaceId, group: 'core', label: ownerInterfaceLabel, state: 'not_connected', reason: `missing owner configuration or secret(s): ${[!ingressKey ? 'potts/ingress-hmac-key' : '', !ownerId ? ownerInterfaceId === 'imessage' ? 'owner.imessageOwnerId' : 'potts/telegram-owner-id' : ''].filter(Boolean).join(', ')}` };
  else if (rt && !rt.ingressSocket) tg = { id: ownerInterfaceId, group: 'core', label: ownerInterfaceLabel, state: 'blocked', reason: 'ingress socket not running' };
  else {
    const failed = one<{ n: number }>(i.db, "SELECT COUNT(*) AS n FROM owner_notifications WHERE status IN ('uncertain','failed') AND updated_at >= ?", new Date(i.clock.nowMs() - 24 * 3600_000).toISOString())?.n ?? 0;
    const delivered = one<{ at: string | null }>(i.db, "SELECT MAX(delivered_at) AS at FROM owner_notifications WHERE status = 'delivered'")?.at ?? null;
    const channel = rt ? rt.ownerChannel : 'plugin-socket';
    const parts = ['owner commands and approvals via the potts-broker plugin'];
    parts.push(channel === 'none' ? 'notifications disabled (daemon.ownerChannel = none)' : 'notifications via run/owner-channel.sock');
    if (failed) parts.push(`${failed} notification(s) failed/uncertain in 24 h`);
    if (daemonDown) parts.push('runtime not verified; use the live daemon status');
    tg = { id: ownerInterfaceId, group: 'core', label: ownerInterfaceLabel, state: daemonDown ? 'blocked' : failed > 2 ? 'stale' : 'approval_required', reason: parts.join('; '), lastOk: delivered };
  }
  out.push(tg);

  const auditBroken = rt?.problems.audit;
  out.push({
    id: 'broker', group: 'core', label: 'Broker actions (approvals, audit)',
    state: !cfg || !i.policy ? 'blocked' : auditBroken ? 'blocked' : c.globalPaused ? 'paused' : daemonDown ? 'blocked' : 'approval_required',
    reason: !cfg ? 'no config' : !i.policy ? 'no valid policy' : auditBroken ? auditBroken : c.globalPaused ? pausedWhy('all')
      : daemonDown ? 'runtime not verified; dispatch availability unknown' : `always-approval actions need exact owner approval; policy ${i.policy.version}${rt ? `; executors: ${rt.executors.length ? rt.executors.join(', ') : 'none'}` : ''}`,
  });

  if (!cfg) return out;
  const accounts = cfg.accounts;
  const revoked = (id: string) => c.revokedAccounts.includes(id);
  const writersCfg = ((cfg.writers as { accounts?: { accountId: string; enabled: boolean; kinds?: string[] }[] } | undefined)?.accounts ?? []);
  const writerEnabled = (id: string) => writersCfg.some((w) => w.accountId === id && w.enabled === true) && (!rt || rt.executors.includes('message-router'));

  // --- mail accounts ----------------------------------------------------------------------------------------
  for (const a of accounts.filter((x) => x.kind === 'gmail' || x.kind === 'outlook')) {
    out.push(mailCapability(a, i, revoked(a.id), paused(a.kind) ? pausedWhy(a.kind) : null, writerEnabled(a.id)));
  }

  const imessage = (cfg.connectors as { imessage?: { readEnabled?: boolean; accountId: string } } | undefined)?.imessage;
  if (imessage) {
    const a = accounts.find(x => x.id === imessage.accountId && x.kind === 'imessage');
    out.push({ id: 'imessage-reader', group: 'accounts', label: 'iMessage search',
      state: !imessage.readEnabled || !a || a.mode === 'not_connected' ? 'not_connected' : revoked(a.id) ? 'blocked' : paused('imessage') ? 'paused' : rt?.readers.includes(a.id) ? 'read_only' : 'blocked',
      reason: !imessage.readEnabled ? 'reader disabled' : !a || a.mode === 'not_connected' ? 'local Messages source not connected' : revoked(a.id) ? 'account revoked' : paused('imessage') ? pausedWhy('imessage') : rt?.readers.includes(a.id) ? 'potts_search_imessage searches local sent and received text; read-only, no sending' : rt?.problems.imessage ?? 'read permission not verified',
    });
  }

  // --- monitoring -------------------------------------------------------------------------------------------
  const mon = (cfg.monitoring ?? { enabled: true, sites: [{ id: 'exampleapp', name: 'Example App' }] }) as { enabled?: boolean; sites?: { id: string; name?: string; enabled?: boolean; readiness?: unknown }[] };
  for (const s of mon.sites ?? []) {
    const label = `Website monitor (${s.name ?? s.id})`;
    const id = `monitor:${s.id}`;
    if (mon.enabled === false || s.enabled === false) {
      out.push({ id, group: 'monitoring', label, state: 'not_connected', reason: 'disabled in config' });
      continue;
    }
    const st = one<{ last_observation: string; last_checked_at: string }>(i.db, 'SELECT last_observation, last_checked_at FROM monitor_site_state WHERE site_id = ?', s.id);
    const open = q<{ failure_class: string; cause: string | null; status: string }>(i.db, "SELECT failure_class, cause, status FROM incidents WHERE site_id = ? AND status != 'resolved'", s.id);
    const readiness = s.readiness ? 'readiness via token-protected endpoint' : 'public homepage + /api/health only (readiness not configured)';
    const incidentText = open.length ? `; open: ${open.map((x) => `${x.failure_class === 'monitor_auth' ? 'monitor credential failing (not an outage)' : x.failure_class}${x.cause ? ` (${x.cause})` : ''}${x.status === 'acknowledged' ? ' ack' : ''}`).join(', ')}` : '';
    if (!st) out.push({ id, group: 'monitoring', label, state: daemonDown ? 'not_connected' : 'stale', reason: `no checks recorded yet; ${readiness}` });
    else if (ago(i.clock, st.last_checked_at) > 10 * MIN)
      out.push({ id, group: 'monitoring', label, state: 'stale', reason: `last check ${fmtAgo(ago(i.clock, st.last_checked_at))} (Mac asleep/offline or daemon stopped)${incidentText}`, lastOk: st.last_checked_at });
    else
      out.push({
        id, group: 'monitoring', label, state: 'automatic',
        reason: `rule: check every 60 s, outage after 10 min confirmed failure, alerts obey quiet hours; last ${st.last_observation}; ${readiness}${incidentText}`,
        lastOk: st.last_checked_at,
      });
  }

  // --- routine ----------------------------------------------------------------------------------------------
  const briefings = cfg.briefings.filter((b) => b.enabled !== false);
  const lastBrief = one<{ at: string | null }>(i.db, 'SELECT MAX(created_at) AS at FROM briefing_log')?.at ?? null;
  const channel = rt?.ownerChannel ?? 'plugin-socket';
  out.push({
    id: 'briefings', group: 'routine', label: 'Scheduled briefings',
    state: !briefings.length ? 'not_connected' : channel === 'none' ? 'blocked' : daemonDown ? 'stale' : 'automatic',
    reason: !briefings.length ? 'no briefings enabled' : channel === 'none' ? 'no owner channel (daemon.ownerChannel = none)'
      : `${daemonDown ? 'runtime not verified; ' : ''}rule: ${briefings.map((b) => b.time).join(', ')} ${cfg.owner.timezone}; quiet hours ${cfg.quietHours.start}-${cfg.quietHours.end}; last ${fmtAgo(ago(i.clock, lastBrief))}`,
    lastOk: lastBrief,
  });

  out.push({
    id: 'local-drafts', group: 'memory', label: 'Controlled draft storage',
    state: paused('drafts') ? 'paused' : rt?.executors.includes('local-drafts') ? 'draft_only' : 'not_connected',
    reason: paused('drafts') ? pausedWhy('drafts') : rt?.executors.includes('local-drafts')
      ? 'save real files on this Mac with potts_save_file; retrieve with potts_read_content; this helper uses the controlled Potts drafts folder; delegated worker file access is separate; scripts here are saved, not executed'
      : 'local draft executor not verified',
  });

  // --- memory / style ---------------------------------------------------------------------------------------
  const facts = one<{ n: number }>(i.db, 'SELECT COUNT(*) AS n FROM memory_facts')?.n;
  const emb = ((cfg.memory as { embeddings?: { provider?: string } } | undefined)?.embeddings?.provider) ?? 'disabled';
  out.push({
    id: 'memory', group: 'memory', label: 'Daemon fact memory',
    state: facts === undefined ? 'not_connected' : 'read_only',
    reason: facts === undefined ? 'memory tables missing (start the daemon once to migrate)' : `${facts} fact(s); local search (${emb === 'disabled' ? 'full-text only' : `embeddings: ${emb}`}); workspace recall and learning are separate stores; /forget enabled${rt && !rt.memoryControlSocket ? ' (memory-control socket off)' : ''}`,
  });
  const styleBuild = one<{ at: string | null }>(i.db, 'SELECT MAX(built_at) AS at FROM style_builds')?.at ?? null;
  const ratings = q<{ register: string; n: number; avg: number }>(i.db, 'SELECT register, COUNT(rating) AS n, AVG(rating) AS avg FROM style_review_samples WHERE rating IS NOT NULL GROUP BY register');
  const accepted = ratings.filter((r) => r.n >= 5 && r.avg >= 4).map((r) => r.register);
  out.push({
    id: 'style', group: 'memory', label: 'Texting style',
    state: !styleBuild ? 'not_connected' : 'draft_only',
    reason: !styleBuild ? 'no style build yet (npm run memory -- style build; needs Full Disk Access)' : `built ${fmtAgo(ago(i.clock, styleBuild))}; accepted registers: ${accepted.length ? accepted.join(', ') : 'none yet (rate samples)'}; drafts only, never sends`,
    lastOk: styleBuild,
  });

  // --- delegation / release ---------------------------------------------------------------------------------
  const cc = ((cfg.delegation as { claudeCode?: { enabled?: boolean } } | undefined)?.claudeCode) ?? {};
  out.push({
    id: 'delegation', group: 'delegation', label: 'Isolated broker coding worker',
    state: !i.projects ? 'not_connected' : cc.enabled !== true ? 'not_connected' : rt?.problems.delegation ? 'blocked' : 'draft_only',
    reason: !i.projects ? 'projects.json missing' : cc.enabled !== true ? 'daemon delegation.claudeCode.enabled is false; this does not describe the separate OpenClaw Sol/Claude workers (use potts_worker_status). External handoffs remain manual'
      : rt?.problems.delegation ?? 'prepares fixes in an isolated worker; evidence reviewed independently; never merges or deploys',
  });
  for (const p of i.projects?.list() ?? []) {
    const enabled = p.release?.enabled === true;
    const registered = !rt || rt.executors.some((e) => e.startsWith('release'));
    out.push({
      id: `release:${p.id}`, group: 'delegation', label: `Release (${p.displayName ?? p.id})`,
      state: !enabled ? 'not_connected' : paused('deploy') ? 'paused' : registered ? 'approval_required' : 'blocked',
      reason: !enabled ? 'release.enabled is false in projects.json' : paused('deploy') ? pausedWhy('deploy') : registered ? 'exact commit + target approval; release executor rechecks before running' : 'release executor not registered',
    });
  }

  // --- writers ----------------------------------------------------------------------------------------------
  for (const w of writersCfg) {
    const acct = accounts.find((a) => a.id === w.accountId);
    const label = `Writer (${w.accountId})`;
    const id = `writer:${w.accountId}`;
    if (!w.enabled) out.push({ id, group: 'writers', label, state: 'not_connected', reason: 'disabled in config (writers.accounts[].enabled = false)' });
    else if (!acct) out.push({ id, group: 'writers', label, state: 'blocked', reason: 'account not registered' });
    else if (revoked(acct.id)) out.push({ id, group: 'writers', label, state: 'blocked', reason: 'account revoked by the owner' });
    else if (paused('messaging') || paused(acct.kind)) out.push({ id, group: 'writers', label, state: 'paused', reason: pausedWhy(paused('messaging') ? 'messaging' : acct.kind) });
    else if (rt && !rt.executors.includes('message-router')) out.push({ id, group: 'writers', label, state: 'blocked', reason: rt.problems.writers ?? 'writer not registered' });
    else out.push({ id, group: 'writers', label, state: 'approval_required', reason: 'every send needs the owner to approve the exact recipient, account and content' });
  }

  // --- support ----------------------------------------------------------------------------------------------
  const sup = (cfg.support ?? { enabled: false, channels: [] }) as { enabled?: boolean; channels?: { id: string; kind: string; enabled: boolean; mode: string }[] };
  for (const ch of sup.channels ?? []) {
    const id = `support:${ch.id}`;
    const label = `Support (${ch.id})`;
    if (sup.enabled !== true || !ch.enabled) out.push({ id, group: 'support', label, state: 'not_connected', reason: sup.enabled !== true ? 'support.enabled is false' : 'channel disabled' });
    else out.push({ id, group: 'support', label, state: 'not_connected', reason: `${ch.mode} mode configured, but no inbound connector exists for ${ch.kind} yet; drafts would be ${ch.mode === 'shadow' ? 'kept for review' : 'proposed'}` });
  }

  // --- telephony --------------------------------------------------------------------------------------------
  const tel = cfg.telephony as { enabled?: boolean; conversation?: { enabled?: boolean } } | undefined;
  out.push({
    id: 'telephony', group: 'telephony', label: 'Owner alert calls (not an emergency service)',
    state: tel?.enabled !== true ? 'not_connected' : paused('telephony') ? 'paused' : rt && !rt.executors.some((e) => e.startsWith('owner-alert-call')) ? 'blocked' : rt && !rt.telephonyWebhook ? 'blocked' : 'automatic',
    reason: tel?.enabled !== true ? 'telephony.enabled is false' : paused('telephony') ? pausedWhy('telephony')
      : rt && !rt.executors.some((e) => e.startsWith('owner-alert-call')) ? (rt.problems.telephony ?? 'executor not registered')
      : rt && !rt.telephonyWebhook ? 'callback webhook not running' : 'rule: agreed triggers only, never 23:00-08:00, max 3 attempts 5 min apart, stops on keypress 1',
  });
  out.push({
    id: 'voice-conversation', group: 'telephony', label: 'Two-way phone conversations',
    state: !tel?.enabled || !tel.conversation?.enabled ? 'not_connected' : paused('telephony') ? 'paused' : !rt || !rt.telephonyWebhook || !rt.executors.includes('voice-question-call:twilio') ? 'blocked' : 'approval_required',
    reason: !tel?.enabled || !tel.conversation?.enabled ? 'conversation disabled; provider activation and phone testing pending'
      : paused('telephony') ? pausedWhy('telephony')
      : !rt || !rt.telephonyWebhook || !rt.executors.includes('voice-question-call:twilio') ? 'voice runtime not verified'
      : 'owner calls require Telegram verification; read connected content, save drafts, propose calls; outbound questions need exact Telegram approval; no shell, purchases or commitments',
  });
  return out;
}

function mailCapability(a: AccountEntry, i: StatusInputs, isRevoked: boolean, pausedReason: string | null, writer: boolean): Capability {
  const id = `mail:${a.id}`;
  const label = `${a.kind === 'gmail' ? 'Gmail' : 'Outlook'} (${a.id})`;
  if (a.mode === 'not_connected') return { id, group: 'accounts', label, state: 'not_connected', reason: 'account mode is not_connected in accounts.json' };
  if (isRevoked) return { id, group: 'accounts', label, state: 'blocked', reason: 'revoked by the owner (/potts reinstate after reconnecting)' };
  if (pausedReason) return { id, group: 'accounts', label, state: 'paused', reason: pausedReason };
  const st = one<{ status: string; status_reason: string | null }>(i.db, 'SELECT status, status_reason FROM connector_accounts WHERE account_id = ?', a.id);
  const provider = a.kind === 'gmail' ? 'google' : 'microsoft';
  if (i.runtime && provider === 'google' && !i.runtime.googleClient) return { id, group: 'accounts', label, state: 'blocked', reason: i.runtime.problems.google ?? 'Google OAuth client not configured' };
  if (!st || st.status === 'not_connected') return { id, group: 'accounts', label, state: 'not_connected', reason: `not connected (scripts/connect-account.ts --account ${a.id})` };
  if (st.status === 'stale_auth') return { id, group: 'accounts', label, state: 'stale', reason: `sign-in expired: ${st.status_reason ?? 'refresh failed'}; re-run connect-account` };
  if (st.status === 'revoked') return { id, group: 'accounts', label, state: 'blocked', reason: 'access revoked; reconnect to use again' };
  if (st.status === 'admin_consent_required') return { id, group: 'accounts', label, state: 'blocked', reason: `tenant admin consent required: ${st.status_reason ?? ''}`.trim() };
  if (st.status === 'error') return { id, group: 'accounts', label, state: 'blocked', reason: st.status_reason ?? 'connector error' };
  const sync = one<{ status: string; status_reason: string | null; last_success_at: string | null }>(i.db, 'SELECT status, status_reason, last_success_at FROM mail_sync_state WHERE account_id = ?', a.id);
  const last = sync?.last_success_at ?? null;
  if (sync && sync.status !== 'ok' && sync.status !== 'never' && sync.status !== 'paused') return { id, group: 'accounts', label, state: sync.status === 'rate_limited' ? 'stale' : sync.status === 'stale_auth' ? 'stale' : 'blocked', reason: `last sync ${sync.status}: ${sync.status_reason ?? ''}`.trim(), lastOk: last };
  if (!last) return { id, group: 'accounts', label, state: 'stale', reason: 'connected; first sync not finished yet' };
  if (ago(i.clock, last) > 30 * MIN) return { id, group: 'accounts', label, state: 'stale', reason: `last successful sync ${fmtAgo(ago(i.clock, last))}`, lastOk: last };
  const base: Capability['state'] = writer ? 'approval_required' : a.mode === 'read_only' ? 'read_only' : 'draft_only';
  return {
    id, group: 'accounts', label, state: base,
    reason: `synced ${fmtAgo(ago(i.clock, last))}; ${writer ? 'sends need exact owner approval' : base === 'read_only' ? 'read and summarise only' : 'replies drafted locally; sending not enabled'}`,
    lastOk: last,
  };
}
