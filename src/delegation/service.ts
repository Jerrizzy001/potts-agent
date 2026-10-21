/**
 * Delegation service: ties the governor, routing, paid guard, working copies,
 * worker adapters and evidence together for one task attempt. It never
 * merges, pushes or deploys; release proposals are a separate, explicit step
 * (src/release) that needs owner approval of the exact commit and target.
 */
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { canonicalJson } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { Broker } from '../broker/broker.ts';
import { buildHandoffBrief, type HandoffBrief } from './brief.ts';
import { claudeEnvForCheck, type ClaudeCodeAdapter, type WorkerResult } from './claude.ts';
import { collectEvidence, hasBlockers, renderOwnerReport, type EvidenceReport } from './evidence.ts';
import type { DelegationGovernor, TaskRecord } from './governor.ts';
import type { ExternalAdapter, ExternalHandoff } from './external.ts';
import type { PaidEscalationGuard } from './paid.ts';
import type { ProjectRegistry } from './projects.ts';
import { estimateTokens, routeTask, type RouteDecision, type RoutingConfig, type RoutingSignals } from './routing.ts';
import type { IsolatedRunner } from './runner.ts';
import { createWorkingCopy } from './workspace.ts';

export interface DelegationServiceOptions {
  db: Db;
  clock?: Clock;
  broker: Broker;
  governor: DelegationGovernor;
  projects: ProjectRegistry;
  runner: IsolatedRunner;
  paidGuard: PaidEscalationGuard;
  claude: ClaudeCodeAdapter | null;
  external: ExternalAdapter;
  /** Potts-owned directory for evidence clones. */
  evidenceRoot: string;
  routing?: RoutingConfig;
  /** Resolves the subscription OAuth token for the worker (secret ref inside trusted code), if configured. */
  claudeOauthToken?: () => Promise<string | null>;
  /** Skip `claude auth status` (tests with a fake CLI that implements it can leave this false). */
  skipAuthCheck?: boolean;
}

export type CodingTaskOutcome =
  | { kind: 'evidence'; task: TaskRecord; route: RouteDecision; worker: WorkerResult; report: EvidenceReport; ownerReport: string; brief: HandoffBrief }
  | { kind: 'manual_handoff'; task: TaskRecord; route: RouteDecision; handoff: ExternalHandoff; brief: HandoffBrief }
  | { kind: 'local'; task: TaskRecord; route: RouteDecision; brief: HandoffBrief }
  | { kind: 'awaiting_owner'; task: TaskRecord; route: RouteDecision; reason: string; purchaseActionId: string | null }
  | { kind: 'blocked'; task: TaskRecord; route: RouteDecision | null; reason: string };

export interface DelegationService {
  /** Routes and (for Claude Code) runs one bounded attempt, then collects independent evidence. */
  runAttempt(taskId: string, signals?: Partial<RoutingSignals>): Promise<Result<CodingTaskOutcome>>;
  latestEvidence(taskId: string): EvidenceReport | undefined;
}

