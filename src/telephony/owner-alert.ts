/**
 * Owner alert calls: policy hook, broker executor and the retry service.
 *
 * Rules (operating spec + plan Phase 7), enforced here and re-checked at the
 * moment of dispatch:
 *   - only the policy's owner destination; the real number is resolved
 *     broker-side from a secret reference and never appears in the action;
 *   - only the agreed triggers, for an incident that is still active and that
 *     the incident validator still confirms;
 *   - at most policy.ownerAlert.maxAttemptsPerIncident attempts (default 3),
 *     retryIntervalSeconds apart (default 300). Attempts are DB rows written
 *     before the provider is called, so a restart cannot reset the count;
 *   - quiet hours via the OwnerAlertDecider at proposal, in the broker's
 *     dispatch-time re-decision, AND again inside the executor;
 *   - retries stop only on an explicit DTMF "1". Voicemail/answering machine
 *     or an "answered"/"completed" status is not acknowledgement.
 *
 * NOT AN EMERGENCY SERVICE: see types.ts.
 */
import type { Clock } from '../core/clock.ts';
import { hashCanonical } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { ActionView, HookVerdict } from '../policy/decide.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import { ExecutorRejectedError, type DispatchIntent, type Executor, type ExecutorReceipt, type LookupResult } from '../broker/executor.ts';
import type { Broker } from '../broker/broker.ts';
import { ALERT_TRIGGERS, type AlertTrigger, type IncidentValidator, type OwnerAlertDecider, type TelephonyProvider } from './types.ts';
import type { AlertCall, TelephonyStore } from './store.ts';
import { alertMessage, sanitizeLabel } from './script.ts';

export interface OwnerAlertPayload {
  incidentId: string;
  trigger: AlertTrigger;
  attempt: number;
  label?: string;
}

export function parseOwnerAlertPayload(raw: unknown): Result<OwnerAlertPayload> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return perr('invalid_input', 'owner alert payload must be an object');
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!['incidentId', 'trigger', 'attempt', 'label'].includes(k)) return perr('invalid_input', `unknown owner alert field ${k}`);
  if (typeof p.incidentId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p.incidentId)) return perr('invalid_input', 'incidentId required');
  if (!(ALERT_TRIGGERS as readonly unknown[]).includes(p.trigger)) return perr('invalid_input', `trigger must be one of ${ALERT_TRIGGERS.join(', ')}`);
  if (typeof p.attempt !== 'number' || !Number.isInteger(p.attempt) || p.attempt < 1) return perr('invalid_input', 'attempt must be a positive integer');
  if (p.label !== undefined && (typeof p.label !== 'string' || sanitizeLabel(p.label) !== p.label)) return perr('invalid_input', 'label must already be sanitized (letters, digits, space, . -; max 40)');
  return ok(p as unknown as OwnerAlertPayload);
}

export interface OwnerAlertDeps {
  store: TelephonyStore;
  decider: OwnerAlertDecider;
  incidents: IncidentValidator;
  clock: Clock;
}

/**
 * Pure-ish check shared by the policy hook and the executor. Returns a
 * verdict for an attempt at `now`.
 */
export function checkOwnerAlert(payload: unknown, policy: LoadedPolicy, d: OwnerAlertDeps): HookVerdict {
  const p = parseOwnerAlertPayload(payload);
  if (!p.ok) return { outcome: 'deny', reasons: [p.error.message] };
  const { incidentId, attempt, trigger } = p.value;
  const inc = d.store.incident(incidentId);
  if (!inc) return { outcome: 'deny', reasons: [`unknown incident ${incidentId}`] };
  if (inc.trigger !== trigger) return { outcome: 'deny', reasons: ['trigger does not match the incident'] };
  if (inc.status !== 'active') return { outcome: 'deny', reasons: [`incident is ${inc.status}`] };
  const max = policy.doc.ownerAlert.maxAttemptsPerIncident;
  if (attempt > max) return { outcome: 'deny', reasons: [`attempt ${attempt} exceeds the limit of ${max} per incident`] };
  const others = d.store.calls(incidentId).filter((c) => c.attempt !== attempt);
  if (attempt !== others.length + 1) return { outcome: 'deny', reasons: [`attempt ${attempt} out of sequence (${others.length} prior attempts)`] };
  const now = d.clock.now();
  const last = others[others.length - 1];
  if (last) {
    const next = Date.parse(last.createdAt) + policy.doc.ownerAlert.retryIntervalSeconds * 1000;
    if (now.getTime() < next) return { outcome: 'hold', reasons: [`retry interval: next attempt allowed at ${new Date(next).toISOString()}`] };
  }
  const v = d.incidents.revalidate(incidentId);
  if (!v.active) return { outcome: 'deny', reasons: [`incident no longer valid: ${v.reason}`] };
  const q = d.decider.evaluateCall(now);
  if (!q.allowed) return { outcome: 'hold', reasons: [`owner call not allowed now: ${q.reason}${q.nextAllowedAt ? ` (next ${q.nextAllowedAt})` : ''}`] };
  return { outcome: 'allow', reasons: [`owner alert attempt ${attempt}/${max} for ${trigger} incident ${incidentId}`] };
}

