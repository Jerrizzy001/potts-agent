import type { AccountEntry, AccountMode } from '../core/config.ts';
import { ACTION_CATALOG, classOf, isActionKind, type ActionClass } from './catalog.ts';
import type { LoadedPolicy } from './document.ts';

export type DecisionOutcome = 'allow' | 'require_approval' | 'hold' | 'deny';

/** The parts of an action that policy looks at. */
export interface ActionView {
  kind: string;
  actor: string;
  accountId: string | null;
  /** Integration the action touches (account kind, or executor integration like "github"). */
  integration: string | null;
  /** Exact recipients / targets. */
  destination: readonly string[];
  payload: unknown;
  scope: ActionScope | null;
}

export interface ActionScope {
  taskId?: string;
  sourceIds?: string[];
  projectId?: string;
}

/** Runtime owner controls (from the broker DB + static config flags). */
export interface ControlState {
  globalPaused: boolean;
  pausedIntegrations: ReadonlySet<string>;
  revokedAccounts: ReadonlySet<string>;
}

export interface HookVerdict {
  outcome: 'allow' | 'hold' | 'deny';
  reasons: string[];
}

/**
 * Extension points. The rules for owner alert calls (quiet hours, trigger
 * verification, retry limits) are enforced by WP-5/WP-7 through this hook;
 * without a registered hook, owner alert calls are HELD.
 */
export interface PolicyHooks {
  scoped?: (action: ActionView, policy: LoadedPolicy) => HookVerdict;
  ownerAlert?: (action: ActionView, policy: LoadedPolicy) => HookVerdict;
}

export interface DecisionContext {
  policy: LoadedPolicy;
  /** Registry entry for action.accountId (undefined if unknown or no account). */
  account: AccountEntry | undefined;
  controls: ControlState;
  hooks?: PolicyHooks;
}

export interface Decision {
  outcome: DecisionOutcome;
  reasons: string[];
  kindClass: ActionClass | 'unknown';
  policyVersion: string;
  policyHash: string;
}

const MODE_RANK: Record<AccountMode, number> = { not_connected: 0, read_only: 1, draft_only: 2, approval_required: 3, automatic: 4 };

/**
 * Pure policy decision. Order: unknown kind → hold; revocation → deny;
 * pause → hold; account/mode checks; then class rules. Never returns "allow"
 * for an always-approval kind. Absence of a rule is never approval.
 */
export function decide(action: ActionView, ctx: DecisionContext): Decision {
  const base = { policyVersion: ctx.policy.version, policyHash: ctx.policy.hash };
  const out = (outcome: DecisionOutcome, kindClass: ActionClass | 'unknown', ...reasons: string[]): Decision => ({ outcome, reasons, kindClass, ...base });

  if (!isActionKind(action.kind)) return out('hold', 'unknown', `unknown action kind "${action.kind}": held for owner clarification`);
  const spec = ACTION_CATALOG[action.kind];
  const cls = spec.class;

  if (action.accountId !== null) {
    if (ctx.controls.revokedAccounts.has(action.accountId)) return out('deny', cls, `account ${action.accountId} access is revoked`);
    if (!ctx.account) return out('deny', cls, `account ${action.accountId} is not registered`);
    if (ctx.account.id !== action.accountId) return out('deny', cls, 'account registry mismatch');
  }
  if (ctx.controls.globalPaused) return out('hold', cls, 'all actions are paused by the owner');
  if (action.integration && ctx.controls.pausedIntegrations.has(action.integration))
    return out('hold', cls, `integration ${action.integration} is paused`);

  const mode = ctx.account?.mode;
  if (mode !== undefined) {
    const need = !spec.write ? (action.kind === 'draft' || action.kind === 'prepare_fix' ? 2 : 1) : 3;
    if (MODE_RANK[mode] < need) return out('deny', cls, `account ${ctx.account!.id} mode "${mode}" does not permit ${action.kind}`);
  }
  if (spec.needsDestination && action.destination.length === 0) return out('hold', cls, `${action.kind} requires an exact destination`);
  if (spec.write && action.kind !== 'call_owner_alert' && action.accountId === null && needsAccount(action.kind))
    return out('hold', cls, `${action.kind} requires an exact sending account`);

  switch (cls) {
    case 'scoped': {
      if (ctx.policy.doc.scopedRequireTask && !action.scope?.taskId) return out('hold', cls, 'scoped action has no registered task scope');
      if (!ctx.hooks?.scoped) return out('hold', cls, 'no trusted task scope resolver is registered');
      const verdict = ctx.hooks.scoped(action, ctx.policy);
      return out(verdict.outcome, cls, ...verdict.reasons);
    }
    case 'always_approval':
      return out('require_approval', cls, `${action.kind} always requires explicit owner approval of the exact action`);
    case 'owner_alert': {
      const dest = ctx.policy.doc.ownerAlert.destination;
      if (action.destination.length !== 1 || action.destination[0] !== dest)
        return out('deny', cls, `owner alert calls may only target "${dest}"; calling anyone else is call_third_party`);
      if (!ctx.hooks?.ownerAlert) return out('hold', cls, 'owner alert rules (quiet hours, trigger verification, retry limits) not registered');
      const v = ctx.hooks.ownerAlert(action, ctx.policy);
      return out(v.outcome, cls, ...(v.reasons.length ? v.reasons : [`owner alert hook: ${v.outcome}`]));
    }
    case 'support_reply': {
      // Only the trusted inbound support pipeline can use standing permission.
      // Model-supplied classification/knowledge IDs never authorize a send.
      if (!action.actor.startsWith('support:')) return out('require_approval', cls, 'model-proposed support reply requires owner review');
      const sup = ctx.policy.doc.support;
      if (!action.accountId || !sup.registeredChannels.includes(action.accountId))
        return out('require_approval', cls, 'support reply on an unregistered channel requires owner review');
      if (ctx.account?.purpose !== 'support') return out('require_approval', cls, 'account is not registered for support');
      if (sup.mode !== 'active') return out('require_approval', cls, 'support is in shadow mode: owner review required');
      const p = (action.payload ?? {}) as { classification?: unknown; knowledgeIds?: unknown; requiresOwner?: unknown };
      if (p.classification !== 'customer_support') return out('require_approval', cls, 'message not classified as customer support');
      if (p.requiresOwner === true) return out('require_approval', cls, 'reply flagged as needing owner review');
      const ids = Array.isArray(p.knowledgeIds) ? p.knowledgeIds : [];
      if (ids.length === 0 || !ids.every((k) => typeof k === 'string' && sup.approvedKnowledgeIds.includes(k)))
        return out('require_approval', cls, 'reply cites knowledge that is not approved');
      if (ctx.account.mode !== 'automatic') return out('require_approval', cls, 'support account is not in automatic mode');
      return out('allow', cls, 'registered support channel with approved knowledge');
    }
  }
}

function needsAccount(kind: string): boolean {
  return kind === 'send_message' || kind === 'support_reply';
}
