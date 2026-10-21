/**
 * The Potts daemon: trusted startup wiring for every work package.
 *
 * Order (each step degrades instead of crashing when optional config or a
 * secret is missing; the feature is then reported `not_connected`/`blocked`):
 *   config → single-instance lock → DB + migrations → audit verification and
 *   exported-head check → stores → executors (only those enabled in config) →
 *   broker (hooks.ownerAlert) → broker.recover() → owner channel + owner
 *   controls → readers/monitor/memory/drafts/briefings/deadlines/alerts →
 *   scheduler (single authority) → sockets.
 *
 * Nothing here is reachable by the model: the model only sees broker.sock
 * (propose/status/list) and read.sock (read-only views).
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock } from '../core/clock.ts';
import { createAccountRegistry, loadSchema, type AccountEntry } from '../core/config.ts';
import { hashCanonical } from '../core/hash.ts';
import { createLogger, type Logger } from '../core/log.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { resolveSecretRef, type SecretResolverOptions } from '../core/secrets.ts';
import { ensurePottsHome, type PottsPaths } from '../store/home.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { migrate } from '../store/migrate.ts';
import { createAuditLedger, type AuditLedger } from '../audit/ledger.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import { createIngressVerifier } from '../approvals/ingress.ts';
import { createExecutorRegistry } from '../broker/executor.ts';
import { createBroker, type Broker, type BrokerOptions } from '../broker/broker.ts';
import { createOwnerControls, type OwnerControls } from '../broker/owner.ts';
import { startBrokerServer, startIngressServer, type RunningServer } from '../broker/server.ts';
import { createPluginSocketOwnerChannel, type OwnerChannel as PluginOwnerChannel } from '../owner/owner-channel.ts';
import { createScheduler, JobError, type Scheduler } from '../jobs/scheduler.ts';
import { registerStandardJobs, type SyncResult, type SyncSource } from '../jobs/standard.ts';
import { createOutbox, type Outbox } from '../notifications/outbox.ts';
import { createReminderStore } from '../notifications/reminders.ts';
import { quietHoursFromConfig, type QuietHoursConfig } from '../notifications/quiet-hours.ts';
import { createUrgentEventStore, type UrgentEventStore } from '../notifications/urgent.ts';
import { bindUrgentEventsToOutbox } from '../notifications/bind.ts';
import { createDeadlineWatcher } from '../notifications/deadlines.ts';
import { createBriefingComposer, type BriefingProviders } from '../notifications/briefings.ts';
import { workerBriefingItems } from '../notifications/worker-progress.ts';
import { summarizerFromConfig } from '../notifications/summarizer.ts';
import { normalizeMonitoringConfig } from '../monitoring/config.ts';
import { createSiteMonitor, type SiteMonitor } from '../monitoring/monitor.ts';
import { createTokenReadinessProbe } from '../monitoring/probe.ts';
import {
  brokerReadGate, brokerRevocationSink, connectorsConfigFrom, microsoftConfigsFrom, createAccountStatusStore, createKeychainTokenStore, resolveProviderConfigs, tokenProviderFor,
  type AccountStatusStore, type FetchLike, type ProviderConfigs, type TokenStore,
} from '../connectors/oauth/index.ts';
import { createMailStore, createLmStudioClassifier, type MailStore } from '../connectors/mail/index.ts';
import { createGmailReader } from '../connectors/gmail/index.ts';
import { createOutlookReader } from '../connectors/outlook/index.ts';
import { registerMessageWriters, type WritersConfig, type OsascriptRunner } from '../connectors/writers/index.ts';
import { memoryConfigFrom, openMemory, type MemoryStore } from '../memory/index.ts';
import { createDelegationExecutor, projectFixScope } from '../delegation/executor.ts';
import { searchMessages } from '../connectors/imessage/search.ts';
import { DEFAULT_CHAT_DB, openReadOnly } from '../connectors/imessage/reader.ts';
import { createLocalDraftExecutor, localDraftScope } from '../drafts/executor.ts';
import { createDraftWorkspace, type DraftWorkspace } from '../drafts/index.ts';
import {
  createOwnerAlertHook, createOwnerAlertService, createTelephonyStore, createTwilioProvider, createTwilioWebhookHandler, registerOwnerAlertCalls, refreshCallUsage,
  startTelephonyWebhookServer, validateTelephonyConfig, type OwnerAlertService, type TelephonyConfig, type TelephonyProvider, type TelephonyStore, type TelephonyWebhookServer,
} from '../telephony/index.ts';
import { createSupportRegistry, createSupportEngine, loadKnowledgeDir, type SupportEngine } from '../support/index.ts';
import { createReleaseRequests } from '../release/requests.ts';
import { createReleaseExecutor, createReleaseManager, type ReleaseManager } from '../release/index.ts';
import {
  createClaudeCodeAdapter, createDelegationGovernor, createDelegationService, createExternalAdapter, createPaidEscalationGuard, resolveDelegationConfig,
  type DelegationGovernor, type DelegationService, type IsolatedRunner, type ProjectRegistry, type RunResult, type RunSpec,
} from '../delegation/index.ts';
import { createDedicatedUserRunner } from '../workers/isolation/index.ts';
import { computeCapabilities, type Capability, type RuntimeFacts } from '../status/model.ts';
import { loadDaemonConfig, fatal, type DaemonConfig } from './config.ts';
import { mailPrioritySource, mailSyncSource } from './sources.ts';
import { createSessionGuard, ownerAgentId } from './session-guard.ts';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { createApprovalNotifier, outboxChannelFromPlugin, unavailableOwnerChannel } from './owner-notify.ts';
import { bindUrgentEventsToAlertCalls, createQuietHoursDecider, createTestAwareIncidentValidator, createUrgentIncidentValidator, TEST_CALL_PREFIX } from './alerts.ts';
import { createPolicyReloader, type PolicyReloader, type PolicyReloadResult, type PolicyReloadTrigger } from './policy-reload.ts';
import { rotateLogs } from './logrotate.ts';
import { appendAuditHead, checkAuditHead, lastAuditHead, type HeadKind } from './audit-head.ts';
import { createWriterTokenProvider } from './tokens.ts';
import { contentReader } from './content-reader.ts';
import { startMemoryControlServer, startReadServer } from './read-server.ts';
import { createBackup } from '../backup/backup.ts';
import { createVoiceTools } from '../telephony/voice-tools.ts';
import { createVoiceService, VOICE_PATHS } from '../telephony/voice.ts';
import { newId } from '../core/ids.ts';
import { listAccountPurgeReceipts, purgeAccountData, type AccountPurgeReceipt } from '../connectors/oauth/purge.ts';

export interface DaemonOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  logger?: Logger;
  /** All outbound HTTP (monitoring, OAuth, Gmail/Graph, LM Studio, Twilio). */
  fetch?: FetchLike;
  /** Keychain lookup for secret references (default: /usr/bin/security). */
  keychainLookup?: SecretResolverOptions['keychainLookup'];
  /** OAuth token store (default: Keychain, service connectors.tokenStore.keychainService). */
  tokenStore?: TokenStore;
  /** Owner channel (default: the plugin's run/owner-channel.sock). */
  pluginOwnerChannel?: PluginOwnerChannel;
  telephonyProvider?: TelephonyProvider;
  runOsascript?: OsascriptRunner;
  /** Release executor command runner (default: local spawn as the release identity). */
  releaseRun?: (spec: RunSpec) => Promise<RunResult>;
  /** Isolated runner for delegated coding (default: the dedicated potts-worker user). */
  isolatedRunner?: IsolatedRunner;
  /** TESTS ONLY: allow a runner without an OS user boundary. */
  allowUnisolatedRunner?: boolean;
  skipPolicyOwnershipCheck?: boolean;
  /** TESTS ONLY: broker crash hooks. */
  brokerTestHooks?: BrokerOptions['testHooks'];
  instanceId?: string;
}

