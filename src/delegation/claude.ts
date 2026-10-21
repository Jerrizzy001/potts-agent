/**
 * Claude Code adapter: runs `claude -p` headless INSIDE the isolated worker
 * (through the IsolatedRunner, as the worker identity) against the task's
 * working copy.
 *
 * Restrictions (defence in depth on top of the OS boundary):
 *  --restricted               no command tools unless named, file tools confined
 *                             to the working dir, user/project settings ignored
 *  --tools <list>             only Read/Glob/Grep (+Edit/Write, +Bash) per task
 *  --permission-mode dontAsk  anything not pre-allowed is denied, never prompted
 *  --permission-prompts none
 *  --allowed-tools            Bash only for the registered test/build commands
 *                             and read-only git (status/diff/log)
 *  --disallowed-tools         web, sub-agents, git push/remote, curl, gh, wrangler...
 *  --strict-mcp-config        no MCP servers; --no-chrome; --disable-slash-commands
 *  --no-session-persistence   transcript not kept in the worker's home
 *  --output-format json       single result object (summary, turns, session id)
 *
 * Billing: never `--bare` (it forces API-key auth). The env never carries
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / Bedrock / Vertex switches (the
 * runner's env guard rejects them); the only credential allowed is the
 * subscription CLAUDE_CODE_OAUTH_TOKEN, if configured.
 *
 * Time budget: the runner's timeout kills the whole process group. The
 * installed CLI (2.1.282) does not document --max-turns, so turns are bounded
 * by time; extra flags can be added through `extraArgs` once verified.
 */
import type { TaskSpec } from './task.ts';
import type { ProjectEntry } from './projects.ts';
import type { HandoffBrief } from './brief.ts';
import { allowedCommandsFor } from './brief.ts';
import { buildWorkerEnv, outputTail, type IsolatedRunner, type NetworkPolicy, type RunResult } from './runner.ts';

export interface ClaudeCodeConfig {
  /** Executable name or absolute path as seen by the worker identity. */
  command: string;
  model?: string;
  timeoutSeconds: number;
  /** Hosts the Claude Code process may reach. */
  networkAllowlist: string[];
  /** `claude auth status --json` authMethod values accepted as subscription auth. */
  acceptedAuthMethods: string[];
  /** Verified extra CLI flags (e.g. a turn limit once confirmed for the installed version). */
  extraArgs?: string[];
  /** Allow a runner without an OS user boundary (tests only). */
  allowUnisolatedRunner?: boolean;
}

export const DEFAULT_CLAUDE_CONFIG: ClaudeCodeConfig = Object.freeze({
  command: 'claude',
  timeoutSeconds: 3600,
  networkAllowlist: ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'statsig.anthropic.com'],
  acceptedAuthMethods: ['claude.ai', 'oauth_token'],
});

export type WorkerStatus = 'completed' | 'error' | 'timeout' | 'allowance_exhausted' | 'unparseable' | 'spawn_failed';

export interface WorkerClaim {
  summary: string | null;
  testsPassed: boolean | null;
  testsRun: { command: string; exitCode: number | null }[];
  filesChanged: string[];
  unfinished: string[];
}

export interface WorkerResult {
  worker: 'claude_code';
  status: WorkerStatus;
  exitCode: number | null;
  durationMs: number;
  /** Worker's own account. Recorded, never trusted. */
  claim: WorkerClaim;
  transcript: { sessionId: string | null; numTurns: number | null; reportedCostUsd: number | null; isError: boolean | null; resultTail: string; stderrTail: string };
  args: string[];
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const EDIT_TOOLS = ['Edit', 'Write'];
export const DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit',
  'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)', 'Bash(git clone:*)', 'Bash(git config:*)', 'Bash(git commit:*)',
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(gh:*)', 'Bash(npx:*)', 'Bash(wrangler:*)', 'Bash(npm publish:*)',
  'Bash(security:*)', 'Bash(osascript:*)', 'Bash(open:*)', 'Bash(sudo:*)', 'Bash(claude:*)',
];
const READ_ONLY_GIT = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];

