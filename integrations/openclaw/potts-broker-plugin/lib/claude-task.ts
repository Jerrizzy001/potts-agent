/**
 * potts_claude / potts_claude_status: hand a task to Claude Code (the owner's own subscription login)
 * running headless in `--permission-mode auto` inside one project folder.
 *
 * - Runs in the background; one job at a time. The tool returns immediately with a job id.
 * - When Claude finishes, its summary goes straight to the owner's Telegram chat and a short note is
 *   added to the coordinator's session (report-relay.ts; owner-only by construction).
 * - Hard blocks on top of auto mode: no git push, no publishing/deploy commands, no rm -rf.
 *   A code-fix request is not deployment approval.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginConfig, SecretsProvider } from './config.ts';
import { relayWorkerReport, ownerReportText, parseWorkerReport, WORKER_REPORT_INSTRUCTIONS, type ReportedOutcome } from './report-relay.ts';
import { processAlive, recordTaskState, type TaskLifecycle } from './task-lifecycle.ts';
import { rpcCall } from './rpc.ts';
import { briefHasKeyMaterial, isWorkerEffort, WORKER_EFFORTS } from './worker-policy.ts';

interface ToolResult { content: { type: 'text'; text: string }[]; details: unknown }
const result = (text: string, details: unknown): ToolResult => ({ content: [{ type: 'text', text }], details });

export const CLAUDE_DISALLOWED = [
  'Bash(git push:*)', 'Bash(git push)', 'Bash(gh pr merge:*)', 'Bash(gh release:*)', 'Bash(npm publish:*)',
  'Bash(npx wrangler deploy:*)', 'Bash(wrangler deploy:*)', 'Bash(npm run deploy:*)', 'Bash(vercel:*)', 'Bash(rm -rf:*)',
];
export const CLAUDE_RULES = [
  'You are doing a task for Potts, the personal agent of the owner, the owner, on his Mac.',
  'Work in the named project and any other task-relevant file locations requested by the owner, including outside the Potts workspace. Make the change, run the relevant tests, and stop.',
  'For merge/deploy, prepare a committed candidate and request an exact approval-bound release through the Potts release helper. Do not run push/deploy commands directly. The broker runs independent registered checks, asks the owner once, then executes only the approved commit/target. A fix request is not approval to ship. Never send messages or emails.',
  `Release helper: node ${JSON.stringify(fileURLToPath(new URL('../../../../scripts/coordinator/release.ts', import.meta.url)))} request '{"projectId":"registered-id","operation":"merge","commit":"full-40-hex-SHA","branch":"main"}'. For deploy use operation deploy and targetId instead of branch. Query status with status '{"reviewId":"rel_..."}', then action '{"actionId":"act_..."}'. Missing project configuration is a specific setup blocker, not a permanent prohibition. Never modify the registry or approval state yourself.`,
  'Never delete files outside build output, and never touch credentials, keychains, ~/.ssh, ~/.openclaw or Potts config.',
  WORKER_REPORT_INSTRUCTIONS,
].join(' ');

/** Optional coding worker defaults; configure the runtime before enabling. */
export const CLAUDE_MODEL = 'claude-opus-5-5';
export const EFFORT_BY_KIND = { coding: 'medium', debugging: 'high', brainstorming: 'high', other: 'medium' } as const;
export type TaskKind = keyof typeof EFFORT_BY_KIND;

export interface JobRecord extends TaskLifecycle {
  id: string; kind?: TaskKind; effort?: string; task: string; project: string;
  status: 'queued' | 'running' | 'verifying' | 'done' | 'failed' | 'paused' | 'interrupted'; startedAt: string; finishedAt?: string; summary?: string; rawReport?: string; ownerMessage?: string; reportedOutcome?: ReportedOutcome; reportFormat?: 'structured' | 'fallback'; costUsd?: number;
  reportDelivery?: { status: 'pending' | 'delivered' | 'failed' | 'unavailable' | 'uncertain'; updatedAt: string };
  model?: string; observedModels?: string[]; launcherPid?: number; childPid?: number; recovered?: boolean; queuedAt?: string; sessionId?: string; attempt?: number; interruptRequested?: boolean; resumeVerified?: boolean;
}

