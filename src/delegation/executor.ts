/** Bridges typed prepare_fix proposals to the existing isolated worker. Never releases code. */
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import { ExecutorRejectedError, type Executor } from '../broker/executor.ts';
import type { DelegationGovernor } from './governor.ts';
import type { DelegationService } from './service.ts';
import type { ProjectRegistry } from './projects.ts';
import type { ActionView, HookVerdict } from '../policy/decide.ts';
import { hasBlockers } from './evidence.ts';

export function projectFixScope(a: ActionView, projects: ProjectRegistry | null, available: boolean): HookVerdict {
  const p = a.payload as { projectId?: unknown } | null;
  if (!available) return { outcome: 'hold', reasons: ['isolated coding worker is not connected'] };
  if (a.kind !== 'prepare_fix' || typeof p?.projectId !== 'string' || !projects?.get(p.projectId) || a.scope?.taskId !== `project:${p.projectId}` || a.scope.projectId !== p.projectId || a.accountId || a.destination.length || a.scope.sourceIds?.length)
    return { outcome: 'hold', reasons: ['code work must name an owner-registered project and its exact project task scope'] };
  return { outcome: 'allow', reasons: ['prepare and test in the registered isolated project only; no merge, deployment or messages'] };
}
export function createDelegationExecutor(o: { db: Db; projects: ProjectRegistry; service(): DelegationService | null; governor(): DelegationGovernor | null; timeoutMs: number }): Executor {
  const row = (id: string) => o.db.prepare('SELECT task_id, result_json FROM delegation_broker_jobs WHERE action_id = ?').get(id) as { task_id: string; result_json: string | null } | undefined;
  return {
    name: 'isolated-code-fixes', integration: 'delegation', kinds: ['prepare_fix'], timeoutMs: o.timeoutMs,
    async execute(intent) {
      const service = o.service(), governor = o.governor();
      if (!service || !governor) throw new ExecutorRejectedError('isolated worker unavailable');
      const p = intent.payload as { projectId?: unknown; problem?: unknown; evidence?: unknown } | null;
      if (!p || Object.keys(p).some(k => !['projectId','problem','evidence'].includes(k)) || typeof p.projectId !== 'string' || !o.projects.get(p.projectId) || typeof p.problem !== 'string' || !p.problem.trim() || p.problem.length > 4000 || (p.evidence !== undefined && (typeof p.evidence !== 'string' || p.evidence.length > 8000)))
        throw new ExecutorRejectedError('invalid code-fix request');
      let saved = row(intent.actionId);
      if (saved) throw new ExecutorRejectedError(`task ${saved.task_id} already exists; inspect it instead of silently repeating cloud work`);
      const created = withTransaction(o.db, () => {
        const task = governor.createTask({ projectId: p.projectId, kind: 'code_change', objective: p.problem,
          inputs: typeof p.evidence === 'string' && p.evidence ? [{ type: 'snippet', label: 'Observed problem (untrusted task data)', text: p.evidence }] : [],
          permittedActions: ['read_repo', 'edit_working_copy', 'run_registered_tests'], expectedEvidence: ['An independently verified patch and test results'], stopConditions: [],
        });
        if (!task.ok) return task;
        o.db.prepare('INSERT INTO delegation_broker_jobs (action_id, task_id) VALUES (?,?)').run(intent.actionId, task.value.taskId);
        return task;
      });
      if (!created.ok) throw new ExecutorRejectedError(created.error.message);
      const r = await service.runAttempt(created.value.taskId, { localExecutionUnavailable: true });
      if (!r.ok) throw new ExecutorRejectedError(r.error.message);
      const v = r.value;
      const summary = v.kind === 'evidence'
        ? { kind: v.kind, taskId: v.task.taskId, testsPassed: v.report.allTestsPassed, blockers: hasBlockers(v.report), report: v.ownerReport }
        : { kind: v.kind, taskId: v.task.taskId, reason: 'reason' in v ? v.reason : 'No verified code fix produced' };
      o.db.prepare('UPDATE delegation_broker_jobs SET result_json = ? WHERE action_id = ?').run(JSON.stringify(summary), intent.actionId);
      if (v.kind !== 'evidence' || hasBlockers(v.report)) throw new ExecutorRejectedError(`Code task ${v.task.taskId} needs attention. Read its report; no code was merged or deployed.`);
      return { providerOperationId: v.task.taskId, detail: { taskId: v.task.taskId, evidenceVerified: true, released: false } };
    },
    async lookup(intent) {
      const r = row(intent.actionId);
      if (!r) return { status: 'not_found' };
      if (!r.result_json) return { status: 'unknown', reason: `task ${r.task_id} interrupted or still running; inspect before retrying` };
      const result = JSON.parse(r.result_json) as { kind: string; blockers?: boolean };
      return result.kind === 'evidence' && result.blockers === false ? { status: 'found', providerOperationId: r.task_id }
        : { status: 'unknown', reason: `task ${r.task_id} did not produce verified evidence; inspect report` };
    },
  };
}
