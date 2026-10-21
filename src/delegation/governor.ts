/**
 * Delegation governor: durable task tree with recursion/loop prevention,
 * per-root budgets, a concurrency cap and bounded retries.
 *
 *  - depth: a child is parent.depth + 1; above `maxDepth` it is refused.
 *  - cycles: a task whose objective fingerprint (normalized objective +
 *    project + kind) equals any ancestor's is refused (A→B→A loops).
 *  - per-root budget: total tasks and total attempts under one root.
 *  - concurrency: global and per-project caps on running attempts; a task
 *    over the cap stays queued (retry later), it is not failed.
 *  - retries: at most `maxAttemptsPerTask` attempts; a failed task keeps its
 *    working copy (unfinished work is preserved).
 *  - deadline: no attempt starts after the deadline.
 */
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { canonicalJson, hashCanonical } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { objectiveFingerprint, validateTaskInput, type TaskSpec } from './task.ts';

export interface DelegationLimits {
  maxDepth: number;
  maxTasksPerRoot: number;
  maxAttemptsPerRoot: number;
  maxConcurrentWorkers: number;
  maxConcurrentPerProject: number;
  maxAttemptsPerTask: number;
  defaultDeadlineMinutes: number;
}

export const DEFAULT_LIMITS: DelegationLimits = Object.freeze({
  maxDepth: 2,
  maxTasksPerRoot: 8,
  maxAttemptsPerRoot: 12,
  maxConcurrentWorkers: 2,
  maxConcurrentPerProject: 1,
  maxAttemptsPerTask: 2,
  defaultDeadlineMinutes: 120,
});

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'awaiting_owner' | 'cancelled';
export type RunOutcome = 'succeeded' | 'failed' | 'error' | 'timeout' | 'allowance_exhausted';
export type LimitCode =
  | 'max_depth' | 'cycle' | 'root_task_budget' | 'root_attempt_budget' | 'concurrency' | 'retries_exhausted' | 'deadline_passed'
  | 'parent_not_found' | 'parent_closed' | 'task_state';

export interface TaskRecord {
  taskId: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  projectId: string | null;
  route: string | null;
  status: TaskStatus;
  statusReason: string | null;
  attempts: number;
  maxAttempts: number;
  deadline: string;
  spec: TaskSpec;
  specHash: string;
  purchaseActionId: string | null;
  workingCopy: string | null;
  baseSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  attempt: number;
  worker: string;
  status: 'running' | RunOutcome | 'abandoned';
  startedAt: string;
  finishedAt: string | null;
  result: unknown;
}

type TaskRow = {
  task_id: string; parent_id: string | null; root_id: string; depth: number; project_id: string | null; kind: string; objective_fingerprint: string;
  route: string | null; status: string; status_reason: string | null; attempts: number; max_attempts: number; deadline: string; spec_json: string;
  spec_hash: string; purchase_action_id: string | null; working_copy: string | null; base_sha: string | null; created_at: string; updated_at: string;
};
type RunRow = { id: string; task_id: string; attempt: number; worker: string; status: string; started_at: string; finished_at: string | null; result_json: string | null };