const shellQuoteFree = (argv: string[]) => argv.every((a) => /^[A-Za-z0-9_./:=@%+,-]+$/.test(a));

export function claudeArgs(spec: TaskSpec, project: ProjectEntry | null, cfg: ClaudeCodeConfig): string[] {
  const tools = [...READ_TOOLS];
  if (spec.permittedActions.includes('edit_working_copy')) tools.push(...EDIT_TOOLS);
  const cmds = allowedCommandsFor(spec, project).filter((c) => shellQuoteFree(c.argv));
  const allowed = [...tools, ...READ_ONLY_GIT, ...cmds.map((c) => `Bash(${c.argv.join(' ')})`)];
  tools.push('Bash');
  const args = [
    '-p',
    '--output-format', 'json',
    '--restricted',
    '--tools', tools.join(','),
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--allowed-tools', ...allowed,
    '--disallowed-tools', ...DISALLOWED_TOOLS,
    '--strict-mcp-config',
    '--no-chrome',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.extraArgs?.length) args.push(...cfg.extraArgs);
  return args;
}

const ALLOWANCE_RE = /usage limit|limit reached|rate limit|out of (extra )?usage|credit balance is too low|exceeded your (current )?quota|upgrade your plan/i;

function lastJsonObject(s: string): Record<string, unknown> | null {
  const t = s.trim();
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const lines = t.split('\n').reverse();
  for (const l of lines) {
    if (!l.trim().startsWith('{')) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Parses the worker's final ```json block (its claim). Missing/invalid fields become null/empty. */
export function parseClaim(resultText: string): WorkerClaim {
  const blocks = [...resultText.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const empty: WorkerClaim = { summary: null, testsPassed: null, testsRun: [], filesChanged: [], unfinished: [] };
  const last = blocks.at(-1)?.[1];
  if (!last) return { ...empty, summary: resultText.trim().slice(0, 2000) || null };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(last) as Record<string, unknown>;
  } catch {
    return { ...empty, summary: resultText.trim().slice(0, 2000) || null };
  }
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : []);
  return {
    summary: typeof j.summary === 'string' ? j.summary.slice(0, 4000) : null,
    testsPassed: typeof j.testsPassed === 'boolean' ? j.testsPassed : null,
    testsRun: Array.isArray(j.testsRun)
      ? j.testsRun.slice(0, 50).map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return { command: typeof o.command === 'string' ? o.command.slice(0, 500) : '', exitCode: typeof o.exitCode === 'number' ? o.exitCode : null };
      })
      : [],
    filesChanged: strs(j.filesChanged),
    unfinished: strs(j.unfinished),
  };
}

export function interpretClaudeRun(run: RunResult, args: string[]): WorkerResult {
  const base = { worker: 'claude_code' as const, exitCode: run.exitCode, durationMs: run.durationMs, args };
  const emptyClaim: WorkerClaim = { summary: null, testsPassed: null, testsRun: [], filesChanged: [], unfinished: [] };
  const tx = { sessionId: null, numTurns: null, reportedCostUsd: null, isError: null, resultTail: '', stderrTail: outputTail(run.stderr, 2000) };
  if (run.spawnError) return { ...base, status: 'spawn_failed', claim: emptyClaim, transcript: { ...tx, resultTail: run.spawnError } };
  if (run.timedOut) return { ...base, status: 'timeout', claim: emptyClaim, transcript: { ...tx, resultTail: outputTail(run.stdout, 2000) } };
  const j = lastJsonObject(run.stdout);
  if (!j) {
    const status: WorkerStatus = ALLOWANCE_RE.test(run.stdout + run.stderr) ? 'allowance_exhausted' : 'unparseable';
    return { ...base, status, claim: emptyClaim, transcript: { ...tx, resultTail: outputTail(run.stdout, 2000) } };
  }
  const resultText = typeof j.result === 'string' ? j.result : '';
  const isError = j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success');
  const transcript = {
    sessionId: typeof j.session_id === 'string' ? j.session_id : null,
    numTurns: typeof j.num_turns === 'number' ? j.num_turns : null,
    reportedCostUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    isError,
    resultTail: outputTail(resultText, 4000),
    stderrTail: tx.stderrTail,
  };
  let status: WorkerStatus = 'completed';
  if (isError || run.exitCode !== 0) status = ALLOWANCE_RE.test(resultText + run.stderr) ? 'allowance_exhausted' : 'error';
  return { ...base, status, claim: parseClaim(resultText), transcript };
}