export type Spawner = (cmd: string, args: string[], opts: { cwd: string; outFile: string; onExit: (code: number) => void; onSpawn?: (pid: number) => void }) => void | Promise<void>;
export const defaultSpawner: Spawner = (cmd, args, o) => new Promise<void>((resolve, reject) => {
  // The CLI's JSON is stdout only. Stream to files instead of keeping unbounded
  // chunks in the gateway heap or mixing stderr diagnostics into the result.
  let out: number | undefined;
  let err: number | undefined;
  try {
    out = openSync(o.outFile, 'w', 0o600);
    err = openSync(`${o.outFile}.stderr`, 'w', 0o600);
    const child = spawn(cmd, args, { cwd: o.cwd, stdio: ['ignore', out, err], env: { ...process.env, PATH: `${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` } });
    let started = false;
    let settled = false;
    const complete = (code: number) => { if (settled) return; settled = true;
      try { writeFileSync(`${o.outFile}.exit.json`, JSON.stringify({ code, finishedAt: new Date().toISOString() }), { mode: 0o600 }); } catch {}
      o.onExit(code); };
    child.once('spawn', () => { started = true; if (child.pid) o.onSpawn?.(child.pid); resolve(); });
    child.once('close', code => {
      if (!started) { settled = true; reject(new Error('process closed before launch')); }
      else complete(code ?? 1);
    });
    child.once('error', error => {
      if (!started) { settled = true; reject(error); }
      else complete(1);
    });
  } catch (error) {
    reject(error);
  } finally {
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
  }
});