const toTask = (r: TaskRow): TaskRecord => ({
  taskId: r.task_id, parentId: r.parent_id, rootId: r.root_id, depth: r.depth, projectId: r.project_id, route: r.route, status: r.status as TaskStatus,
  statusReason: r.status_reason, attempts: r.attempts, maxAttempts: r.max_attempts, deadline: r.deadline, spec: JSON.parse(r.spec_json) as TaskSpec,
  specHash: r.spec_hash, purchaseActionId: r.purchase_action_id, workingCopy: r.working_copy, baseSha: r.base_sha, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toRun = (r: RunRow): RunRecord => ({
  id: r.id, taskId: r.task_id, attempt: r.attempt, worker: r.worker, status: r.status as RunRecord['status'], startedAt: r.started_at,
  finishedAt: r.finished_at, result: r.result_json ? (JSON.parse(r.result_json) as unknown) : null,
});

const limitErr = <T>(limit: LimitCode, message: string, extra: Record<string, unknown> = {}): Result<T> =>
  perr(limit === 'concurrency' ? 'held' : limit === 'task_state' ? 'action_state' : 'denied', message, { limit, ...extra });

export interface DelegationGovernor {
  readonly limits: DelegationLimits;
  createTask(input: unknown, opts?: { extraExcludes?: readonly string[] }): Result<TaskRecord>;
  get(taskId: string): TaskRecord | undefined;
  children(taskId: string): TaskRecord[];
  runs(taskId: string): RunRecord[];
  /** Checks deadline/retries/budgets/concurrency and records a running attempt. */
  startAttempt(taskId: string, worker: string): Result<RunRecord>;
  /** Closes an attempt. Failed attempts re-queue while retries remain. */
  finishAttempt(runId: string, outcome: RunOutcome, result: unknown): Result<TaskRecord>;
  setRoute(taskId: string, route: string): void;
  setStatus(taskId: string, status: TaskStatus, reason: string | null): Result<TaskRecord>;
  setWorkingCopy(taskId: string, dir: string, baseSha: string): void;
  setPurchaseAction(taskId: string, actionId: string): void;
  runningCount(projectId?: string | null): number;
  /** At startup: running attempts from a crashed process are abandoned (counted) and their tasks re-queued or failed. */
  recover(): string[];
}

export function createDelegationGovernor(o: { db: Db; clock?: Clock; limits?: Partial<DelegationLimits> }): DelegationGovernor {
  const { db } = o;
  const clock = o.clock ?? systemClock;
  const limits: DelegationLimits = Object.freeze({ ...DEFAULT_LIMITS, ...(o.limits ?? {}) });
  const getRow = (id: string) => db.prepare('SELECT * FROM delegation_tasks WHERE task_id = ?').get(id) as TaskRow | undefined;
  const get = (id: string) => {
    const r = getRow(id);
    return r ? toTask(r) : undefined;
  };
  const touch = (id: string, status: TaskStatus, reason: string | null) =>
    db.prepare('UPDATE delegation_tasks SET status = ?, status_reason = ?, updated_at = ? WHERE task_id = ?').run(status, reason, clock.nowIso(), id);
  const runningCount = (projectId?: string | null) =>
    projectId === undefined
      ? (db.prepare("SELECT COUNT(*) AS n FROM delegation_runs WHERE status = 'running'").get() as { n: number }).n
      : (db.prepare("SELECT COUNT(*) AS n FROM delegation_runs r JOIN delegation_tasks t ON t.task_id = r.task_id WHERE r.status = 'running' AND t.project_id IS ?").get(projectId) as { n: number }).n;

  return {
    limits,
    createTask(input, opts = {}) {
      const v = validateTaskInput(input, { now: clock.nowMs(), defaultDeadlineMinutes: limits.defaultDeadlineMinutes, ...(opts.extraExcludes ? { extraExcludes: opts.extraExcludes } : {}) });
      if (!v.ok) return v;
      const spec = v.value;
      const fp = objectiveFingerprint(spec);
      return withTransaction(db, (): Result<TaskRecord> => {
        let rootId: string;
        let depth = 0;
        if (spec.parentId) {
          const parent = getRow(spec.parentId);
          if (!parent) return limitErr('parent_not_found', `parent task ${spec.parentId} not found`);
          if (['succeeded', 'failed', 'cancelled'].includes(parent.status)) return limitErr('parent_closed', `parent task is ${parent.status}`);
          depth = parent.depth + 1;
          if (depth > limits.maxDepth) return limitErr('max_depth', `delegation depth ${depth} exceeds the maximum ${limits.maxDepth}`);
          // Walk the ancestry: the same objective/project anywhere above is a loop.
          let cur: TaskRow | undefined = parent;
          const seen = new Set<string>();
          while (cur) {
            if (seen.has(cur.task_id)) return limitErr('cycle', 'task ancestry is cyclic');
            seen.add(cur.task_id);
            if (cur.objective_fingerprint === fp) return limitErr('cycle', `objective repeats ancestor task ${cur.task_id}`, { ancestor: cur.task_id });
            cur = cur.parent_id ? getRow(cur.parent_id) : undefined;
          }
          rootId = parent.root_id;
          const n = (db.prepare('SELECT COUNT(*) AS n FROM delegation_tasks WHERE root_id = ?').get(rootId) as { n: number }).n;
          if (n >= limits.maxTasksPerRoot) return limitErr('root_task_budget', `root ${rootId} already has ${n} tasks (max ${limits.maxTasksPerRoot})`);
          if (spec.projectId !== parent.project_id && parent.project_id !== null) return perr('invalid_input', 'a child task cannot widen or change its parent project scope');
        } else rootId = '';
        const taskId = newId('tsk', clock);
        if (!rootId) rootId = taskId;
        const now = clock.nowIso();
        db.prepare(
          `INSERT INTO delegation_tasks (task_id, parent_id, root_id, depth, project_id, kind, objective_fingerprint, route, status, status_reason, attempts, max_attempts,
            deadline, spec_json, spec_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NULL,'queued',NULL,0,?,?,?,?,?,?)`,
        ).run(taskId, spec.parentId, rootId, depth, spec.projectId, spec.kind, fp, limits.maxAttemptsPerTask, spec.deadline, canonicalJson(spec), hashCanonical(spec), now, now);
        return ok(get(taskId)!);
      });
    },
    get,
    children: (id) => (db.prepare('SELECT * FROM delegation_tasks WHERE parent_id = ? ORDER BY created_at').all(id) as TaskRow[]).map(toTask),
    runs: (id) => (db.prepare('SELECT * FROM delegation_runs WHERE task_id = ? ORDER BY attempt').all(id) as RunRow[]).map(toRun),
    startAttempt(taskId, worker) {
      return withTransaction(db, (): Result<RunRecord> => {
        const t = getRow(taskId);
        if (!t) return perr('not_found', 'task not found');
        if (t.status !== 'queued') return limitErr('task_state', `task is ${t.status}`);
        if (clock.nowMs() >= Date.parse(t.deadline)) {
          touch(taskId, 'failed', 'deadline passed before the attempt started');
          return limitErr('deadline_passed', 'task deadline has passed');
        }
        if (t.attempts >= t.max_attempts) {
          touch(taskId, 'failed', 'retries exhausted');
          return limitErr('retries_exhausted', `task already used ${t.attempts} of ${t.max_attempts} attempts`);
        }
        const rootAttempts = (db.prepare('SELECT COUNT(*) AS n FROM delegation_runs r JOIN delegation_tasks t ON t.task_id = r.task_id WHERE t.root_id = ?').get(t.root_id) as { n: number }).n;
        if (rootAttempts >= limits.maxAttemptsPerRoot) {
          touch(taskId, 'failed', 'root attempt budget exhausted');
          return limitErr('root_attempt_budget', `root ${t.root_id} used ${rootAttempts} attempts (max ${limits.maxAttemptsPerRoot})`);
        }
        const all = runningCount();
        if (all >= limits.maxConcurrentWorkers) return limitErr('concurrency', `${all} workers already running (max ${limits.maxConcurrentWorkers})`);
        const proj = runningCount(t.project_id);
        if (t.project_id !== null && proj >= limits.maxConcurrentPerProject) return limitErr('concurrency', `${proj} workers already running for ${t.project_id}`);
        const id = newId('run', clock);
        const attempt = t.attempts + 1;
        db.prepare("INSERT INTO delegation_runs (id, task_id, attempt, worker, status, started_at) VALUES (?,?,?,?, 'running', ?)").run(id, taskId, attempt, worker, clock.nowIso());
        db.prepare("UPDATE delegation_tasks SET attempts = ?, status = 'running', status_reason = NULL, updated_at = ? WHERE task_id = ?").run(attempt, clock.nowIso(), taskId);
        return ok(toRun(db.prepare('SELECT * FROM delegation_runs WHERE id = ?').get(id) as RunRow));
      });
    },
    finishAttempt(runId, outcome, result) {
      return withTransaction(db, (): Result<TaskRecord> => {
        const r = db.prepare('SELECT * FROM delegation_runs WHERE id = ?').get(runId) as RunRow | undefined;
        if (!r) return perr('not_found', 'run not found');
        if (r.status !== 'running') return limitErr('task_state', `run is ${r.status}`);
        db.prepare('UPDATE delegation_runs SET status = ?, finished_at = ?, result_json = ? WHERE id = ?').run(outcome, clock.nowIso(), canonicalJson(result ?? null), runId);
        const t = getRow(r.task_id)!;
        if (t.status !== 'running') return ok(get(t.task_id)!);
        if (outcome === 'succeeded') touch(t.task_id, 'succeeded', null);
        else if (outcome === 'allowance_exhausted') touch(t.task_id, 'awaiting_owner', 'subscription allowance exhausted; paid usage needs owner approval');
        else if (t.attempts < t.max_attempts && clock.nowMs() < Date.parse(t.deadline)) touch(t.task_id, 'queued', `attempt ${t.attempts} ${outcome}; retry allowed`);
        else touch(t.task_id, 'failed', `attempt ${t.attempts} ${outcome}; no retries left (work preserved)`);
        return ok(get(t.task_id)!);
      });
    },
    setRoute(taskId, route) {
      db.prepare('UPDATE delegation_tasks SET route = ?, updated_at = ? WHERE task_id = ?').run(route, clock.nowIso(), taskId);
    },
    setStatus(taskId, status, reason) {
      return withTransaction(db, (): Result<TaskRecord> => {
        const t = getRow(taskId);
        if (!t) return perr('not_found', 'task not found');
        if (t.status === 'running' && status !== 'cancelled') return limitErr('task_state', 'task has a running attempt');
        touch(taskId, status, reason);
        if (status === 'cancelled') db.prepare("UPDATE delegation_runs SET status = 'abandoned', finished_at = ? WHERE task_id = ? AND status = 'running'").run(clock.nowIso(), taskId);
        return ok(get(taskId)!);
      });
    },
    setWorkingCopy(taskId, dir, baseSha) {
      db.prepare('UPDATE delegation_tasks SET working_copy = ?, base_sha = ?, updated_at = ? WHERE task_id = ?').run(dir, baseSha, clock.nowIso(), taskId);
    },
    setPurchaseAction(taskId, actionId) {
      db.prepare('UPDATE delegation_tasks SET purchase_action_id = ?, updated_at = ? WHERE task_id = ?').run(actionId, clock.nowIso(), taskId);
    },
    runningCount,
    recover() {
      return withTransaction(db, () => {
        const rows = db.prepare("SELECT * FROM delegation_runs WHERE status = 'running'").all() as RunRow[];
        for (const r of rows) {
          db.prepare("UPDATE delegation_runs SET status = 'abandoned', finished_at = ? WHERE id = ?").run(clock.nowIso(), r.id);
          const t = getRow(r.task_id)!;
          if (t.status === 'running') touch(t.task_id, t.attempts < t.max_attempts ? 'queued' : 'failed', 'worker process lost during restart (work preserved)');
        }
        return rows.map((r) => r.task_id);
      });
    },
  };
}