/** PolicyHooks.ownerAlert implementation (register via createBroker({hooks: {ownerAlert}})). */
export function createOwnerAlertHook(d: OwnerAlertDeps): (action: ActionView, policy: LoadedPolicy) => HookVerdict {
  return (action, policy) => {
    if (action.kind !== 'call_owner_alert') return { outcome: 'deny', reasons: ['not an owner alert'] };
    return checkOwnerAlert(action.payload, policy, d);
  };
}

export interface OwnerAlertExecutorOptions extends OwnerAlertDeps {
  provider: TelephonyProvider;
  policy: () => LoadedPolicy;
  /** Telephony account id (registry) whose address is the caller number. */
  accountId: string;
  fromNumber: string;
  /** Resolves the owner's real alert number (secret reference, broker-side only). */
  ownerNumber: () => Promise<string>;
  /** Public HTTPS base of the callback route, e.g. https://potts-calls.example.ts.net */
  publicBaseUrl: string;
  machineDetection?: boolean;
  ringTimeoutSeconds?: number;
  /** Seconds after the intent before "no call found" is trusted. Default 120. */
  lookupSettleSeconds?: number;
  timeoutMs?: number;
}

export const STATUS_PATH = '/telephony/twilio/status';
export const GATHER_PATH = '/telephony/twilio/gather';

export function createOwnerAlertExecutor(o: OwnerAlertExecutorOptions): Executor {
  const base = o.publicBaseUrl.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('telephony publicBaseUrl must be https');
  const settle = (o.lookupSettleSeconds ?? 120) * 1000;
  return {
    name: `owner-alert-call:${o.provider.name}`,
    integration: 'telephony',
    kinds: ['call_owner_alert'],
    timeoutMs: o.timeoutMs ?? 20_000,

    async execute(intent: Readonly<DispatchIntent>, signal: AbortSignal): Promise<ExecutorReceipt> {
      const reject = (m: string): never => {
        throw new ExecutorRejectedError(m);
      };
      if (intent.kind !== 'call_owner_alert') reject('wrong kind');
      if (hashCanonical(intent.payload) !== intent.payloadHash) reject('payload does not match its hash');
      if (intent.accountId !== o.accountId || intent.accountAddress !== o.fromNumber) reject('caller account does not match the configured telephony account');
      const policy = o.policy();
      if (intent.destination.length !== 1 || intent.destination[0] !== policy.doc.ownerAlert.destination) reject('owner alert executor only calls the owner destination');
      // Re-check every rule at the instant of dispatch (quiet hours, interval, limit, incident validity).
      const v = checkOwnerAlert(intent.payload, policy, o);
      if (v.outcome !== 'allow') reject(`blocked at dispatch: ${v.reasons.join('; ')}`);
      const p = parseOwnerAlertPayload(intent.payload);
      if (!p.ok) return reject(p.error.message);
      let to: string;
      try {
        to = await o.ownerNumber();
      } catch (e) {
        return reject(`owner alert number unavailable: ${(e as Error).message}`);
      }
      if (!/^\+[1-9][0-9]{6,14}$/.test(to)) reject('owner alert number is not E.164');
      const begun = o.store.beginAttempt({
        incidentId: p.value.incidentId, attempt: p.value.attempt, actionId: intent.actionId, dispatchId: intent.dispatchId, provider: o.provider.name,
        maxAttempts: policy.doc.ownerAlert.maxAttemptsPerIncident,
      });
      if (!begun.ok) return reject(begun.reason);
      const callId = begun.call.id;
      const q = `?c=${encodeURIComponent(callId)}`;
      try {
        const r = await o.provider.placeCall({
          to, from: o.fromNumber, idempotencyKey: intent.idempotencyKey,
          script: { say: alertMessage(p.value.trigger, p.value.label), gatherUrl: `${base}${GATHER_PATH}${q}`, statusUrl: `${base}${STATUS_PATH}${q}` },
          machineDetection: o.machineDetection ?? true, ringTimeoutSeconds: o.ringTimeoutSeconds ?? 25,
        }, signal);
        o.store.updateCall(callId, { providerCallId: r.providerCallId, status: r.status });
        return { providerOperationId: r.providerCallId, detail: { callId, attempt: p.value.attempt } };
      } catch (e) {
        o.store.updateCall(callId, { status: e instanceof ExecutorRejectedError ? 'rejected' : 'uncertain', error: (e as Error).message.slice(0, 300) });
        throw e;
      }
    },

    async lookup(intent: Readonly<DispatchIntent>): Promise<LookupResult> {
      const row = o.store.callByAction(intent.actionId);
      if (!row) return { status: 'not_found' }; // the attempt row is written before the provider is called
      if (row.providerCallId) return { status: 'found', providerOperationId: row.providerCallId, detail: { via: 'stored' } };
      let to: string;
      try {
        to = await o.ownerNumber();
      } catch (e) {
        return { status: 'unknown', reason: `owner number unavailable: ${(e as Error).message}` };
      }
      const since = new Date(Date.parse(row.updatedAt) - 5000).toISOString();
      const r = await o.provider.findCalls({ to, from: o.fromNumber, since });
      if (!r.ok) return { status: 'unknown', reason: r.reason };
      const unclaimed = r.calls.filter((c) => !o.store.callBySid(c.providerCallId));
      if (unclaimed.length === 1) {
        const c = unclaimed[0]!;
        o.store.updateCall(row.id, { providerCallId: c.providerCallId, status: c.status });
        return { status: 'found', providerOperationId: c.providerCallId, detail: { via: 'provider-list' } };
      }
      if (unclaimed.length > 1) return { status: 'unknown', reason: 'several unclaimed calls; cannot attribute' };
      if (!r.complete) return { status: 'unknown', reason: 'call list truncated' };
      if (o.clock.nowMs() - Date.parse(row.updatedAt) < settle) return { status: 'unknown', reason: 'waiting for the provider list to settle' };
      o.store.updateCall(row.id, { status: 'not_placed' });
      return { status: 'not_found' };
    },
  };
}