export function createClaudeTools(cfg: PluginConfig, secrets: SecretsProvider, opts: { spawner?: Spawner; claudeCli?: string; openclawCli?: string; now?: () => Date; controls?: () => Promise<{ paused: boolean }>; interruptChild?: (pid: number) => void } = {}) {
  const spawner = opts.spawner ?? defaultSpawner;
  const claude = opts.claudeCli ?? join(homedir(), '.local', 'bin', 'claude');
  const openclaw = opts.openclawCli ?? join(homedir(), '.openclaw', 'bin', 'openclaw');
  const now = opts.now ?? (() => new Date());
  const jobsDir = join(cfg.pottsHome, 'claude-jobs');
  const recPath = (id: string) => join(jobsDir, id, 'job.json');
  const read = (id: string): JobRecord | null => { try { return JSON.parse(readFileSync(recPath(id), 'utf8')) as JobRecord; } catch { return null; } };
  const write = (r: JobRecord) => {
    recordTaskState(r, now().toISOString());
    const temp = `${recPath(r.id)}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(r, null, 2), { mode: 0o600 });
    renameSync(temp, recPath(r.id));
  };
  const list = (): JobRecord[] => (existsSync(jobsDir) ? readdirSync(jobsDir) : []).map(read).filter((r): r is JobRecord => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  function finish(job: JobRecord, outFile: string, code: number) {
    const current=read(job.id);
    if (!current || current.status !== 'running' || current.attempt !== job.attempt) return;
    Object.assign(job,current);
    job.status='verifying';write(job);
    let summary = '';
    let cost: number | undefined;
    try {
      const j = JSON.parse(readFileSync(outFile, 'utf8')) as { result?: unknown; is_error?: boolean; total_cost_usd?: number; modelUsage?: Record<string, unknown>; session_id?: string };
      if (typeof j.result !== 'string' || !j.result.trim()) throw new Error('result missing');
      summary = j.result.trim(); cost = j.total_cost_usd;
      if (job.interruptRequested && (code !== 0 || j.is_error)) {
        job.status='interrupted';job.finishedAt=now().toISOString();job.summary=summary;job.rawReport=summary;
        job.resumeVerified=!!job.sessionId && j.session_id===job.sessionId;job.executionUncertain=!job.resumeVerified;
        write(job);void startNext();return;
      }
      if (j.modelUsage) job.observedModels = Object.keys(j.modelUsage);
      if (j.is_error) code = code || 1;
    } catch {
      if (job.interruptRequested) {
        job.status='interrupted';job.executionUncertain=true;job.resumeVerified=false;
        job.summary='The task process exited, but I couldn’t verify its saved session. I won’t restart it automatically.';write(job);return;
      }
      summary = `The task ended without a readable completion report. I saved the diagnostics.`;
      code = code || 1;
    }
    job.status = code === 0 ? 'done' : 'failed'; job.finishedAt = now().toISOString(); job.rawReport = summary;
    const report = parseWorkerReport(summary);
    job.summary = report.detailedReport; job.ownerMessage = report.ownerMessage; job.reportedOutcome = report.reportedOutcome; job.reportFormat = report.reportFormat;
    if (cost !== undefined) job.costUsd = cost;
    deliver(job);
    void startNext();
  }

  function deliver(job: JobRecord) {
    const text = job.rawReport ?? job.summary ?? '';
    const executionStatus = job.status === 'done' ? 'done' : 'failed';
    job.ownerMessage = ownerReportText(text, executionStatus);
    job.reportDelivery = { status: 'pending', updatedAt: now().toISOString() };
    write(job);
    const delivery = (status: NonNullable<JobRecord['reportDelivery']>['status']) => {
      job.reportDelivery = { status, updatedAt: now().toISOString() };
      write(job);
    };
    void secrets.get().then((s) => {
      if (!s) { delivery('unavailable'); return; }
      return relayWorkerReport({
        spawner, cli: openclaw, cwd: jobsDir, relayLog: join(jobsDir, job.id, 'relay.log'), noteLog: join(jobsDir, job.id, 'note.log'),
        ownerId: s.ownerId, deliveryChannel: cfg.deliveryChannel, deliveryTarget: cfg.deliveryTarget, coordinatorAgentId: cfg.coordinatorAgentId, jobRef: `Claude job ${job.id}`, text, executionStatus, onDelivery: delivery,
      });
    }).catch(() => delivery('failed'));
  }

  const controls = opts.controls ?? (async () => {
    if (!cfg.readSocket) throw new Error('control state unavailable');
    const reply = await rpcCall(cfg.readSocket, 'capabilities.status', {}, { timeoutMs: 5000 });
    if (!reply.ok) throw new Error('control state unavailable');
    const c = (reply.result as { controls: { globalPaused: boolean; pausedIntegrations: string[] } }).controls;
    return { paused: c.globalPaused || c.pausedIntegrations.includes('delegation') };
  });
  async function launch(job: JobRecord) {
    job.status='running';job.startedAt=now().toISOString();job.launcherPid=process.pid;write(job);
    const outFile = join(jobsDir, job.id, job.attempt ? `output-${job.attempt}.json` : 'output.json');
    try {
      await spawner(claude, ['-p', job.attempt ? 'The owner explicitly resumed this interrupted task. Continue from the saved conversation and existing work. Check what already completed before continuing; never repeat side effects blindly.' : job.task, ...(job.attempt ? ['--resume', job.sessionId!] : ['--session-id', job.sessionId!]), '--model', CLAUDE_MODEL, '--effort', job.effort!, '--permission-mode', 'auto', '--output-format', 'json', '--append-system-prompt', CLAUDE_RULES, '--disallowedTools', ...CLAUDE_DISALLOWED],
        { cwd: job.project, outFile, onSpawn: pid => { const latest=read(job.id);if(latest?.status==='running' && latest.attempt===job.attempt){Object.assign(job,latest);job.childPid=pid;write(job);} }, onExit: code => finish(job,outFile,code) });
      return true;
    } catch {
      job.status='failed';job.finishedAt=now().toISOString();job.summary='I couldn’t start that task. No coding work was run.';write(job);deliver(job);return false;
    }
  }
  let draining = false;
  async function startNext() {
    if (draining) return;
    draining=true;
    try {
      for (;;) {
        if (list().some(j => j.status === 'running' || j.status === 'verifying' || j.executionUncertain)) return;
        const next = list().filter(j => j.status === 'queued').sort((a,b) => (a.queuedAt ?? a.startedAt).localeCompare(b.queuedAt ?? b.startedAt))[0];
        if (!next) return;
        try { if ((await controls()).paused) return; } catch { return; }
        const current = read(next.id);
        if (!current || current.status !== 'queued') continue;
        if (list().some(j => j.status === 'running' || j.status === 'verifying' || j.executionUncertain)) return;
        if (await launch(current)) return;
      }
    } finally { draining=false; }
  }
  let recovering: Promise<void> | undefined;
  function recover(): Promise<void> {
    if (recovering) return recovering;
    recovering = (async () => {
      for (const job of list()) {
        if (job.launcherPid && processAlive(job.launcherPid)) continue;
        if (job.reportDelivery?.status === 'pending') { job.reportDelivery.status='uncertain';write(job); }
        if (!['running','verifying'].includes(job.status) || processAlive(job.childPid)) continue;
        job.recovered=true;
        const output=join(jobsDir,job.id,job.attempt ? `output-${job.attempt}.json` : 'output.json');
        let code: number | undefined;
        try { code=JSON.parse(readFileSync(`${output}.exit.json`,'utf8')).code; } catch {}
        if (typeof code === 'number') { job.launcherPid=process.pid;job.status='running';write(job);finish(job,output,code); }
        else { job.status='interrupted';job.executionUncertain=true;job.summary='I lost track of this task after a restart. I haven’t restarted it because it may still be running.';write(job); }
      }
      await startNext();
    })().finally(() => { recovering=undefined; });
    return recovering;
  }
  async function control(p: Record<string, unknown>): Promise<ToolResult> {
    if (typeof p.jobId !== 'string' || !/^cc_[0-9]{14}(?:_[0-9a-f]{8})?$/.test(p.jobId) || !['pause','resume'].includes(String(p.action))) return result('Give me the exact task and choose pause or resume.', { ok:false });
    const job=read(p.jobId);
    if (!job) return result('I couldn’t find that task.', { ok:false, state:'not_found' });
    if (p.action === 'pause' && job.status === 'running') {
      if (job.interruptRequested) return result('I’m still checking that the task stopped.', {ok:false,state:'interrupt_pending',jobId:job.id,verified:false});
      if (job.launcherPid !== process.pid || !job.childPid || !job.sessionId) return result('I can’t safely stop this task through the current connection.', {ok:false,state:'unsupported',jobId:job.id,verified:false});
      job.interruptRequested=true;write(job);
      try { (opts.interruptChild ?? ((pid: number) => { process.kill(pid,'SIGINT'); }))(job.childPid); }
      catch { return result('I couldn’t confirm that the task stopped.', {ok:false,state:'unverified',jobId:job.id,verified:false}); }
      const stopped=read(job.id)!;
      return result(stopped.status==='interrupted' && stopped.resumeVerified ? 'Stopped. Your progress is saved; resuming will continue from there.' : 'I requested a stop and am waiting for its saved-session receipt.', {ok:stopped.status==='interrupted' && stopped.resumeVerified===true,state:stopped.status==='interrupted'?'interrupted':'interrupt_pending',jobId:job.id,verified:stopped.status==='interrupted' && stopped.resumeVerified===true});
    }
    if (p.action === 'resume' && job.status === 'interrupted' && job.resumeVerified && !job.executionUncertain) {
      job.attempt=(job.attempt ?? 0)+1;job.interruptRequested=false;job.resumeVerified=false;job.status='queued';job.finishedAt=undefined;job.reportDelivery=undefined;job.summary=undefined;job.rawReport=undefined;job.ownerMessage=undefined;job.reportedOutcome=undefined;job.reportFormat=undefined;write(job);await startNext();
      const actual=read(job.id)!;
      if(actual.status==='failed'||actual.status==='interrupted')return result('I couldn’t restart that task. Its saved progress is still available.',{ok:false,jobId:job.id,state:actual.status,verified:false,scope:'continuation'});
      return result(actual.status==='queued'?'Queued to continue from the saved conversation when a slot is available.':'Resumed from the saved conversation. I’ll check the existing work before continuing.', {ok:true,jobId:job.id,state:actual.status,verified:true,scope:'continuation'});
    }
    const expected=p.action === 'pause' ? 'paused' : 'queued';
    if (job.status === expected) return result('That task is already in the requested state.', { ok:true, jobId:job.id, state:job.status, verified:true });
    if (job.status !== (p.action === 'pause' ? 'queued' : 'paused')) return result('I can pause a task before it starts. This task has already started or finished, and this connection cannot safely pause and resume it.', { ok:false, state:'unsupported', jobId:job.id, actualState:job.status, verified:false });
    job.status=expected;write(job);
    if (read(job.id)?.status !== expected) return result('I couldn’t confirm the change.', { ok:false, state:'unverified', jobId:job.id });
    if (p.action === 'resume') await startNext();
    const actual=read(job.id)!;
    if(p.action==='resume' && (actual.status==='failed'||actual.status==='interrupted'))return result('I couldn’t start that task. I saved the details.',{ok:false,jobId:job.id,state:actual.status,verified:false,scope:'queue'});
    return result(p.action === 'pause' ? 'Paused. It won’t start until you resume it.' : 'Resumed. It will run as soon as a slot is available.', { ok:true, jobId:job.id, state:read(job.id)?.status, verified:true, scope:'queue' });
  }
  return Object.assign([
    {
      name: 'potts_claude',
      description: 'Hand a CODING task to Claude Code (Opus 5.5): writing or changing code, debugging, code review, or designing/planning software. For non-coding work use potts_delegate with worker sol. Include any verified inspection findings; do not guess what is wrong. Pass the owner\'s request in his own words plus any details he gave; Claude investigates itself. Runs in the background; releases go through the exact owner-approval broker; its report goes to the owner automatically. One job at a time.',
      parameters: { type: 'object', additionalProperties: false, required: ['task', 'kind'], properties: {
        task: { type: 'string', minLength: 10, maxLength: 8000, description: 'the owner\'s request, in his words, plus details he gave. No guesses.' },
        kind: { enum: ['coding', 'debugging', 'brainstorming'], description: 'coding = build/change code; debugging = code or an app is broken or failing; brainstorming = software design, architecture or technical plans.' },
        project: { type: 'string', maxLength: 1024, description: 'Absolute path of the code folder the owner named (any folder on the Mac, /tmp is fine). Omit for technical brainstorming with no repo.' },
        effort: { type: 'string', enum: WORKER_EFFORTS, description: 'Choose reasoning effort for this job; omitted preserves the task-kind default.' },
      } },
      async execute(_id: string, p: Record<string, unknown>): Promise<ToolResult> {
        const task = typeof p.task === 'string' ? p.task.trim() : '';
        if (briefHasKeyMaterial(task)) return result('Not started: the brief contains a key or token. Credentials belong in the agent authentication store, never in task briefs.', { ok: false });
        const kind: TaskKind = typeof p.kind === 'string' && p.kind in EFFORT_BY_KIND ? (p.kind as TaskKind) : 'other';
        if (p.effort !== undefined && !isWorkerEffort(p.effort)) return result('Not started: unsupported worker effort.', { ok: false });
        const effort = isWorkerEffort(p.effort) ? p.effort : EFFORT_BY_KIND[kind];
        const scratch = join(cfg.pottsHome, 'claude-scratch');
        if (!(typeof p.project === 'string' && p.project.trim())) mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const projRaw = typeof p.project === 'string' && p.project.trim() ? p.project.trim().replace(/^~(?=\/)/, homedir()) : scratch;
        if (task.length < 10) return result('Not started: give Claude a clear brief.', { ok: false });
        if (!projRaw.startsWith('/') || !existsSync(projRaw) || !statSync(projRaw).isDirectory()) return result(`Not started: ${projRaw || 'project'} is not a folder on this Mac.`, { ok: false });
        const project = realpathSync(projRaw);
        const isScratch = existsSync(scratch) && project === realpathSync(scratch);
        if ((!isScratch && /\/(\.ssh|\.openclaw|Library\/Keychains)(\/|$)|\/Application Support\/Potts(\/|$)/.test(project)) || project === homedir() || project === '/') return result('Not started: that folder is off limits for Claude jobs. Pick a project folder.', { ok: false });
        if (!existsSync(claude)) return result('Not started: Claude Code is not installed.', { ok: false });
        await recover();
        const jobs = list();
        if (jobs.some(j => ['queued','running','verifying','paused','interrupted'].includes(j.status) && j.task === task && j.project === project)) return result('That task is already waiting or running.', { ok: false, state: 'duplicate' });
        if (jobs.filter(j => j.status === 'queued' || j.status === 'paused').length >= 5) return result('Five tasks are already waiting. Please let one finish first.', { ok: false, state: 'queue_full' });
        try { if ((await controls()).paused) return result('Delegation is paused.', { ok: false, state: 'paused' }); } catch { return result('I can’t verify whether new tasks are allowed right now.', { ok: false }); }
        // Recheck after the asynchronous control lookup so concurrent admissions cannot overlap.
        if (list().some(j => ['queued','running','verifying','paused','interrupted'].includes(j.status) && j.task === task && j.project === project)) return result('That task is already waiting or running.', {ok:false,state:'duplicate'});
        if (list().filter(j => j.status === 'queued' || j.status === 'paused').length >= 5) return result('Five tasks are already waiting.', {ok:false,state:'queue_full'});
        const busy = list().some(j => j.status === 'running' || j.status === 'verifying' || j.executionUncertain);

        const id = `cc_${now().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`;
        mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
        mkdirSync(join(jobsDir, id), { mode: 0o700 });
        const job: JobRecord = { id, kind, effort, model: CLAUDE_MODEL, task, project, status: 'queued', startedAt: now().toISOString(), queuedAt: now().toISOString(), launcherPid: process.pid, sessionId: randomUUID() };
        write(job);
        if (busy) return result('Queued. I’ll start it when the current task finishes.', { ok: true, jobId: id, state: 'queued' });
        if (!(await launch(job))) return result(`Not started: Claude Code could not be launched (job ${id}).`, { ok: false, jobId: id });
        return result(`Work started. Acknowledge once in plain language only if not already acknowledged; do not narrate delegation or add approval disclaimers. The result will arrive automatically.`, { ok: true, jobId: id });
      },
    },
    {
      name: 'potts_claude_status',
      description: 'Check Claude Code jobs: running or finished, and the report of the latest (or a given) job.',
      parameters: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string', pattern: '^cc_[0-9]{14}(?:_[0-9a-f]{8})?$' } } },
      async execute(_id: string, p: Record<string, unknown>): Promise<ToolResult> {
        const jobs = list();
        const job = typeof p.jobId === 'string' ? jobs.find((j) => j.id === p.jobId) : jobs[0];
        if (!job) return result('No Claude jobs yet.', { ok: true, jobs: 0 });
        const report = job.reportDelivery ? ` Report delivery: ${job.reportDelivery.status}.${job.reportDelivery.status === 'failed' ? ' The report is available here; do not blindly resend it.' : ''}` : '';
        return result(`Job ${job.id}: ${job.status} (started ${job.startedAt}${job.finishedAt ? `, finished ${job.finishedAt}` : ''}) in ${job.project}.${report}${job.summary ? `\nReport:\n${job.summary.slice(0, 4000)}` : ''}`, { ok: true, job });
      },
    },
  ], { recover, control });
}

export const CLAUDE_TOOL_NAMES = ['potts_claude', 'potts_claude_status'] as const;
