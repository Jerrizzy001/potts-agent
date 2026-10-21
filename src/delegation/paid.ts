/**
 * Paid escalation guard. Delegation may use local compute and the owner's
 * EXISTING subscription allowance only. It never switches to separately billed
 * API keys/credits/overages: any such need becomes a `purchase` proposal in
 * the broker (always owner approval) and the task waits.
 */
import type { Broker, ProposeOutcome } from '../broker/broker.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { WorkerTarget } from './routing.ts';

export type Billing = 'local' | 'subscription' | 'separately_billed' | 'none';

export interface PaidGuardConfig {
  /** How each route is paid for. External manual / owner cost nothing automated. */
  billing: Record<WorkerTarget, Billing>;
  onAllowanceExhausted: 'wait' | 'propose_purchase';
}

export const DEFAULT_PAID_GUARD: PaidGuardConfig = Object.freeze({
  billing: Object.freeze({ local_qwen: 'local', claude_code: 'subscription', external_manual: 'none', owner: 'none' } as const),
  onAllowanceExhausted: 'propose_purchase' as const,
});

export type PaidCheck =
  | { allowed: true; billing: Billing }
  | { allowed: false; reason: string; purchase: ProposeOutcome | null };

export interface PaidEscalationGuard {
  /** Before starting a worker on `target`. */
  check(target: WorkerTarget, ctx: { taskId: string; allowanceExhausted?: boolean }): Result<PaidCheck>;
}

const PROVIDER: Record<WorkerTarget, string> = { local_qwen: 'local', claude_code: 'anthropic', external_manual: 'openai', owner: 'none' };

export function createPaidEscalationGuard(o: { broker: Broker; actor?: string; config?: Partial<PaidGuardConfig>; existingPurchase?: (taskId: string) => string | null; recordPurchase?: (taskId: string, actionId: string) => void }): PaidEscalationGuard {
  const cfg: PaidGuardConfig = { ...DEFAULT_PAID_GUARD, ...(o.config ?? {}), billing: { ...DEFAULT_PAID_GUARD.billing, ...(o.config?.billing ?? {}) } };
  const actor = o.actor ?? 'potts:delegation';
  const propose = (target: WorkerTarget, taskId: string, reason: string): Result<ProposeOutcome> => {
    const prior = o.existingPurchase?.(taskId);
    if (prior) {
      const st = o.broker.status(prior);
      if (st) return ok({ actionId: st.id, status: st.status, decision: st.decision, reasons: st.reasons, approvalId: st.approval?.id ?? null, bindingHash: st.approval?.bindingHash ?? null });
    }
    const r = o.broker.propose(
      {
        kind: 'purchase',
        destination: [`${PROVIDER[target]}:extra-usage`],
        payload: { type: 'paid_ai_usage', provider: PROVIDER[target], route: target, taskId, reason, amount: null, note: 'Amount unknown until the owner chooses a plan/credit option; nothing is bought by Potts.' },
        scope: { taskId },
        summary: `Delegated task ${taskId} needs paid ${PROVIDER[target]} usage beyond the existing allowance: ${reason}`,
      },
      actor,
    );
    if (r.ok) o.recordPurchase?.(taskId, r.value.actionId);
    return r;
  };
  return {
    check(target, ctx) {
      const billing = cfg.billing[target];
      if (billing === 'local' || billing === 'none') return ok({ allowed: true, billing });
      if (billing === 'subscription' && !ctx.allowanceExhausted) return ok({ allowed: true, billing });
      const reason = billing === 'separately_billed' ? `${target} is configured as separately billed usage` : 'the existing subscription allowance is exhausted';
      if (billing === 'subscription' && cfg.onAllowanceExhausted === 'wait') return ok({ allowed: false, reason, purchase: null });
      const p = propose(target, ctx.taskId, reason);
      if (!p.ok) return perr(p.error.code, `purchase proposal failed: ${p.error.message}`);
      return ok({ allowed: false, reason, purchase: p.value });
    },
  };
}