export interface Daemon {
  readonly home: string;
  readonly paths: PottsPaths;
  readonly cfg: DaemonConfig;
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  readonly audit: AuditLedger;
  readonly broker: Broker;
  readonly owner: OwnerControls | null;
  readonly scheduler: Scheduler;
  readonly outbox: Outbox;
  readonly urgent: UrgentEventStore;
  readonly monitor: SiteMonitor | null;
  readonly memory: MemoryStore | null;
  readonly drafts: DraftWorkspace | null;
  readonly mailStore: MailStore;
  readonly statusStore: AccountStatusStore;
  readonly telephonyStore: TelephonyStore;
  readonly alerts: OwnerAlertService | null;
  readonly releaseManager: ReleaseManager | null;
  readonly delegation: DelegationService | null;
  /** Creates delegation tasks (validated specs); null when delegation is not enabled. */
  readonly delegationGovernor: DelegationGovernor | null;
  readonly support: SupportEngine | null;
  readonly quiet: QuietHoursConfig;
  readonly jobIds: string[];
  /** Startup facts: problems per area, executors, sockets. */
  runtime(): RuntimeFacts;
  capabilities(): Capability[];
  /** Starts sockets (and real timers unless timers=false). */
  start(opts?: { timers?: boolean }): Promise<void>;
  /** One scheduler pass (tests drive time with a fake clock). */
  tick(): Promise<void>;
  /** Writes the audit head journal now. */
  exportAuditHead(kind: HeadKind): void;
  /** Re-reads policy.json (SIGHUP / file change). Invalid files are rejected and the current policy stays. */
  reloadPolicy(trigger?: PolicyReloadTrigger): PolicyReloadResult;
  /** The policy currently in force. */
  policy(): LoadedPolicy;
  /** Rotates logs/daemon.out.log and daemon.err.log when over the size limit. */
  rotateLogs(): { rotated: string[]; removed: string[] };
  /** Deletion receipts written when the owner revoked an account (latest first). */
  purgeReceipts(): AccountPurgeReceipt[];
  stop(reason?: string): Promise<void>;
}

const LOCK_NAME = 'daemon.lock';

/** Single-instance lock (pid file in run/). A stale lock (dead pid) is replaced. */
export function acquireLock(runDir: string): Result<{ release(): void }> {
  const path = join(runDir, LOCK_NAME);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return ok({ release: () => rmSync(path, { force: true }) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return perr('internal', `cannot create lock: ${(e as Error).message}`);
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return perr('internal', `another Potts daemon is running (pid ${pid}); stop it first`);
      rmSync(path, { force: true });
    }
  }
  return perr('internal', 'could not acquire the daemon lock');
}