export function createDelegationService(o: DelegationServiceOptions): DelegationService {
  const clock = o.clock ?? systemClock;
  const saveEvidence = (taskId: string, runId: string | null, r: EvidenceReport) =>
    withTransaction(o.db, () =>
      o.db.prepare('INSERT INTO delegation_evidence (id, task_id, run_id, base_sha, candidate_sha, report_json, report_hash, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
        newId('evd', clock), taskId, runId, r.baseSha, r.candidateSha, canonicalJson(r), r.reportHash, clock.nowIso(),
      ),
    );
  const blocked = (task: TaskRecord, route: RouteDecision | null, reason: string): Result<CodingTaskOutcome> => {
    const t = o.governor.setStatus(task.taskId, 'blocked', reason);
    return ok({ kind: 'blocked', task: t.ok ? t.value : task, route, reason });
  };

  return {
    async runAttempt(taskId, signals = {}) {
      const task = o.governor.get(taskId);
      if (!task) return perr('not_found', 'task not found');
      const project = task.projectId ? o.projects.get(task.projectId) ?? null : null;
      if (task.projectId && !project) return blocked(task, null, `project ${task.projectId} is not registered`);
      const brief = buildHandoffBrief(taskId, task.spec, project);
      const route = routeTask(task.spec, { contextTokens: signals.contextTokens ?? estimateTokens(brief.text), ...signals }, { claudeCode: o.claude !== null, externalManual: true }, o.routing);
      o.governor.setRoute(taskId, route.target);

      if (route.target === 'local_qwen') return ok({ kind: 'local', task: o.governor.get(taskId)!, route, brief });
      if (route.target === 'owner') return blocked(task, route, route.reasons.join('; '));
      if (route.target === 'external_manual') {
        const handoff = await o.external.handoff(brief);
        const t = o.governor.setStatus(taskId, 'awaiting_owner', 'manual External brief prepared for owner review');
        return ok({ kind: 'manual_handoff', task: t.ok ? t.value : task, route, handoff, brief });
      }

      // claude_code
      const paid = o.paidGuard.check('claude_code', { taskId });
      if (!paid.ok) return paid;
      if (!paid.value.allowed) {
        const t = o.governor.setStatus(taskId, 'awaiting_owner', paid.value.reason);
        return ok({ kind: 'awaiting_owner', task: t.ok ? t.value : task, route, reason: paid.value.reason, purchaseActionId: paid.value.purchase?.actionId ?? null });
      }
      if (!project || !o.claude) return blocked(task, route, 'Claude Code route needs a registered project and an enabled adapter');
      const start = o.governor.startAttempt(taskId, 'claude_code');
      if (!start.ok) return start;
      const run = start.value;
      let worker: WorkerResult;
      let report: EvidenceReport;
      try {
        let wcDir = task.workingCopy;
        let baseSha: string;
        if (wcDir && task.baseSha) {
          // Retry continues in the preserved working copy (unfinished work is kept).
          baseSha = task.baseSha;
        } else {
          const wc = await createWorkingCopy({ project, taskId, runner: o.runner });
          wcDir = wc.dir;
          baseSha = wc.baseSha;
          o.governor.setWorkingCopy(taskId, wc.dir, wc.baseSha);
        }
        const token = o.claudeOauthToken ? await o.claudeOauthToken() : null;
        if (!o.skipAuthCheck) {
          const auth = await o.claude.checkAuth(claudeEnvForCheck(o.runner, project, token), wcDir);
          if (!auth.ok) {
            o.governor.finishAttempt(run.id, 'error', { reason: auth.reason });
            return blocked(o.governor.get(taskId)!, route, `Claude Code auth check failed: ${auth.reason}`);
          }
        }
        worker = await o.claude.run({ spec: task.spec, project, brief, workingDir: wcDir, oauthToken: token });
        report = await collectEvidence({ taskId, project, runner: o.runner, workingDir: wcDir, baseSha, worker, evidenceRoot: o.evidenceRoot, clock });
      } catch (e) {
        o.governor.finishAttempt(run.id, 'error', { error: (e as Error).message });
        return perr('internal', `delegation attempt failed: ${(e as Error).message}`);
      }
      saveEvidence(taskId, run.id, report);
      if (worker.status === 'allowance_exhausted') {
        o.governor.finishAttempt(run.id, 'allowance_exhausted', { worker: worker.status, reportHash: report.reportHash });
        const paid2 = o.paidGuard.check('claude_code', { taskId, allowanceExhausted: true });
        const reason = paid2.ok && !paid2.value.allowed ? paid2.value.reason : 'allowance exhausted';
        return ok({
          kind: 'awaiting_owner', task: o.governor.get(taskId)!, route, reason,
          purchaseActionId: paid2.ok && !paid2.value.allowed ? paid2.value.purchase?.actionId ?? null : null,
        });
      }
      const outcome = worker.status === 'timeout' ? 'timeout' : !hasBlockers(report) ? 'succeeded' : worker.status === 'completed' ? 'failed' : 'error';
      o.governor.finishAttempt(run.id, outcome, { worker: worker.status, reportHash: report.reportHash, candidateSha: report.candidateSha });
      return ok({ kind: 'evidence', task: o.governor.get(taskId)!, route, worker, report, ownerReport: renderOwnerReport(report), brief });
    },
    latestEvidence(taskId) {
      const r = o.db.prepare('SELECT report_json FROM delegation_evidence WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(taskId) as { report_json: string } | undefined;
      return r ? (JSON.parse(r.report_json) as EvidenceReport) : undefined;
    },
  };
}
