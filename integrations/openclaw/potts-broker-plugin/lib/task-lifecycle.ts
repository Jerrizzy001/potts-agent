/** Durable local activity is evidence about orchestration, never invented worker progress. */
export type TaskPhase = 'queued' | 'running' | 'progress' | 'success' | 'failure' | 'interrupted' | 'paused';
export interface TaskLifecycle {
  status: string;
  phase?: TaskPhase;
  activity?: { at: string; phase: TaskPhase; detail: string }[];
  executionUncertain?: boolean;
}
export function recordTaskState(job: TaskLifecycle, at: string) {
  const phase: TaskPhase = job.status === 'done' ? 'success' : job.status === 'failed' ? 'failure' : job.status === 'verifying' ? 'progress' : job.status as TaskPhase;
  if (job.phase === phase) return;
  job.phase = phase;
  const detail: Record<TaskPhase, string> = {
    queued: 'Accepted and waiting to start; work is not complete.',
    running: 'Execution started; no completion receipt yet.',
    progress: 'Execution returned; checking its completion evidence.',
    success: 'A successful completion receipt was verified.',
    failure: 'Execution failed or its completion evidence could not be verified.',
    interrupted: 'Execution outcome is unknown; never replay automatically.',
    paused: 'This queued task will not start until resumed.',
  };
  job.activity = [...(job.activity ?? []), { at, phase, detail: detail[phase] }];
}
export function processAlive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
