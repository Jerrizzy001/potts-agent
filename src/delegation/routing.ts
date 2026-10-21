/**
 * Routing policy: local Qwen for routine work; escalate to Claude Code for
 * substantial code changes, large context, or after bounded local attempts
 * failed; External only as an owner-reviewed manual brief; otherwise the owner.
 * Routing never chooses a paid route — billing is checked separately by the
 * paid escalation guard.
 */
import type { TaskSpec } from './task.ts';

export type WorkerTarget = 'local_qwen' | 'claude_code' | 'external_manual' | 'owner';

export interface RoutingConfig {
  /** Max prompt+inputs tokens routed to the local 32K-context model (leaves room for output). */
  localContextTokenBudget: number;
  /** Failed local attempts before escalating. */
  maxLocalAttempts: number;
  substantialFilesChanged: number;
  substantialLinesChanged: number;
}

export const DEFAULT_ROUTING: RoutingConfig = Object.freeze({
  localContextTokenBudget: 24_000,
  maxLocalAttempts: 2,
  substantialFilesChanged: 3,
  substantialLinesChanged: 150,
});

export interface RoutingSignals {
  /** Trusted caller knows the local assistant cannot execute repository work. */
  localExecutionUnavailable?: boolean;
  /** Estimated tokens of brief + inputs (see estimateTokens). */
  contextTokens: number;
  estimatedFilesChanged?: number;
  estimatedLinesChanged?: number;
  /** Bounded local attempts that already failed for this task. */
  localFailedAttempts?: number;
}

export interface Availability {
  /** Claude Code adapter enabled, worker isolation in place, auth verified as subscription. */
  claudeCode: boolean;
  /** External manual brief route (always available unless disabled). */
  externalManual: boolean;
}

export interface RouteDecision {
  target: WorkerTarget;
  escalated: boolean;
  reasons: string[];
}

/** Rough token estimate (≈4 chars/token), deliberately conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function routeTask(spec: Pick<TaskSpec, 'kind' | 'projectId'>, s: RoutingSignals, avail: Availability, cfg: RoutingConfig = DEFAULT_ROUTING): RouteDecision {
  const why: string[] = [];
  if (spec.kind !== 'text' && s.localExecutionUnavailable) why.push('local assistant has no repository execution tool');
  if (spec.kind === 'code_change' && ((s.estimatedFilesChanged ?? 0) >= cfg.substantialFilesChanged || (s.estimatedLinesChanged ?? 0) >= cfg.substantialLinesChanged))
    why.push(`substantial code change (≥${cfg.substantialFilesChanged} files or ≥${cfg.substantialLinesChanged} lines estimated)`);
  if (s.contextTokens > cfg.localContextTokenBudget) why.push(`context ${s.contextTokens} tokens exceeds the local budget ${cfg.localContextTokenBudget}`);
  if ((s.localFailedAttempts ?? 0) >= cfg.maxLocalAttempts) why.push(`${s.localFailedAttempts} bounded local attempts failed`);
  if (!why.length) return { target: 'local_qwen', escalated: false, reasons: ['routine task within local model limits'] };
  if (spec.projectId !== null && spec.kind !== 'text' && avail.claudeCode) return { target: 'claude_code', escalated: true, reasons: [...why, 'escalated to Claude Code in the isolated worker'] };
  if (avail.externalManual)
    return { target: 'external_manual', escalated: true, reasons: [...why, avail.claudeCode ? 'non-repository task: owner-reviewed manual External brief' : 'Claude Code route unavailable: owner-reviewed manual External brief'] };
  return { target: 'owner', escalated: true, reasons: [...why, 'no stronger agent route available; owner decides'] };
}