export interface AuthCheck {
  ok: boolean;
  authMethod: string | null;
  reason: string;
}

export interface ClaudeCodeAdapter {
  readonly target: 'claude_code';
  /** Verifies the worker identity is signed in with subscription auth (not an API key). */
  checkAuth(env: Record<string, string>, cwd: string): Promise<AuthCheck>;
  run(input: { spec: TaskSpec; project: ProjectEntry; brief: HandoffBrief; workingDir: string; oauthToken?: string | null }, signal?: AbortSignal): Promise<WorkerResult>;
}

export function createClaudeCodeAdapter(o: { runner: IsolatedRunner; config?: Partial<ClaudeCodeConfig> }): ClaudeCodeAdapter {
  const cfg: ClaudeCodeConfig = { ...DEFAULT_CLAUDE_CONFIG, ...(o.config ?? {}) };
  if (o.runner.enforcement.osUser === null && !cfg.allowUnisolatedRunner)
    throw new Error('Claude Code adapter requires an IsolatedRunner with an OS user boundary (WP-2); refusing an unisolated runner');
  const network: NetworkPolicy = { mode: 'allowlist', hosts: [...cfg.networkAllowlist] };
  const envFor = (project: ProjectEntry | null, token?: string | null) => {
    const env = buildWorkerEnv(project?.worker.envAllowlist ?? ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'], o.runner.baseEnv, {
      ...(project?.worker.env ?? {}),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
  };
  return {
    target: 'claude_code',
    async checkAuth(env, cwd) {
      const r = await o.runner.run({ argv: [cfg.command, 'auth', 'status', '--json'], cwd, env, network, timeoutMs: 30_000, label: 'claude-auth', ...(env.CLAUDE_CODE_OAUTH_TOKEN ? { secretEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'] } : {}) });
      const j = lastJsonObject(r.stdout);
      if (!j) return { ok: false, authMethod: null, reason: 'could not read `claude auth status --json`' };
      const method = typeof j.authMethod === 'string' ? j.authMethod : null;
      if (j.loggedIn !== true) return { ok: false, authMethod: method, reason: 'worker identity is not signed in to Claude Code' };
      if (typeof j.apiProvider === 'string' && j.apiProvider !== 'firstParty') return { ok: false, authMethod: method, reason: `provider ${j.apiProvider} is separately billed` };
      if (!method || /api[_-]?key/i.test(method) || !cfg.acceptedAuthMethods.includes(method))
        return { ok: false, authMethod: method, reason: `auth method ${method ?? 'unknown'} is not an accepted subscription method` };
      return { ok: true, authMethod: method, reason: 'subscription auth' };
    },
    async run(input, signal) {
      const args = claudeArgs(input.spec, input.project, cfg);
      const env = envFor(input.project, input.oauthToken);
      const res = await o.runner.run(
        {
          argv: [cfg.command, ...args], cwd: input.workingDir, env, network, timeoutMs: cfg.timeoutSeconds * 1000, stdin: input.brief.text, label: 'claude-code',
          maxOutputBytes: 4 * 1024 * 1024, ...(input.oauthToken ? { secretEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'] } : {}),
        },
        signal,
      );
      return interpretClaudeRun(res, args);
    },
  };
}

/** Env used for the auth check (same as a run, without a prompt). */
export function claudeEnvForCheck(runner: IsolatedRunner, project: ProjectEntry | null, token?: string | null): Record<string, string> {
  const env = buildWorkerEnv(project?.worker.envAllowlist ?? ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'], runner.baseEnv, { ...(project?.worker.env ?? {}), DISABLE_AUTOUPDATER: '1' });
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}