export function daemonRunning(home: string): number | null {
  const path = join(home, 'run', LOCK_NAME);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function createDaemon(o: DaemonOptions): Promise<Result<Daemon>> {
  const home = o.home;
  const env = o.env ?? process.env;
  const clock = o.clock ?? systemClock;
  const log = o.logger ?? createLogger({ clock, level: (env.POTTS_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info', sink: (l) => process.stderr.write(l + '\n') });
  const fetchFn: FetchLike = o.fetch ?? (globalThis.fetch as FetchLike);
  const secretOpts: SecretResolverOptions = { env, ...(o.keychainLookup ? { keychainLookup: o.keychainLookup } : {}) };
  const resolve = (ref: string) => resolveSecretRef(ref, secretOpts);

  const dc = loadDaemonConfig(home, o.skipPolicyOwnershipCheck ? { skipPolicyOwnershipCheck: true } : {});
  for (const i of dc.issues) log[i.level === 'fatal' || i.level === 'error' ? 'error' : i.level === 'warn' ? 'warn' : 'info']('config', { area: i.area, message: i.message });
  const fat = fatal(dc.issues);
  if (fat.length || !dc.config || !dc.policy) return perr('config_invalid', fat.map((i) => `${i.area}: ${i.message}`).join('; ') || 'config not loaded');
  const cfg = dc.config;
  const policyRef: { current: LoadedPolicy } = { current: dc.policy };
  const paths = ensurePottsHome(home);
  const lock = acquireLock(paths.runDir);
  if (!lock.ok) return lock;

  const problems: Record<string, string> = {};
  let db: Db;
  try {
    db = openDatabase(paths.db);
    migrate(db, { clock });
  } catch (e) {
    lock.value.release();
    return perr('internal', `database: ${(e as Error).message}`);
  }
  const audit = createAuditLedger(db, clock);
  const accounts = createAccountRegistry(cfg.accounts);
  const tz = cfg.owner.timezone;
  const quiet = quietHoursFromConfig(cfg);

  // --- notifications core ------------------------------------------------------------------------------------
  const urgent = createUrgentEventStore(db, clock);
  const outbox = createOutbox({ db, clock, quiet, logger: log });
  bindUrgentEventsToOutbox(urgent, outbox);

  // --- telephony (hook is always installed: without an executor, calls are no_executor) ------------------------
  const telephonyStore = createTelephonyStore(db, clock);
  const decider = createQuietHoursDecider(quiet);
  // Urgent-event incidents, plus owner-requested `test:` incidents (one ring, 10-minute validity).
  const incidentValidator = createTestAwareIncidentValidator(createUrgentIncidentValidator(urgent), telephonyStore, clock);
  const ownerAlertHook = createOwnerAlertHook({ store: telephonyStore, decider, incidents: incidentValidator, clock });
  let telCfg: TelephonyConfig | null = null;
  {
    const r = validateTelephonyConfig(cfg.telephony, accounts, loadSchema());
    if (!r.ok) problems.telephony = r.error.message;
    else telCfg = r.value;
  }

  // --- connectors: token store, provider configs ------------------------------------------------------------
  const conn = connectorsConfigFrom(cfg);
  const statusStore = createAccountStatusStore(db, clock);
  const tokenStore = o.tokenStore ?? createKeychainTokenStore({ service: conn.tokenStore?.keychainService ?? 'potts-oauth' });
  let providerConfigs: ProviderConfigs = {};
  {
    const r = await resolveProviderConfigs(conn, secretOpts);
    if (r.ok) providerConfigs = r.value;
    else {
      problems.google = r.error.message;
      providerConfigs = microsoftConfigsFrom(conn);
    }
  }

  // --- executors (trusted startup only; registry is frozen by createBroker) ----------------------------------
  let drafts: DraftWorkspace | null = null;
  let delegation: DelegationService | null = null;
  let delegationGovernor: DelegationGovernor | null = null;
  const dcfg = resolveDelegationConfig(cfg);
  const registry = createExecutorRegistry();
  registry.register(createLocalDraftExecutor(() => drafts));
  if (dc.projects && dcfg.claudeCode.enabled) registry.register(createDelegationExecutor({ db, projects: dc.projects, service: () => delegation, governor: () => delegationGovernor, timeoutMs: (dcfg.claudeCode.timeoutSeconds + 600) * 1000 }));
  try {
    registerMessageWriters(registry, cfg.writers as WritersConfig | undefined, {
      db, clock, accounts,
      tokens: createWriterTokenProvider({ accounts, tokenStore, statusStore, configs: providerConfigs, fetch: fetchFn, clock }),
      fetch: fetchFn,
      ...(o.runOsascript ? { runOsascript: o.runOsascript } : {}),
    });
  } catch (e) {
    problems.writers = (e as Error).message;
  }
  let voice: ReturnType<typeof createVoiceService> | null = null;
  let closeVoice: (() => void) | null = null;
  let telephonyProvider: TelephonyProvider | null = null;
  let twilioSid: string | null = null;
  if (telCfg?.enabled) {
    try {
      if (o.telephonyProvider) telephonyProvider = o.telephonyProvider;
      else {
        const sid = await resolve(telCfg.twilio.accountSidRef);
        if (!sid.ok) throw new Error('Twilio account SID secret unavailable');
        twilioSid = sid.value;
        const userRef = telCfg.twilio.apiKeySidRef;
        const passRef = telCfg.twilio.apiKeySecretRef ?? telCfg.twilio.authTokenRef;
        telephonyProvider = createTwilioProvider({
          accountSid: sid.value, fetch: fetchFn, ...(telCfg.twilio.voice ? { voice: telCfg.twilio.voice } : {}),
          credentials: async () => {
            const u = userRef ? await resolve(userRef) : ok(sid.value);
            const p = await resolve(passRef);
            if (!u.ok || !p.ok) throw new Error('Twilio credentials unavailable');
            return { username: u.value, password: p.value };
          },
        });
      }
      const ownerRef = cfg.owner.alertPhoneRef;
      if (!ownerRef) throw new Error('owner.alertPhoneRef is not configured');
      registerOwnerAlertCalls(registry, telCfg, {
        store: telephonyStore, clock, provider: telephonyProvider, decider, incidents: incidentValidator, policy: () => policyRef.current, accounts,
        ownerNumber: async () => {
          const r = await resolve(ownerRef);
          if (!r.ok) throw new Error('owner alert number unavailable');
          return r.value;
        },
      });
      if (telCfg.conversation?.enabled && twilioSid) {
        const tc = telCfg;
        voice = createVoiceService({
          db, clock, config: tc.conversation!, publicBaseUrl: tc.publicBaseUrl, accountSid: twilioSid,
          accountId: tc.accountId, fromNumber: accounts.get(tc.accountId)!.address, fetch: fetchFn as typeof fetch,
          ownerNumber: async () => { const r = await resolve(ownerRef); if (!r.ok) throw new Error('owner number unavailable'); return r.value; },
          authToken: async () => { const r = await resolve(tc.twilio.authTokenRef); if (!r.ok) throw new Error('auth token unavailable'); return r.value; },
          credentials: async () => {
            const u = await resolve(tc.twilio.apiKeySidRef ?? tc.twilio.accountSidRef);
            const p = await resolve(tc.twilio.apiKeySecretRef ?? tc.twilio.authTokenRef);
            if (!u.ok || !p.ok) throw new Error('voice credentials unavailable'); return { username: u.value, password: p.value };
          },
          paused: () => { const c = broker.controls(); return c.globalPaused || c.pausedIntegrations.includes('telephony') || c.revokedAccounts.includes(tc.accountId); },
          tools: createVoiceTools({ broker: () => broker, accountId: tc.accountId, read: p => contentReader({ home, clock, accounts: cfg.accounts, controls: () => broker.controls(), mail: mailStore, drafts })(p) }),
          sendCode: async text => pluginChannel ? (await pluginChannel.notify({ text, silent: true })).ok : false,
          notify: (id, text) => { outbox.enqueue({ dedupKey: `voice-recap:${id}`, category: 'reply', text }); },
        });
        registry.register(voice.executor);
      }
    } catch (e) {
      problems.telephony = (e as Error).message;
      telephonyProvider = null;
    }
  }
  const projects: ProjectRegistry | null = dc.projects;
  if (projects && projects.list().some((p) => p.release?.enabled === true)) {
    try {
      registry.register(createReleaseExecutor({
        enabled: true, projects, workRoot: join(home, 'release-work'), clock, secretResolver: secretOpts, fetch: fetchFn as typeof fetch,
        ...(o.releaseRun ? { run: o.releaseRun } : {}),
      }));
    } catch (e) {
      problems.release = (e as Error).message;
    }
  }

  // --- broker -----------------------------------------------------------------------------------------------
  const broker = createBroker({
    db, clock, audit, policy: () => policyRef.current, accounts, executors: registry, staticControls: cfg.integrations,
    hooks: { ownerAlert: ownerAlertHook, scoped: a => a.kind === 'prepare_fix' ? projectFixScope(a, dc.projects, delegation !== null) : localDraftScope(a) }, ...(cfg.broker?.executorTimeoutMs ? { executorTimeoutMs: cfg.broker.executorTimeoutMs } : {}), logger: log,
    ...(o.brokerTestHooks ? { testHooks: o.brokerTestHooks } : {}),
  });
  const executors = registry.list().map((e) => e.name);

  // Audit integrity: chain verification + exported head (truncation) check. A failure pauses everything.
  const ver = audit.verify();
  const headCheck = checkAuditHead(db, lastAuditHead(home));
  if (!ver.ok || !headCheck.ok) {
    const reason = !ver.ok ? `audit chain broken at seq ${ver.brokenAtSeq}: ${ver.reason}` : (headCheck as { reason: string }).reason;
    problems.audit = reason;
    broker.emergencyPause(`integrity: ${reason}`, 'daemon');
    audit.append({ type: 'integrity_alert', actor: 'system:daemon', data: { reason } });
    outbox.enqueue({ dedupKey: `integrity:${clock.nowIso().slice(0, 10)}`, category: 'important', text: `Potts integrity check failed and all actions are paused: ${reason.slice(0, 300)}. Investigate before /resume (docs/runbooks/incident-response.md).` });
    log.error('audit integrity failure; all actions paused', { reason });
  }
  const recovered = broker.recover();
  const outboxRecovered = outbox.recover();
  if (outboxRecovered) log.warn('owner notifications left uncertain by a crash', { count: outboxRecovered });

  // --- owner identity, ingress key, owner channel -----------------------------------------------------------
  const keyR = await resolve(cfg.broker?.ingressKeyRef ?? 'keychain:potts/ingress-hmac-key');
  const ingressKey = keyR.ok && Buffer.byteLength(keyR.value, 'utf8') >= 32 ? keyR.value : null;
  if (!ingressKey) problems.ingress = keyR.ok ? 'ingress key shorter than 32 bytes' : 'ingress key not available (keychain potts/ingress-hmac-key)';
  const ownerSource = cfg.owner.channel ?? 'telegram';
  const ownerR = ownerSource === 'imessage' ? ok(cfg.owner.imessageOwnerId ?? '') : await resolve(cfg.owner.telegramOwnerIdRef);
  const ownerId = ownerR.ok && (ownerSource === 'imessage' ? /^\+[1-9]\d{7,14}$/ : /^[1-9][0-9]{0,19}$/).test(ownerR.value) ? ownerR.value : null;
  if (!ownerId) problems.owner = 'verified owner identity unavailable for the configured channel';
  // Late-bound: memory and the alert service are created further down; owner intents only arrive after start().
  const late: { memory: MemoryStore | null; alerts: OwnerAlertService | null } = { memory: null, alerts: null };
  const owner = ingressKey && ownerId
    ? createOwnerControls(broker, createIngressVerifier({ key: ingressKey, ownerSenderId: ownerId, source: ownerSource, clock }), accounts, {
      // `/potts testcall`: one `test` owner-alert call, only when telephony is enabled and calls are allowed now.
      testCall: (actor) => {
        if (!telCfg?.enabled) return perr('no_executor', 'owner alert calls are disabled (telephony.enabled is false); no call placed');
        if (!late.alerts) return perr('no_executor', `owner alert calls are not available: ${problems.telephony ?? 'executor not registered'}; no call placed`);
        const q = decider.evaluateCall(clock.now());
        if (!q.allowed) return perr('held', `no call now: ${q.reason}${q.nextAllowedAt ? ` (calls allowed again ${q.nextAllowedAt})` : ''}; nothing was queued`);
        const incidentId = `${TEST_CALL_PREFIX}${newId('call', clock)}`;
        const r = late.alerts.raise({ incidentId, trigger: 'test', label: 'test' });
        if (!r.ok) return r;
        log.info('owner test call queued', { incidentId, actor });
        return ok({ incidentId, message: `Test call queued (${incidentId}). Your phone should ring within about a minute; press 1 to acknowledge. There are no retries for a test call.` });
      },
      // `/revoke <account>`: after the broker revocation committed, purge everything synced from that account.
      afterIntent: (intent, actor) => {
        if (intent.type !== 'revoke_account') return;
        const acct = accounts.get(intent.accountId);
        if (!acct || !['gmail', 'outlook'].includes(acct.kind)) return;
        const receipt = purgeAccountData({ db, clock, accountId: acct.id, actor, reason: intent.reason ?? 'owner revoked the account', memory: late.memory, audit });
        const n = receipt.counts;
        outbox.enqueue({
          dedupKey: `account-purge:${receipt.id}`, category: 'important',
          text: `Account ${acct.id} revoked. Deleted ${n.mailItems} mail item(s), sync cursors${receipt.memory ? ` and ${receipt.memory.facts} memory fact(s)` : ''}. Receipt ${receipt.id}. Credentials stay in the Keychain until you run scripts/connect-account.ts --account ${acct.id} --revoke.`,
        });
      },
    })
    : null;
  let pluginChannel: PluginOwnerChannel | null = o.pluginOwnerChannel ?? null;
  if (!pluginChannel && dc.daemon.ownerChannel === 'plugin-socket' && ingressKey)
    pluginChannel = createPluginSocketOwnerChannel({ socketPath: dc.daemon.ownerChannelSocket ?? join(paths.runDir, 'owner-channel.sock'), key: ingressKey });
  outbox.setChannel(pluginChannel ? outboxChannelFromPlugin(pluginChannel) : unavailableOwnerChannel);
  const approvalNotifier = createApprovalNotifier({ approvals: broker.approvals, outbox, clock, timezone: tz });

  // --- readers ----------------------------------------------------------------------------------------------
  const gate = brokerReadGate(broker);
  const revocationSink = brokerRevocationSink(broker);
  const mailCfg = conn.mail ?? {};
  const mailStore = createMailStore(db, clock, { ...(mailCfg.schoolDomains ? { schoolDomains: mailCfg.schoolDomains } : {}) });
  const localClassifier = mailCfg.localClassifier?.enabled
    ? createLmStudioClassifier({ enabled: true, fetch: fetchFn, ...(mailCfg.localClassifier.baseUrl ? { baseUrl: mailCfg.localClassifier.baseUrl } : {}), ...(mailCfg.localClassifier.model ? { model: mailCfg.localClassifier.model } : {}) })
    : undefined;
  const syncSources: SyncSource[] = [];
  const readers: string[] = [];
  const mailAccounts = cfg.accounts.filter((a) => (a.kind === 'gmail' || a.kind === 'outlook') && a.mode !== 'not_connected');
  for (const a of mailAccounts) {
    const provider = a.kind === 'gmail' ? 'google' : 'microsoft';
    if (provider === 'google' && !providerConfigs.google) continue;
    if (provider === 'microsoft' && !providerConfigs.microsoft) continue;
    const tokens = tokenProviderFor(a.id, provider, providerConfigs, { tokenStore, statusStore, fetch: fetchFn, clock });
    const common = { accountId: a.id, tokens, store: mailStore, clock, fetch: fetchFn, gate, ...(localClassifier ? { localClassifier } : {}) };
    const reader = a.kind === 'gmail'
      ? createGmailReader({ ...common, ...(mailCfg.fullSyncQuery ? { fullSyncQuery: mailCfg.fullSyncQuery } : {}), ...(mailCfg.maxFullSyncMessages ? { maxFullSyncMessages: mailCfg.maxFullSyncMessages } : {}) })
      : createOutlookReader({ ...common, statusStore, ...(mailCfg.initialWindowDays ? { initialWindowDays: mailCfg.initialWindowDays } : {}) });
    syncSources.push(mailSyncSource(reader, `${a.kind === 'gmail' ? 'Gmail' : 'Outlook'} (${a.label ?? a.id})`));
    readers.push(a.id);
  }
  if (conn.imessage?.readEnabled) {
    const a = accounts.get(conn.imessage.accountId);
    if (a?.kind === 'imessage' && a.mode !== 'not_connected' && gate(a.id, 'imessage').ok) {
      try { const snapshot = openReadOnly(DEFAULT_CHAT_DB, 'copy'); snapshot.cleanup(); readers.push(a.id); }
      catch (e) { problems.imessage = `Messages database unavailable at ${DEFAULT_CHAT_DB}: ${(e as Error).message}. Full Disk Access may be required for the Potts daemon executable (${process.execPath})`; }
    }
  }
  // A provider-side revocation discovered by a sync is made authoritative in the broker (only moves towards safety).
  const onSyncStatus = (sourceId: string, _r: SyncResult) => {
    const accountId = sourceId.replace(/\.(mail)$/, '');
    if (statusStore.get(accountId)?.status === 'revoked' && !broker.controls().revokedAccounts.includes(accountId))
      revocationSink.markRevoked(accountId, 'provider reported access revoked', 'system:connector');
  };

  // --- monitoring -------------------------------------------------------------------------------------------
  let monitor: SiteMonitor | null = null;
  try {
    const monCfg = normalizeMonitoringConfig(cfg.monitoring);
    if (monCfg.enabled) {
      monitor = createSiteMonitor({
        db, clock, config: monCfg, fetch: fetchFn, urgent, outbox, logger: log, timezone: tz,
        readiness: createTokenReadinessProbe({ fetch: fetchFn, clock, secretOptions: secretOpts }),
      });
    }
  } catch (e) {
    problems.monitoring = (e as Error).message;
  }

  // --- memory, drafts ---------------------------------------------------------------------------------------
  let memory: MemoryStore | null = null;
  {
    const r = openMemory({ db, clock, home, config: memoryConfigFrom(cfg), logger: log, fetchImpl: fetchFn as typeof fetch });
    if (r.ok) memory = late.memory = r.value;
    else problems.memory = r.error.message;
  }
  try {
    drafts = createDraftWorkspace({ home, db, clock });
  } catch (e) {
    problems.drafts = (e as Error).message;
  }

  // --- deadlines and briefings ------------------------------------------------------------------------------
  const priorityMail = mailAccounts.length ? mailPrioritySource(mailStore) : undefined;
  const deadlines = priorityMail ? createDeadlineWatcher({ db, clock, urgent, ...(priorityMail ? { mail: priorityMail } : {}) }) : undefined;
  const providers: BriefingProviders = {
    approvals: async () => broker.approvals.listPending().map((a) => {
      const act = broker.getAction(a.actionId);
      return { id: a.id, summary: act ? `${act.kind} → ${act.destination.join(', ').slice(0, 80)}` : a.actionId, expiresAt: a.expiresAt };
    }),
    progress: async (ctx) =>
      [...workerBriefingItems(home, ctx.sinceIso, 'progress'), ...(db.prepare("SELECT id, kind, destination_json FROM actions WHERE status = 'succeeded' AND updated_at >= ? ORDER BY updated_at LIMIT 20").all(ctx.sinceIso) as { id: string; kind: string; destination_json: string }[])
        .map((r) => ({ text: `${r.kind} → ${(JSON.parse(r.destination_json) as string[]).join(', ').slice(0, 80)} done`, ref: r.id }))],
    unfinished: async (ctx) =>
      [...workerBriefingItems(home, ctx.sinceIso, 'unfinished'), ...(db.prepare("SELECT id, kind, status FROM actions WHERE status IN ('uncertain','held','failed') ORDER BY updated_at DESC LIMIT 20").all() as { id: string; kind: string; status: string }[])
        .map((r) => ({ text: `${r.kind} is ${r.status}${r.status === 'uncertain' ? ' (being reconciled; never re-sent automatically)' : ''}`, ref: r.id }))],
    ...(priorityMail ? { messages: async (ctx) => priorityMail.listPriorityItems(ctx.sinceIso) } : {}),
  };
  const summarizer = summarizerFromConfig(cfg.notifications, fetchFn, log);
  const composer = createBriefingComposer({ db, clock, timezone: tz, providers, outbox, urgent, ...(monitor ? { monitor } : {}), ...(summarizer ? { summarizer } : {}), logger: log });

  // --- owner alert calls --------------------------------------------------------------------------------------
  let alerts: OwnerAlertService | null = null;
  if (telCfg?.enabled && executors.some((e) => e.startsWith('owner-alert-call'))) {
    alerts = late.alerts = createOwnerAlertService({ store: telephonyStore, decider, incidents: incidentValidator, clock, broker, policy: () => policyRef.current, accountId: telCfg.accountId });
    bindUrgentEventsToAlertCalls(urgent, alerts);
  }

  // --- release, delegation, support -------------------------------------------------------------------------
  const releaseManager = projects ? createReleaseManager({ db, broker, projects, clock }) : null;
  const releaseRequests = projects && releaseManager ? createReleaseRequests({ root: join(home, 'release-reviews'), projects, manager: releaseManager, clock, notifyFailure: (id, error) => { outbox.enqueue({ dedupKey: `release-review:${id}:failed`, category: 'reply', text: `Release preparation ${id} failed: ${error} Nothing was released.` }); }, paused: () => { const c=broker.controls(); return c.globalPaused || c.pausedIntegrations.includes('deploy'); } }) : undefined;
  if (projects && dcfg.claudeCode.enabled) {
    try {
      let runner = o.isolatedRunner ?? null;
      if (!runner) {
        const ded = createDedicatedUserRunner({
          audit: (r) => {
            try {
              audit.append({ type: 'isolation_run', actor: 'system:worker', data: { runner: r.runner, osUser: r.osUser, executable: r.executable, exitCode: r.exitCode, timedOut: r.timedOut, network: r.network, durationMs: r.durationMs, label: r.label ?? null } });
            } catch {
              /* never let audit failure break a run */
            }
          },
        });
        const av = await ded.available();
        if (!av.ok) throw new Error(`dedicated worker user unavailable: ${av.reason}`);
        runner = ded;
      }
      const governor = createDelegationGovernor({ db, clock, limits: dcfg.limits });
      delegationGovernor = governor;
      const claude = createClaudeCodeAdapter({ runner, config: { ...dcfg.claudeCode, ...(o.allowUnisolatedRunner ? { allowUnisolatedRunner: true } : {}) } });
      const tokenRef = dcfg.claudeCode.oauthTokenRef;
      delegation = createDelegationService({
        db, clock, broker, governor, projects, runner, claude, external: createExternalAdapter({ mode: dcfg.external.mode }),
        paidGuard: createPaidEscalationGuard({ broker, config: dcfg.paid }), evidenceRoot: join(home, 'evidence'), routing: dcfg.routing,
        ...(tokenRef ? { claudeOauthToken: async () => { const r = await resolve(tokenRef); return r.ok ? r.value : null; } } : {}),
      });
    } catch (e) {
      problems.delegation = (e as Error).message;
    }
  }
  let support: SupportEngine | null = null;
  const supCfg = cfg.support as { enabled?: boolean; knowledgeDir?: string } | undefined;
  if (supCfg?.enabled) {
    const reg = createSupportRegistry(cfg.support, accounts);
    if (!reg.ok) problems.support = reg.error.message;
    else {
      const kdir = join(home, supCfg.knowledgeDir ?? 'support-knowledge');
      let kbCache: ReturnType<typeof loadKnowledgeDir> | null = null;
      support = createSupportEngine({
        db, clock, registry: reg.value, policy: () => policyRef.current, broker,
        kb: () => {
          kbCache ??= loadKnowledgeDir(kdir);
          if (!kbCache.ok) throw new Error(kbCache.error.message);
          return kbCache.value;
        },
      });
    }
  }

  // --- scheduler (single authority for every recurring job) ---------------------------------------------------
  const scheduler = createScheduler({ db, clock, logger: log, ...(o.instanceId ? { instanceId: o.instanceId } : {}) });
  scheduler.recover({ assumeSoleOwner: true });
  const graceMin = (cfg.notifications as { briefingGraceMinutes?: number } | undefined)?.briefingGraceMinutes;
  const jobIds = registerStandardJobs(scheduler, {
    timezone: tz, briefings: cfg.briefings, composer, outbox, ...(monitor ? { monitor } : {}), ...(deadlines ? { deadlines } : {}), syncSources, onSyncStatus,
    ...(graceMin !== undefined ? { briefingGraceMs: graceMin * 60_000 } : {}),
  });
  const reg = (id: string, def: Omit<Parameters<Scheduler['register']>[0], 'id'>, h: Parameters<Scheduler['register']>[1]) => {
    scheduler.register({ id, ...def }, h);
    jobIds.push(id);
  };
  const reminders = createReminderStore(db, clock);
  reg('reminders:enqueue', { schedule: { type: 'interval', everyMs: 5_000 }, missed: { type: 'run_now' }, leaseMs: 60_000 }, async () => ({ detail: { queued: ownerId ? reminders.enqueueDue(outbox, { channel: ownerSource, target: ownerId }) : 0 } }));
  reg('approvals:notify', { schedule: { type: 'interval', everyMs: 15_000 }, missed: { type: 'run_now' }, leaseMs: 60_000 }, async () => ({ detail: { queued: approvalNotifier.scan() } }));
  if (dc.daemon.autoExecuteReady) {
    // Executes actions that are ready (owner-approved, or allowed by policy). Skips — without calling execute(),
    // so the audit log is not flooded — anything a control currently blocks or that has no executor, and backs
    // off 10 minutes after any other refusal. Every execute() still re-checks everything itself.
    const retryAfter = new Map<string, number>();
    reg('broker:dispatch-ready', { schedule: { type: 'interval', everyMs: 15_000 }, missed: { type: 'run_now' }, leaseMs: 10 * 60_000 }, async () => {
      const done: string[] = [];
      const now = clock.nowMs();
      for (const v of broker.list({ status: 'ready', limit: 50 })) {
        if (v.kind === 'call_owner_alert' || v.kind === 'prepare_fix') continue; // the alert service owns call attempts and their sequencing
        const ex = registry.forKind(v.kind);
        if (!ex) continue;
        const c = broker.controls();
        if (c.globalPaused) break;
        const a = broker.getAction(v.id);
        if (!a) continue;
        if ((a.accountId && c.revokedAccounts.includes(a.accountId)) || [a.integration, ex.integration].some((i) => i && c.pausedIntegrations.includes(i))) continue;
        if ((retryAfter.get(v.id) ?? 0) > now) continue;
        const r = v.kind === 'merge' || v.kind === 'deploy' ? (releaseManager ? await releaseManager.execute(v.id) : null) : await broker.execute(v.id);
        if (!r) continue;
        if (!r.ok) retryAfter.set(v.id, now + 10 * 60_000);
        else retryAfter.delete(v.id);
        done.push(`${v.id}:${r.ok ? r.value.status : r.error.code}`);
      }
      return { detail: { dispatched: done.length } };
    });
  }
  // Uncertain dispatches: ask the provider (lookup) with growing intervals (5 min doubling to 1 h); never re-send.
  const reconcileBackoff = new Map<string, { next: number; delay: number }>();
  reg('broker:reconcile', { schedule: { type: 'interval', everyMs: 5 * 60_000 }, missed: { type: 'run_now' }, leaseMs: 5 * 60_000 }, async () => {
    let n = 0;
    const now = clock.nowMs();
    for (const a of broker.list({ status: 'uncertain', limit: 50 })) {
      const b = reconcileBackoff.get(a.id);
      if (b && b.next > now) continue;
      const r = await broker.reconcile(a.id);
      if (r.ok && r.value.status !== 'still_uncertain') {
        n++;
        reconcileBackoff.delete(a.id);
      } else {
        const delay = Math.min((b?.delay ?? 2.5 * 60_000) * 2, 3600_000);
        reconcileBackoff.set(a.id, { next: now + delay, delay });
      }
    }
    return { detail: { resolved: n } };
  });
  if (delegation) {
    reg('delegation:dispatch-ready', { schedule: { type: 'interval', everyMs: 15000 }, missed: { type: 'run_now' }, leaseMs: (dcfg.claudeCode.timeoutSeconds + 900) * 1000 }, async () => {
      const action = broker.list({ status: 'ready', limit: 100 }).find(a => a.kind === 'prepare_fix');
      if (!action) return {};
      const r = await broker.execute(action.id);
      return { detail: { actionId: action.id, result: r.ok ? r.value.status : r.error.code } };
    });
  }

  if (memory) {
    const mem = memory;
    reg('memory:purge-expired', { schedule: { type: 'daily', time: '04:00', timezone: tz }, missed: { type: 'late_within', graceMs: 20 * 3600_000 } }, async () => ({ detail: { receipts: mem.purgeExpired(clock).length } }));
  }
  if (alerts) {
    const al = alerts;
    reg('alerts:owner-calls', { schedule: { type: 'interval', everyMs: 30_000 }, missed: { type: 'run_now' }, leaseMs: 2 * 60_000 }, async () => {
      const ev = await al.tick();
      return { detail: { events: ev.map((e) => `${e.incidentId}:${e.event}`) } };
    });
    if (telephonyProvider) {
      const tp = telephonyProvider;
      reg('telephony:usage', { schedule: { type: 'interval', everyMs: 3600_000 }, missed: { type: 'run_now' } }, async () => ({
        detail: { updated: await refreshCallUsage(telephonyStore, tp, new Date(clock.nowMs() - 7 * 86400_000).toISOString()) },
      }));
    }
  }
  // --- policy hot reload ---------------------------------------------------------------------------------------
  const policyReloader: PolicyReloader | null = dc.policyPath
    ? createPolicyReloader({
      path: dc.policyPath, db, broker, audit, clock, log, current: () => policyRef.current, set: (p) => (policyRef.current = p),
      expectedVersion: () => {
        // potts.json policy.version is re-read so a deliberate version bump in both files reloads without a restart.
        const raw = JSON.parse(readFileSync(dc.configPath, 'utf8')) as { policy?: { version?: unknown } };
        return typeof raw.policy?.version === 'string' ? raw.policy.version : cfg.policy.version;
      },
      notify: (n) => outbox.enqueue({ dedupKey: n.dedupKey, category: 'important', text: n.text }),
      ...(o.skipPolicyOwnershipCheck ? { skipOwnershipCheck: true } : {}),
    })
    : null;
  if (policyReloader && dc.daemon.policyWatch)
    reg('policy:watch', { schedule: { type: 'interval', everyMs: 15_000 }, missed: { type: 'run_now' } }, async () => ({ detail: { outcome: policyReloader.check('mtime').outcome } }));
  // --- owner chat auto-recovery (context overflow) -----------------------------------------------------------
  const ocHome = env.POTTS_OPENCLAW_HOME ?? join(homedir(), '.openclaw');
  const ocCli = join(ocHome, 'bin', 'openclaw');
  const gwLog = env.POTTS_OPENCLAW_GATEWAY_LOG ?? join(homedir(), 'Library', 'Logs', 'openclaw', 'gateway.log');
  if (ownerSource === 'telegram' && ownerId && env.POTTS_SESSION_GUARD !== 'off' && existsSync(ocCli) && existsSync(gwLog)) {
    // The owner's DM may be bound to the coordinator agent; follow openclaw.json on every tick.
    let ownerAgent = 'main';
    const sessionGuard = createSessionGuard({
      logPath: gwLog,
      owner: () => {
        try { ownerAgent = ownerAgentId(JSON.parse(readFileSync(join(ocHome, 'openclaw.json'), 'utf8')), ownerId); } catch { /* keep the last known agent */ }
        return { agentId: ownerAgent, sessionKey: `agent:${ownerAgent}:telegram:direct:${ownerId}`, agentDbPath: join(ocHome, 'agents', ownerAgent, 'agent', 'openclaw-agent.sqlite') };
      },
      clock, log: log.child({ component: 'session-guard' }),
      runCli: (args, timeoutMs) => new Promise((resolve) => {
        execFile(ocCli, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    });
    reg('openclaw:session-guard', { schedule: { type: 'interval', everyMs: 15_000 }, missed: { type: 'run_now' }, leaseMs: 600_000 }, async () => ({ detail: await sessionGuard.tick() }));
  }
  // --- daemon log rotation (launchd stdout/stderr files) ----------------------------------------------------
  const doRotate = () => rotateLogs(paths.logsDir, dc.daemon.logRotation);
  reg('logs:rotate', { schedule: { type: 'interval', everyMs: 10 * 60_000 }, missed: { type: 'run_now' } }, async () => {
    const r = doRotate();
    return { detail: { rotated: r.rotated.length, removed: r.removed.length } };
  });

  reg('audit:export-head', { schedule: { type: 'interval', everyMs: dc.daemon.auditHeadIntervalMinutes * 60_000 }, missed: { type: 'run_now' } }, async () => {
    exportAuditHead('periodic');
    return {};
  });
  if (dc.backup.enabled) {
    reg('backup:daily', { schedule: { type: 'daily', time: dc.backup.dailyTime, timezone: tz }, missed: { type: 'late_within', graceMs: 20 * 3600_000 }, maxAttempts: 2 }, async () => {
      const r = createBackup({ home, db, clock, audit, dir: dc.backup.absDir, keep: dc.backup.keep, configPath: dc.configPath, reason: 'scheduled' });
      if (!r.ok) throw new JobError(r.error.message);
      return { detail: { path: r.value.path, removed: r.value.removed.length } };
    });
  }

  // --- audit head journal (with controls snapshot) -----------------------------------------------------------
  let lastControlsHash = '';
  function exportAuditHead(kind: HeadKind): void {
    const h = audit.head();
    const controls = broker.controls().runtime;
    lastControlsHash = hashCanonical(controls);
    try {
      appendAuditHead(home, { at: clock.nowIso(), kind, seq: h.seq, hash: h.hash, controls });
    } catch (e) {
      log.warn('audit head export failed', { error: (e as Error).message });
    }
  }
  const controlsChanged = () => hashCanonical(broker.controls().runtime) !== lastControlsHash;

  audit.append({ type: 'daemon_lifecycle', actor: 'system:daemon', data: { event: 'start', pid: process.pid, executors, recoveredUncertain: recovered.uncertain, problems: Object.keys(problems) } });
  exportAuditHead('startup');
  if (recovered.uncertain.length) log.warn('dispatches left in flight by a crash are now uncertain (reconcile before any retry)', { actions: recovered.uncertain });

  const servers: RunningServer[] = [];
  let webhook: TelephonyWebhookServer | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let stopped = false;
  const sockets = { broker: false, ingress: false, read: false, memory: false };

  const runtime = (): RuntimeFacts => ({
    brokerSocket: sockets.broker, ingressSocket: sockets.ingress, readSocket: sockets.read, memoryControlSocket: sockets.memory,
    ingressKey: !!ingressKey, ownerId: !!ownerId, ownerChannel: pluginChannel ? 'plugin-socket' : 'none', executors, scheduler: !stopped,
    telephonyWebhook: !!webhook, googleClient: !!providerConfigs.google, readers, problems: { ...problems },
  });
  const capabilities = () => computeCapabilities({ config: cfg, policy: policyRef.current, projects, db, clock, controls: broker.controls(), runtime: runtime() });

  const daemon: Daemon = {
    home, paths, cfg: dc, db, clock, log, audit, broker, owner, scheduler, outbox, urgent, monitor, memory, drafts, mailStore, statusStore,
    telephonyStore, alerts, releaseManager, delegation, delegationGovernor, support, quiet, jobIds,
    runtime, capabilities,
    exportAuditHead,
    reloadPolicy(trigger = 'manual') {
      if (!policyReloader) return { outcome: 'rejected', trigger, reason: 'no policy file configured' };
      return policyReloader.check(trigger);
    },
    policy: () => policyRef.current,
    rotateLogs: () => doRotate(),
    purgeReceipts: () => listAccountPurgeReceipts(db),
    async start(so = {}) {
      servers.push(await startBrokerServer({ broker, socketPath: paths.brokerSocket, actor: 'openclaw', logger: log, releaseRequests }));
      sockets.broker = true;
      if (owner && ingressKey) {
        servers.push(await startIngressServer({ owner, socketPath: paths.ingressSocket, key: ingressKey, logger: log }));
        sockets.ingress = true;
      }
      if (dc.daemon.readSocket) {
        servers.push(await startReadServer(join(paths.runDir, 'read.sock'), { db, clock, memory, drafts, scheduler, capabilities, controls: () => broker.controls(), imessageSearch: p => {
          const reader = conn.imessage;
          const account = reader ? accounts.get(reader.accountId) : undefined;
          if (!reader?.readEnabled || !account || account.kind !== 'imessage' || account.mode === 'not_connected') return perr('not_found', 'iMessage read access not connected');
          const allowed = gate(account.id, 'imessage');
          if (!allowed.ok) return perr(allowed.code, allowed.reason);
          if (typeof p.query !== 'string' || !p.query.trim() || p.query.length > 300) return perr('invalid_input', 'search query required');
          try { return ok(searchMessages(DEFAULT_CHAT_DB, p.query, { limit: typeof p.limit === 'number' ? p.limit : 5, beforeRowid: typeof p.beforeRowid === 'number' ? p.beforeRowid : undefined })); }
          catch { return perr('not_found', `Messages database unavailable: the Potts daemon executable (${process.execPath}) may need Full Disk Access; do not ask the owner to run a generated SQL script`); }
        }, contentRead: contentReader({ home, clock, accounts: cfg.accounts, controls: () => broker.controls(), mail: mailStore, drafts }) }, log));
        sockets.read = true;
      }
      if (dc.daemon.memoryControlSocket && memory && ingressKey && ownerId) {
        servers.push(await startMemoryControlServer(join(paths.runDir, 'memory-control.sock'), { db, clock, audit, memory, key: ingressKey, ownerSenderId: ownerId, source: ownerSource }, log));
        sockets.memory = true;
      }
      if (telCfg?.enabled && alerts && (twilioSid || o.telephonyProvider)) {
        try {
          const tc = telCfg;
          const handler = createTwilioWebhookHandler({
            store: telephonyStore, clock, accountSid: twilioSid ?? 'AC' + '0'.repeat(32), publicBaseUrl: tc.publicBaseUrl,
            authToken: async () => {
              const r = await resolve(tc.twilio.authTokenRef);
              if (!r.ok) throw new Error('Twilio auth token unavailable');
              return r.value;
            },
            onAcknowledged: (incidentId) => {
              urgent.acknowledge(incidentId, 'owner:phone');
            },
          });
          webhook = await startTelephonyWebhookServer({
            handler: req => voice && (VOICE_PATHS as readonly string[]).includes(req.url.split('?')[0]!) ? voice.handle(req) : handler(req),
            host: tc.webhook.host, port: tc.webhook.port, extraPaths: voice ? VOICE_PATHS : [],
          });
          if (voice) closeVoice = voice.attach(webhook.server);
        } catch (e) {
          problems.telephony = `webhook: ${(e as Error).message}`;
        }
      }
      if (so.timers !== false) {
        scheduler.start({ pollMs: dc.daemon.tickMs });
        timers.push(setInterval(() => {
          if (controlsChanged()) exportAuditHead('controls');
        }, dc.daemon.tickMs));
      }
      log.info('potts daemon started', { home, executors, sockets, problems });
    },
    async tick() {
      await scheduler.tick();
      if (controlsChanged()) exportAuditHead('controls');
    },
    async stop(reason = 'stop') {
      if (stopped) return;
      stopped = true;
      for (const t of timers) clearInterval(t);
      timers = [];
      await scheduler.stop();
      try {
        scheduler.recover({ assumeSoleOwner: true }); // release any lease still held by this process
      } catch {
        /* best effort */
      }
      for (const s of servers.splice(0)) await s.close().catch(() => {});
      closeVoice?.();
      if (webhook) await webhook.close().catch(() => {});
      try {
        audit.append({ type: 'daemon_lifecycle', actor: 'system:daemon', data: { event: 'stop', reason } });
        exportAuditHead('shutdown');
      } catch {
        /* DB may already be unusable */
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      lock.value.release();
      log.info('potts daemon stopped', { reason });
    },
  };
  return ok(daemon);
}
