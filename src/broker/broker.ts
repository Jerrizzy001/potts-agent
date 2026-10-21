import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import { createAuditLedger, type AuditLedger } from '../audit/ledger.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { canonicalJson, hashCanonical } from '../core/hash.ts';
import { ok, perr, PottsError, type ErrorCode, type Result } from '../core/result.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import type { AccountRegistry } from '../core/config.ts';
import { decide, type ActionScope, type ControlState, type Decision, type DecisionOutcome, type PolicyHooks } from '../policy/decide.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import { normalizeActionInput, type AttachmentRef, type NormalizedAction } from '../policy/action.ts';
import { isActionKind, type ActionKind } from '../policy/catalog.ts';
import { createApprovalStore, type ApprovalRecord, type ApprovalStore } from '../approvals/store.ts';
import type { VerifiedOwnerIngress } from '../approvals/ingress.ts';
import { ExecutorRejectedError, type DispatchIntent, type ExecutorReceipt, type ExecutorRegistry } from './executor.ts';

export type ActionStatus = 'held' | 'denied' | 'awaiting_approval' | 'ready' | 'dispatching' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
export type DispatchState = 'dispatching' | 'succeeded' | 'failed' | 'uncertain' | 'reconciled_sent' | 'reconciled_not_sent';

export interface StoredAction {
  id: string;
  kind: string;
  actor: string;
  accountId: string | null;
  integration: string | null;
  destination: string[];
  payload: unknown;
  payloadHash: string;
  attachments: AttachmentRef[];
  scope: ActionScope | null;
  summary: string | null;
  revision: number;
  status: ActionStatus;
  decision: DecisionOutcome;
  decisionReasons: string[];
  policyVersion: string;
  policyHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchRecord {
  id: string;
  actionId: string;
  attempt: number;
  state: DispatchState;
  approvalId: string | null;
  executor: string;
  providerOperationId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe summary returned to proposers (no payload body). */
export interface ActionStatusView {
  id: string;
  kind: string;
  accountId: string | null;
  destination: string[];
  payloadHash: string;
  attachments: AttachmentRef[];
  status: ActionStatus;
  decision: DecisionOutcome;
  reasons: string[];
  revision: number;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  approval: { id: string; status: string; expiresAt: string; bindingHash: string } | null;
  lastDispatch: { id: string; attempt: number; state: DispatchState; providerOperationId: string | null } | null;
}

export interface ProposeOutcome {
  executorAvailable?: boolean;
  actionId: string;
  status: ActionStatus;
  decision: DecisionOutcome;
  reasons: string[];
  approvalId: string | null;
  bindingHash: string | null;
}

export type ExecuteOutcome =
  | { status: 'succeeded'; actionId: string; dispatchId: string; providerOperationId: string; alreadyDone?: boolean }
  | { status: 'uncertain'; actionId: string; dispatchId: string; reason: string }
  | { status: 'failed'; actionId: string; dispatchId: string; reason: string };

export type ReconcileOutcome =
  | { status: 'sent'; actionId: string; dispatchId: string; providerOperationId: string }
  | { status: 'not_sent'; actionId: string; dispatchId: string }
  | { status: 'still_uncertain'; actionId: string; dispatchId: string; reason: string };

export interface ControlSnapshot {
  globalPaused: boolean;
  pausedIntegrations: string[];
  revokedAccounts: string[];
  /** Rows set at runtime by the owner/system (static config flags are not listed here). */
  runtime: { scope: string; state: 'paused' | 'revoked'; reason: string | null; setBy: string; setAt: string }[];
}

export interface BrokerOptions {
  db: Db;
  clock?: Clock;
  audit?: AuditLedger;
  /** Returns the current owner policy (may be reloaded by trusted code). */
  policy: () => LoadedPolicy;
  accounts: AccountRegistry;
  executors: ExecutorRegistry;
  /** Static pause flags from config.integrations. Owner cannot "resume" these at runtime. */
  staticControls?: { pauseAll: boolean; paused?: Record<string, boolean> };
  hooks?: PolicyHooks;
  executorTimeoutMs?: number;
  logger?: Logger;
  /** TEST ONLY: called after the provider accepted, before the receipt is persisted. Throw to simulate a crash. */
  testHooks?: { afterProviderAccept?: (dispatchId: string) => void };
}

export interface ListOptions {
  status?: ActionStatus;
  limit?: number;
}

/**
 * The broker is the only execution boundary. Construct exactly one per
 * process (it is the sole writer of actions/approvals/dispatches).
 */
export interface Broker {
  readonly audit: AuditLedger;
  readonly approvals: ApprovalStore;
  /** Records and classifies a proposed action. Never executes. */
  propose(input: unknown, actor: string): Result<ProposeOutcome>;
  /** Replaces the content of a not-yet-dispatched action (new revision); invalidates approvals. */
  revise(actionId: string, input: unknown, actor: string): Result<ProposeOutcome>;
  /** Rechecks controls, policy and approval, persists intent, then dispatches once. */
  execute(actionId: string): Promise<Result<ExecuteOutcome>>;
  /** Resolves an uncertain dispatch via the executor's lookup(). */
  reconcile(actionId: string): Promise<Result<ReconcileOutcome>>;
  /** Call at startup: dispatches left 'dispatching' by a crash become 'uncertain'. */
  recover(): { uncertain: string[] };
  status(actionId: string): ActionStatusView | undefined;
  list(opts?: ListOptions): ActionStatusView[];
  getAction(actionId: string): StoredAction | undefined;
  dispatches(actionId: string): DispatchRecord[];
  controls(): ControlSnapshot;
  /** Fail-safe pause usable by trusted system code without owner proof (e.g. daemon emergency). */
  emergencyPause(reason: string, actor: string): void;
  /**
   * System cancel (trusted daemon/release code, no owner proof). Only moves
   * towards safety: it cancels an action that has not been dispatched and
   * invalidates its live approval. It can never approve, resume or reinstate.
   * The audit actor is always `system:<actor>`.
   */
  cancelAction(actionId: string, reason: string, actor: string): Result<ActionStatusView>;
  /**
   * System revocation (e.g. a provider reported the grant revoked): marks
   * `account:<id>` revoked and invalidates every live approval for it, in one
   * transaction. Reinstatement remains owner-only (owner `reinstate_account`).
   */
  revokeAccountFromSystem(accountId: string, reason: string, actor: string): void;
  /** @internal used by owner controls; requires a verified owner ingress. */
  _proposeDirect(input: unknown, by: VerifiedOwnerIngress): Result<ProposeOutcome>;
  /** @internal owner controls only (src/broker/owner.ts); system code uses emergencyPause / revokeAccountFromSystem. */
  _setControl(scope: string, state: 'paused' | 'revoked' | null, actor: string, reason: string | null): void;
  /** @internal owner controls only (src/broker/owner.ts); system code uses cancelAction. */
  _cancelAction(actionId: string, actor: string, reason: string): Result<ActionStatusView>;
  /** The policy currently in force. */
  currentPolicy(): LoadedPolicy;
  readonly db: Db;
  readonly clock: Clock;
}

type ActionRow = {
  id: string; kind: string; actor: string; account_id: string | null; integration: string | null; destination_json: string; payload_json: string;
  payload_hash: string; attachments_json: string; scope_json: string | null; summary: string | null; revision: number; status: string; decision: string;
  decision_reasons_json: string; policy_version: string; policy_hash: string; created_at: string; updated_at: string;
};
type DispatchRow = {
  id: string; action_id: string; attempt: number; state: string; approval_id: string | null; executor: string; intent_json: string;
  intent_hash: string; provider_operation_id: string | null; error: string | null; created_at: string; updated_at: string;
};

const toAction = (r: ActionRow): StoredAction => ({
  id: r.id, kind: r.kind, actor: r.actor, accountId: r.account_id, integration: r.integration, destination: JSON.parse(r.destination_json) as string[],
  payload: JSON.parse(r.payload_json) as unknown, payloadHash: r.payload_hash, attachments: JSON.parse(r.attachments_json) as AttachmentRef[],
  scope: r.scope_json ? (JSON.parse(r.scope_json) as ActionScope) : null, summary: r.summary, revision: r.revision, status: r.status as ActionStatus,
  decision: r.decision as DecisionOutcome, decisionReasons: JSON.parse(r.decision_reasons_json) as string[], policyVersion: r.policy_version,
  policyHash: r.policy_hash, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toDispatch = (r: DispatchRow): DispatchRecord => ({
  id: r.id, actionId: r.action_id, attempt: r.attempt, state: r.state as DispatchState, approvalId: r.approval_id, executor: r.executor,
  providerOperationId: r.provider_operation_id, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

const DEFAULT_TIMEOUT_MS = 30_000;

export function createBroker(opts: BrokerOptions): Broker {
  const { db, accounts, executors } = opts;
  const clock = opts.clock ?? systemClock;
  const audit = opts.audit ?? createAuditLedger(db, clock);
  const approvals = createApprovalStore(db, audit, clock);
  const log = opts.logger ?? nullLogger;
  executors.freeze();

  const getRow = (id: string) => db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
  const getAction = (id: string) => {
    const r = getRow(id);
    return r ? toAction(r) : undefined;
  };
  const lastDispatch = (actionId: string) => {
    const r = db.prepare('SELECT * FROM dispatches WHERE action_id = ? ORDER BY attempt DESC LIMIT 1').get(actionId) as DispatchRow | undefined;
    return r ? toDispatch(r) : undefined;
  };
  const setStatus = (id: string, status: ActionStatus) => db.prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?').run(status, clock.nowIso(), id);
  const setDispatch = (id: string, state: DispatchState, fields: { providerOperationId?: string; error?: string } = {}) =>
    db.prepare('UPDATE dispatches SET state = ?, provider_operation_id = COALESCE(?, provider_operation_id), error = ?, updated_at = ? WHERE id = ?').run(
      state, fields.providerOperationId ?? null, fields.error ?? null, clock.nowIso(), id,
    );

  const controlState = (): ControlState & { rows: ControlSnapshot['runtime'] } => {
    const rows = (db.prepare('SELECT scope, state, reason, set_by, set_at FROM controls ORDER BY scope').all() as { scope: string; state: 'paused' | 'revoked'; reason: string | null; set_by: string; set_at: string }[]).map(
      (r) => ({ scope: r.scope, state: r.state, reason: r.reason, setBy: r.set_by, setAt: r.set_at }),
    );
    const paused = new Set<string>(Object.entries(opts.staticControls?.paused ?? {}).filter(([, v]) => v).map(([k]) => k));
    const revoked = new Set<string>();
    let globalPaused = opts.staticControls?.pauseAll === true;
    for (const r of rows) {
      if (r.scope === 'global' && r.state === 'paused') globalPaused = true;
      else if (r.scope.startsWith('integration:') && r.state === 'paused') paused.add(r.scope.slice('integration:'.length));
      else if (r.scope.startsWith('account:') && r.state === 'revoked') revoked.add(r.scope.slice('account:'.length));
    }
    return { globalPaused, pausedIntegrations: paused, revokedAccounts: revoked, rows };
  };

  const integrationFor = (kind: string, accountId: string | null): string | null =>
    (accountId ? accounts.get(accountId)?.kind : undefined) ?? executors.forKind(kind)?.integration ?? null;

  const decideFor = (a: Pick<StoredAction, 'kind' | 'actor' | 'accountId' | 'integration' | 'destination' | 'payload' | 'scope'>, policy: LoadedPolicy): Decision =>
    decide(
      { kind: a.kind, actor: a.actor, accountId: a.accountId, integration: a.integration, destination: a.destination, payload: a.payload, scope: a.scope },
      { policy, account: a.accountId ? accounts.get(a.accountId) : undefined, controls: controlState(), ...(opts.hooks ? { hooks: opts.hooks } : {}) },
    );

  const statusFromDecision = (d: DecisionOutcome): ActionStatus =>
    d === 'allow' ? 'ready' : d === 'require_approval' ? 'awaiting_approval' : d === 'hold' ? 'held' : 'denied';

  const view = (a: StoredAction): ActionStatusView => {
    const apr = approvals.live(a.id) ?? (db.prepare('SELECT id FROM approvals WHERE action_id = ? ORDER BY created_at DESC LIMIT 1').get(a.id) as { id: string } | undefined);
    const aprRec = apr ? approvals.get(apr.id) : undefined;
    const d = lastDispatch(a.id);
    return {
      id: a.id, kind: a.kind, accountId: a.accountId, destination: a.destination, payloadHash: a.payloadHash, attachments: a.attachments,
      status: a.status, decision: a.decision, reasons: a.decisionReasons, revision: a.revision, policyVersion: a.policyVersion,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
      approval: aprRec ? { id: aprRec.id, status: aprRec.status, expiresAt: aprRec.expiresAt, bindingHash: aprRec.bindingHash } : null,
      lastDispatch: d ? { id: d.id, attempt: d.attempt, state: d.state, providerOperationId: d.providerOperationId } : null,
    };
  };

  const outcomeOf = (a: StoredAction, apr: ApprovalRecord | undefined): ProposeOutcome => ({
    executorAvailable: !!executors.forKind(a.kind), actionId: a.id, status: a.status, decision: a.decision, reasons: a.decisionReasons, approvalId: apr?.id ?? null, bindingHash: apr?.bindingHash ?? null,
  });

  const proposeInternal = (input: unknown, actor: string, direct?: VerifiedOwnerIngress): Result<ProposeOutcome> => {
    if (typeof actor !== 'string' || !actor || actor.length > 200) return perr('invalid_input', 'actor required');
    const n = normalizeActionInput(input);
    if (!n.ok) return n;
    const policy = opts.policy();
    return withTransaction(db, () => {
      const id = newId('act', clock);
      const integration = integrationFor(n.value.kind, n.value.accountId);
      const a0 = { kind: n.value.kind, actor, accountId: n.value.accountId, integration, destination: n.value.destination, payload: n.value.payload, scope: n.value.scope };
      const d = decideFor(a0, policy);
      const now = clock.nowIso();
      db.prepare(
        `INSERT INTO actions (id, kind, actor, account_id, integration, destination_json, payload_json, payload_hash, attachments_json, scope_json, summary, revision,
          status, decision, decision_reasons_json, policy_version, policy_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`,
      ).run(id, n.value.kind, actor, n.value.accountId, integration, canonicalJson(n.value.destination), canonicalJson(n.value.payload), n.value.payloadHash,
        canonicalJson(n.value.attachments), n.value.scope ? canonicalJson(n.value.scope) : null, n.value.summary, statusFromDecision(d.outcome), d.outcome,
        canonicalJson(d.reasons), d.policyVersion, d.policyHash, now, now);
      audit.append({ type: 'action_proposed', actor, actionId: id, data: summaryData(n.value, integration) });
      audit.append({ type: 'policy_decision', actor: 'policy', actionId: id, data: { outcome: d.outcome, reasons: d.reasons, kindClass: d.kindClass, policyVersion: d.policyVersion, policyHash: d.policyHash } });
      const a = getAction(id)!;
      let apr: ApprovalRecord | undefined;
      if (d.outcome === 'require_approval') {
        if (direct) {
          apr = approvals.createDirect(a, policy, direct);
          setStatus(id, 'ready');
        } else {
          apr = approvals.request(a, policy);
        }
      }
      return ok(outcomeOf(getAction(id)!, apr));
    });
  };

  const fail = <T>(actionId: string, code: ErrorCode, message: string, details?: Record<string, unknown>): Result<T> => {
    audit.append({ type: 'execute_rejected', actor: 'broker', actionId, data: { code, message } });
    return { ok: false, error: new PottsError(code, message, details) };
  };

  type Prepared = { intent: DispatchIntent; timeoutMs: number; approvalId: string | null };

  /** Synchronous, transactional pre-dispatch check + intent persistence. */
  const prepare = (actionId: string): Result<Prepared | ExecuteOutcome> =>
    withTransaction(db, (): Result<Prepared | ExecuteOutcome> => {
      const a = getAction(actionId);
      if (!a) return perr('not_found', 'action not found');
      const last = lastDispatch(actionId);
      switch (a.status) {
        case 'succeeded':
          return ok({ status: 'succeeded', actionId, dispatchId: last!.id, providerOperationId: last!.providerOperationId ?? '', alreadyDone: true });
        case 'dispatching':
          return fail(actionId, 'in_flight', 'a dispatch is in flight or was interrupted; run recover()/reconcile()');
        case 'uncertain':
          return fail(actionId, 'uncertain_requires_reconcile', 'previous dispatch outcome is uncertain; reconcile before any retry');
        case 'cancelled':
        case 'denied':
          return fail(actionId, 'action_state', `action is ${a.status}`);
        default:
          break;
      }
      if (last && (last.state === 'dispatching' || last.state === 'uncertain'))
        return fail(actionId, 'uncertain_requires_reconcile', 'previous dispatch outcome is uncertain');
      // Integrity: stored payload must still match its hash.
      if (hashCanonical(a.payload) !== a.payloadHash) {
        setStatus(actionId, 'denied');
        approvals.invalidateLive(actionId, 'stored payload does not match its hash', 'broker');
        return fail(actionId, 'denied', 'stored payload was modified outside the broker');
      }
      // Owner controls first, with explicit error codes.
      const c = controlState();
      const executor = isActionKind(a.kind) ? executors.forKind(a.kind) : undefined;
      if (a.accountId && c.revokedAccounts.has(a.accountId)) return fail(actionId, 'revoked', `account ${a.accountId} is revoked`);
      if (c.globalPaused) return fail(actionId, 'paused', 'all actions are paused');
      for (const integ of [a.integration, executor?.integration]) {
        if (integ && c.pausedIntegrations.has(integ)) return fail(actionId, 'paused', `integration ${integ} is paused`);
      }
      // Re-decide under the CURRENT policy.
      const policy = opts.policy();
      const d = decideFor(a, policy);
      db.prepare('UPDATE actions SET decision = ?, decision_reasons_json = ?, policy_version = ?, policy_hash = ?, updated_at = ? WHERE id = ?').run(
        d.outcome, canonicalJson(d.reasons), d.policyVersion, d.policyHash, clock.nowIso(), actionId,
      );
      if (d.outcome !== a.decision || d.policyHash !== a.policyHash)
        audit.append({ type: 'policy_decision', actor: 'policy', actionId, data: { outcome: d.outcome, reasons: d.reasons, recheck: true, policyVersion: d.policyVersion, policyHash: d.policyHash } });
      if (d.outcome === 'deny') {
        setStatus(actionId, 'denied');
        approvals.invalidateLive(actionId, 'policy denied at execution', 'broker');
        return fail(actionId, 'denied', d.reasons.join('; '));
      }
      if (d.outcome === 'hold') {
        setStatus(actionId, 'held');
        return fail(actionId, 'held', d.reasons.join('; '));
      }
      let approvalId: string | null = null;
      if (d.outcome === 'require_approval') {
        const chk = approvals.checkForExecution(a, policy);
        if (!chk.ok) {
          if (!approvals.live(actionId) && chk.error.code !== 'approval_used') approvals.request(a, policy);
          setStatus(actionId, chk.error.code === 'approval_used' ? a.status : 'awaiting_approval');
          return fail(actionId, chk.error.code, chk.error.message, chk.error.details);
        }
        approvalId = chk.value.id;
      }
      if (!executor) return fail(actionId, 'no_executor', `no executor registered for ${a.kind}`);
      const attempt = (last?.attempt ?? 0) + 1;
      const dispatchId = newId('dsp', clock);
      const account = a.accountId ? accounts.get(a.accountId) : undefined;
      const intent: DispatchIntent = {
        dispatchId, actionId, attempt, kind: a.kind as ActionKind, accountId: a.accountId, accountAddress: account?.address ?? null,
        destination: a.destination, payload: a.payload, payloadHash: a.payloadHash, attachments: a.attachments,
        idempotencyKey: `potts-${actionId}`, createdAt: clock.nowIso(),
      };
      const now = clock.nowIso();
      db.prepare(
        `INSERT INTO dispatches (id, action_id, attempt, state, approval_id, executor, intent_json, intent_hash, created_at, updated_at)
         VALUES (?,?,?,'dispatching',?,?,?,?,?,?)`,
      ).run(dispatchId, actionId, attempt, approvalId, executor.name, canonicalJson(intent), hashCanonical(intent), now, now);
      if (approvalId && !approvals.consume(approvalId, dispatchId)) throw new PottsError('approval_used', 'approval consumed concurrently');
      setStatus(actionId, 'dispatching');
      audit.append({ type: 'dispatch_intent', actor: 'broker', actionId, data: { dispatchId, attempt, executor: executor.name, approvalId, intentHash: hashCanonical(intent) } });
      return ok({ intent, timeoutMs: executor.timeoutMs ?? opts.executorTimeoutMs ?? DEFAULT_TIMEOUT_MS, approvalId });
    });

  const markUncertain = (intent: DispatchIntent, reason: string) =>
    withTransaction(db, () => {
      setDispatch(intent.dispatchId, 'uncertain', { error: reason });
      setStatus(intent.actionId, 'uncertain');
      audit.append({ type: 'dispatch_uncertain', actor: 'broker', actionId: intent.actionId, data: { dispatchId: intent.dispatchId, reason } });
    });

  const broker: Broker = {
    db,
    clock,
    audit,
    approvals,
    currentPolicy: () => opts.policy(),
    propose: (input, actor) => proposeInternal(input, actor),
    _proposeDirect: (input, by) => proposeInternal(input, by.actor, by),

    revise(actionId, input, actor) {
      const n = normalizeActionInput(input);
      if (!n.ok) return n;
      const policy = opts.policy();
      return withTransaction(db, () => {
        const a = getAction(actionId);
        if (!a) return perr('not_found', 'action not found');
        if (!['held', 'awaiting_approval', 'ready', 'failed'].includes(a.status)) return perr('action_state', `cannot revise an action that is ${a.status}`);
        if (n.value.kind !== a.kind) return perr('invalid_input', 'revision cannot change the action kind; propose a new action');
        approvals.invalidateLive(actionId, 'action revised', actor);
        const integration = integrationFor(n.value.kind, n.value.accountId);
        const d = decideFor({ kind: a.kind, actor: a.actor, accountId: n.value.accountId, integration, destination: n.value.destination, payload: n.value.payload, scope: n.value.scope }, policy);
        db.prepare(
          `UPDATE actions SET account_id = ?, integration = ?, destination_json = ?, payload_json = ?, payload_hash = ?, attachments_json = ?, scope_json = ?, summary = ?,
            revision = revision + 1, status = ?, decision = ?, decision_reasons_json = ?, policy_version = ?, policy_hash = ?, updated_at = ? WHERE id = ?`,
        ).run(n.value.accountId, integration, canonicalJson(n.value.destination), canonicalJson(n.value.payload), n.value.payloadHash,
          canonicalJson(n.value.attachments), n.value.scope ? canonicalJson(n.value.scope) : null, n.value.summary, statusFromDecision(d.outcome), d.outcome,
          canonicalJson(d.reasons), d.policyVersion, d.policyHash, clock.nowIso(), actionId);
        audit.append({ type: 'action_revised', actor, actionId, data: { ...summaryData(n.value, integration), revision: a.revision + 1 } });
        audit.append({ type: 'policy_decision', actor: 'policy', actionId, data: { outcome: d.outcome, reasons: d.reasons, kindClass: d.kindClass, policyVersion: d.policyVersion } });
        const updated = getAction(actionId)!;
        const apr = d.outcome === 'require_approval' ? approvals.request(updated, policy) : undefined;
        return ok(outcomeOf(updated, apr));
      });
    },

    async execute(actionId) {
      let prep: Result<Prepared | ExecuteOutcome>;
      try {
        prep = prepare(actionId);
      } catch (e) {
        return { ok: false, error: e instanceof PottsError ? e : new PottsError('internal', (e as Error).message) };
      }
      if (!prep.ok) return prep;
      if ('status' in prep.value) return ok(prep.value);
      const { intent, timeoutMs } = prep.value;
      const executor = executors.forKind(intent.kind)!;
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      // An executor that throws synchronously or returns a non-promise must not
      // escape: the intent is already persisted as 'dispatching'. A synchronous
      // ExecutorRejectedError is a definitive rejection; anything else is uncertain.
      let call: Promise<ExecutorReceipt>;
      try {
        call = Promise.resolve(executor.execute(Object.freeze(structuredClone(intent)), ac.signal) as unknown as ExecutorReceipt).then(validReceipt);
      } catch (e) {
        call = Promise.reject(e);
      }
      call.catch(() => {});
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
          reject(new Error(`executor timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      let receipt;
      try {
        receipt = await Promise.race([call, timeout]);
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ExecutorRejectedError && !timedOut) {
          withTransaction(db, () => {
            setDispatch(intent.dispatchId, 'failed', { error: e.message });
            setStatus(actionId, 'failed');
            if (prep.ok && !('status' in prep.value) && prep.value.approvalId) approvals.release(prep.value.approvalId, 'provider definitively rejected; nothing sent');
            audit.append({ type: 'dispatch_failed', actor: 'broker', actionId, data: { dispatchId: intent.dispatchId, reason: e.message } });
          });
          return ok({ status: 'failed', actionId, dispatchId: intent.dispatchId, reason: e.message });
        }
        const reason = (e as Error).message;
        markUncertain(intent, reason);
        if (timedOut) {
          // A late answer is recorded (never re-sent) if the dispatch is still uncertain.
          call.then(
            (late) => {
              try {
                withTransaction(db, () => {
                  const d = lastDispatch(actionId);
                  if (d?.id !== intent.dispatchId || d.state !== 'uncertain') return;
                  setDispatch(intent.dispatchId, 'reconciled_sent', { providerOperationId: late.providerOperationId });
                  setStatus(actionId, 'succeeded');
                  audit.append({ type: 'reconciliation', actor: 'broker', actionId, data: { dispatchId: intent.dispatchId, result: 'late_receipt', providerOperationId: late.providerOperationId } });
                });
              } catch (err2) {
                log.warn('late receipt not recorded', { actionId, error: (err2 as Error).message });
              }
            },
            () => {},
          );
        }
        log.warn('dispatch uncertain', { actionId, dispatchId: intent.dispatchId, reason });
        return ok({ status: 'uncertain', actionId, dispatchId: intent.dispatchId, reason });
      }
      clearTimeout(timer);
      // Crash window under test: provider accepted, receipt not yet persisted.
      opts.testHooks?.afterProviderAccept?.(intent.dispatchId);
      withTransaction(db, () => {
        setDispatch(intent.dispatchId, 'succeeded', { providerOperationId: receipt.providerOperationId });
        setStatus(actionId, 'succeeded');
        audit.append({ type: 'dispatch_receipt', actor: 'broker', actionId, data: { dispatchId: intent.dispatchId, providerOperationId: receipt.providerOperationId, detail: receipt.detail ?? {} } });
      });
      return ok({ status: 'succeeded', actionId, dispatchId: intent.dispatchId, providerOperationId: receipt.providerOperationId });
    },

    async reconcile(actionId) {
      const a = getAction(actionId);
      if (!a) return perr('not_found', 'action not found');
      const d0 = lastDispatch(actionId);
      if (!d0 || d0.state !== 'uncertain') return perr('action_state', `nothing to reconcile (latest dispatch ${d0?.state ?? 'none'}); run recover() first if the broker crashed`);
      const row = db.prepare('SELECT intent_json FROM dispatches WHERE id = ?').get(d0.id) as { intent_json: string };
      const intent = JSON.parse(row.intent_json) as DispatchIntent;
      const executor = executors.forKind(intent.kind);
      if (!executor) return perr('no_executor', `no executor for ${intent.kind}`);
      let res;
      try {
        res = await executor.lookup(Object.freeze(intent));
      } catch (e) {
        res = { status: 'unknown' as const, reason: (e as Error).message };
      }
      return withTransaction(db, (): Result<ReconcileOutcome> => {
        const d = lastDispatch(actionId)!;
        if (d.id !== d0.id || d.state !== 'uncertain') return perr('action_state', 'dispatch changed during reconciliation');
        if (res.status === 'found') {
          setDispatch(d.id, 'reconciled_sent', { providerOperationId: res.providerOperationId });
          setStatus(actionId, 'succeeded');
          audit.append({ type: 'reconciliation', actor: 'broker', actionId, data: { dispatchId: d.id, result: 'sent', providerOperationId: res.providerOperationId } });
          return ok({ status: 'sent', actionId, dispatchId: d.id, providerOperationId: res.providerOperationId });
        }
        if (res.status === 'not_found') {
          setDispatch(d.id, 'reconciled_not_sent');
          if (d.approvalId) approvals.release(d.approvalId, 'reconciliation confirmed the provider never accepted the dispatch');
          setStatus(actionId, 'ready');
          audit.append({ type: 'reconciliation', actor: 'broker', actionId, data: { dispatchId: d.id, result: 'not_sent' } });
          return ok({ status: 'not_sent', actionId, dispatchId: d.id });
        }
        audit.append({ type: 'reconciliation', actor: 'broker', actionId, data: { dispatchId: d.id, result: 'unknown', reason: res.reason ?? '' } });
        return ok({ status: 'still_uncertain', actionId, dispatchId: d.id, reason: res.reason ?? 'provider could not confirm' });
      });
    },

    recover() {
      return withTransaction(db, () => {
        const rows = db.prepare("SELECT * FROM dispatches WHERE state = 'dispatching'").all() as DispatchRow[];
        for (const r of rows) {
          setDispatch(r.id, 'uncertain', { error: 'broker restarted while dispatch was in flight' });
          setStatus(r.action_id, 'uncertain');
          audit.append({ type: 'recovery', actor: 'broker', actionId: r.action_id, data: { dispatchId: r.id, result: 'marked_uncertain' } });
        }
        return { uncertain: rows.map((r) => r.action_id) };
      });
    },

    status(actionId) {
      const a = getAction(actionId);
      return a ? view(a) : undefined;
    },
    list(o = {}) {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
      const rows = o.status
        ? (db.prepare('SELECT * FROM actions WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(o.status, limit) as ActionRow[])
        : (db.prepare('SELECT * FROM actions ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit) as ActionRow[]);
      return rows.map((r) => view(toAction(r)));
    },
    getAction,
    dispatches: (actionId) => (db.prepare('SELECT * FROM dispatches WHERE action_id = ? ORDER BY attempt').all(actionId) as DispatchRow[]).map(toDispatch),
    controls() {
      const c = controlState();
      return { globalPaused: c.globalPaused, pausedIntegrations: [...c.pausedIntegrations].sort(), revokedAccounts: [...c.revokedAccounts].sort(), runtime: c.rows };
    },
    emergencyPause(reason, actor) {
      withTransaction(db, () => broker._setControl('global', 'paused', `system:${actor}`, reason));
    },
    cancelAction(actionId, reason, actor) {
      const who = actor.startsWith('system:') ? actor : `system:${actor}`;
      return withTransaction(db, () => broker._cancelAction(actionId, who, reason));
    },
    revokeAccountFromSystem(accountId, reason, actor) {
      if (typeof accountId !== 'string' || !accountId) throw new PottsError('invalid_input', 'accountId required');
      const who = actor.startsWith('system:') ? actor : `system:${actor}`;
      withTransaction(db, () => {
        broker._setControl(`account:${accountId}`, 'revoked', who, reason);
        approvals.invalidateForAccount(accountId, reason, who);
      });
    },
    _setControl(scope, state, actor, reason) {
      if (state === null) {
        const prev = db.prepare('SELECT state FROM controls WHERE scope = ?').get(scope) as { state: string } | undefined;
        db.prepare('DELETE FROM controls WHERE scope = ?').run(scope);
        if (prev) audit.append({ type: prev.state === 'revoked' ? 'reinstatement' : 'resume', actor, data: { scope } });
        return;
      }
      db.prepare(
        'INSERT INTO controls (scope, state, reason, set_by, set_at) VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET state = excluded.state, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at',
      ).run(scope, state, reason, actor, clock.nowIso());
      audit.append({ type: state === 'revoked' ? 'revocation' : 'pause', actor, data: { scope, reason } });
    },
    _cancelAction(actionId, actor, reason) {
      const a = getAction(actionId);
      if (!a) return perr('not_found', 'action not found');
      if (!['held', 'awaiting_approval', 'ready', 'failed'].includes(a.status)) return perr('action_state', `cannot cancel an action that is ${a.status}`);
      approvals.invalidateLive(actionId, `action cancelled: ${reason}`, actor);
      setStatus(actionId, 'cancelled');
      audit.append({ type: 'action_cancelled', actor, actionId, data: { reason } });
      return ok(view(getAction(actionId)!));
    },
  };
  return broker;
}

/** A receipt without a provider operation id is not proof of anything: treat as uncertain. */
function validReceipt(r: unknown): ExecutorReceipt {
  if (!r || typeof r !== 'object' || typeof (r as { providerOperationId?: unknown }).providerOperationId !== 'string' || !(r as { providerOperationId: string }).providerOperationId)
    throw new Error('executor returned no provider operation id; outcome unknown');
  return r as ExecutorReceipt;
}

function summaryData(n: NormalizedAction, integration: string | null): Record<string, unknown> {
  // Audit stores hashes and identifiers, not message bodies.
  return {
    kind: n.kind, accountId: n.accountId, integration, destination: n.destination, payloadHash: n.payloadHash,
    attachments: n.attachments, scope: n.scope, summaryHash: n.summary ? hashCanonical(n.summary) : null,
  };
}