export interface OwnerAlertServiceOptions extends OwnerAlertDeps {
  broker: Pick<Broker, 'propose' | 'execute' | 'reconcile' | 'getAction'>;
  policy: () => LoadedPolicy;
  accountId: string;
  actor?: string;
}

export type TickEvent =
  | { incidentId: string; event: 'resolved' | 'exhausted' | 'waiting_interval' | 'quiet_hours' | 'held' | 'denied' | 'proposal_failed'; detail: string }
  | { incidentId: string; event: 'called' | 'call_uncertain' | 'call_failed'; attempt: number; actionId: string; detail: string };

export interface OwnerAlertService {
  /** Registers an incident for alert calls (idempotent by incident id). Does not call by itself. */
  raise(i: { incidentId: string; trigger: AlertTrigger; label?: string }): Result<{ created: boolean }>;
  /** Called by the daemon (e.g. every 30 s). Places at most one attempt per due incident. */
  tick(): Promise<TickEvent[]>;
  resolve(incidentId: string, reason: string): void;
  cancel(incidentId: string, reason: string): void;
}

export function createOwnerAlertService(o: OwnerAlertServiceOptions): OwnerAlertService {
  const { store, clock } = o;
  const actor = o.actor ?? 'system:owner-alert';
  const later = (ms: number) => new Date(clock.nowMs() + ms).toISOString();

  const attemptOnce = async (incidentId: string): Promise<TickEvent> => {
    const inc = store.incident(incidentId)!;
    const policy = o.policy();
    const { maxAttemptsPerIncident: max, retryIntervalSeconds: interval } = policy.doc.ownerAlert;
    const v = o.incidents.revalidate(incidentId);
    if (!v.active) {
      store.setIncident(incidentId, { status: 'resolved', statusReason: v.reason, pendingActionId: null });
      return { incidentId, event: 'resolved', detail: v.reason };
    }
    const calls: AlertCall[] = store.calls(incidentId);
    // Resolve an uncertain previous attempt first (best effort; it still counts as an attempt).
    const prev = calls[calls.length - 1];
    if (prev && o.broker.getAction(prev.actionId)?.status === 'uncertain') await o.broker.reconcile(prev.actionId);
    if (calls.length >= max && !inc.pendingActionId) {
      store.setIncident(incidentId, { status: 'exhausted', statusReason: `${calls.length} attempts without acknowledgement` });
      return { incidentId, event: 'exhausted', detail: `${calls.length}/${max} attempts used` };
    }
    if (prev) {
      const next = Date.parse(prev.createdAt) + interval * 1000;
      if (clock.nowMs() < next) {
        store.setIncident(incidentId, { nextAttemptAt: new Date(next).toISOString() });
        return { incidentId, event: 'waiting_interval', detail: new Date(next).toISOString() };
      }
    }
    const q = o.decider.evaluateCall(clock.now());
    if (!q.allowed) {
      store.setIncident(incidentId, { nextAttemptAt: q.nextAllowedAt ?? later(interval * 1000) });
      return { incidentId, event: 'quiet_hours', detail: q.reason };
    }
    let actionId = inc.pendingActionId;
    let attempt = calls.length + 1;
    if (actionId) {
      const a = o.broker.getAction(actionId);
      const pp = a ? parseOwnerAlertPayload(a.payload) : undefined;
      if (!a || a.status !== 'held' || !pp?.ok || pp.value.attempt !== attempt) actionId = null;
    }
    if (!actionId) {
      const payload: OwnerAlertPayload = { incidentId, trigger: inc.trigger, attempt, ...(inc.label ? { label: inc.label } : {}) };
      const pr = o.broker.propose({ kind: 'call_owner_alert', accountId: o.accountId, destination: [policy.doc.ownerAlert.destination], payload, summary: `Owner alert call attempt ${attempt}` }, actor);
      if (!pr.ok) {
        store.setIncident(incidentId, { nextAttemptAt: later(interval * 1000) });
        return { incidentId, event: 'proposal_failed', detail: pr.error.message };
      }
      actionId = pr.value.actionId;
      if (pr.value.status === 'denied') {
        store.setIncident(incidentId, { pendingActionId: null, nextAttemptAt: later(interval * 1000) });
        return { incidentId, event: 'denied', detail: pr.value.reasons.join('; ') };
      }
      if (pr.value.status === 'held') {
        store.setIncident(incidentId, { pendingActionId: actionId, nextAttemptAt: later(60_000) });
        return { incidentId, event: 'held', detail: pr.value.reasons.join('; ') };
      }
    }
    attempt = (parseOwnerAlertPayload(o.broker.getAction(actionId)!.payload) as { ok: true; value: OwnerAlertPayload }).value.attempt;
    const r = await o.broker.execute(actionId);
    if (!r.ok) {
      // Held/denied at dispatch time (e.g. the clock crossed 23:00): keep the action for later.
      const held = r.error.code === 'held';
      store.setIncident(incidentId, { pendingActionId: held ? actionId : null, nextAttemptAt: later(held ? 60_000 : interval * 1000) });
      return { incidentId, event: held ? 'held' : 'denied', detail: r.error.message };
    }
    store.setIncident(incidentId, { pendingActionId: null, nextAttemptAt: later(interval * 1000) });
    if (r.value.status === 'succeeded') return { incidentId, event: 'called', attempt, actionId, detail: r.value.providerOperationId };
    if (r.value.status === 'uncertain') return { incidentId, event: 'call_uncertain', attempt, actionId, detail: r.value.reason };
    return { incidentId, event: 'call_failed', attempt, actionId, detail: r.value.reason };
  };

  return {
    raise(i) {
      if (!(ALERT_TRIGGERS as readonly string[]).includes(i.trigger)) return perr('invalid_input', 'unknown trigger');
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(i.incidentId)) return perr('invalid_input', 'bad incident id');
      const label = sanitizeLabel(i.label);
      const r = store.raise({ id: i.incidentId, trigger: i.trigger, label });
      return ok({ created: r.created });
    },
    async tick() {
      const out: TickEvent[] = [];
      for (const inc of store.dueIncidents(clock.nowIso())) out.push(await attemptOnce(inc.id));
      return out;
    },
    resolve(id, reason) {
      if (store.incident(id)?.status === 'active') store.setIncident(id, { status: 'resolved', statusReason: reason, pendingActionId: null });
    },
    cancel(id, reason) {
      if (store.incident(id)?.status === 'active') store.setIncident(id, { status: 'cancelled', statusReason: reason, pendingActionId: null });
    },
  };
}
