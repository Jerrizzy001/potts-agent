/**
 * IsolatedRunner: the interface WP-6 needs from WP-2's OS isolation boundary
 * (`src/workers/isolation/`, a dedicated restricted macOS user).
 *
 * Contract for a real implementation (WP-2):
 *  - `run()` executes `argv` (no shell) AS THE WORKER IDENTITY, in `cwd`, with
 *    EXACTLY `env` (nothing inherited), under `network` policy, killed after
 *    `timeoutMs` (whole process group), with stdout/stderr capped.
 *  - `cwd` must resolve inside `workspaceRoot`; anything else is refused.
 *  - `adoptWorkspace(dir)` hands a directory that trusted Potts code created
 *    (a fresh clone) to the worker identity (chown/ACL), so the worker can
 *    write it while Potts' own state stays unreadable to the worker.
 *  - `enforcement` reports honestly what the boundary enforces. Callers that
 *    need a real boundary (the Claude Code adapter) refuse a runner whose
 *    `osUser` is null unless explicitly configured for tests.
 *
 * This file ships the interface plus `createLocalTestRunner`, which runs as
 * the CURRENT user and enforces only cwd confinement, env exactness, timeouts
 * and output caps. It is for tests and development only.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { REDACTED, redact } from '../core/log.ts';

export type NetworkPolicy = { mode: 'none' } | { mode: 'allowlist'; hosts: string[] };

export interface IsolationEnforcement {
  /** macOS user the command runs as; null = runs as the calling user (no OS boundary). */
  osUser: string | null;
  /** Filesystem confinement beyond cwd checks (e.g. separate user, sandbox profile). */
  filesystem: boolean;
  /** Whether `network` is actually enforced (vs. recorded only). */
  network: boolean;
}

export interface RunSpec {
  /** argv[0] is the executable; never interpreted by a shell. */
  argv: string[];
  /** Absolute working directory; must be inside the runner's workspaceRoot. */
  cwd: string;
  /** The complete environment. Nothing is inherited from the caller. */
  env: Record<string, string>;
  network: NetworkPolicy;
  timeoutMs: number;
  /** Cap per stream (default 1 MiB). */
  maxOutputBytes?: number;
  stdin?: string;
  /** Short label for logs/evidence (e.g. "test:unit"). */
  label?: string;
  /**
   * Secret-looking env names deliberately passed to this one invocation. Only
   * names in WORKER_PERMITTED_SECRET_ENV are accepted (the subscription OAuth
   * token for the Claude Code process); test/build commands never get any.
   */
  secretEnvNames?: string[];
}

/** The only credential a worker process may ever receive: Claude Code's subscription OAuth token. */
export const WORKER_PERMITTED_SECRET_ENV: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

export function permittedSecretNames(spec: RunSpec): string[] {
  const names = spec.secretEnvNames ?? [];
  for (const n of names) if (!WORKER_PERMITTED_SECRET_ENV.includes(n)) throw new WorkerEnvError(`secret env ${n} may not be given to a worker`);
  return names;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  /** Error starting the process (ENOENT etc.), if any. */
  spawnError: string | null;
  enforcement: IsolationEnforcement;
  network: NetworkPolicy;
}

export interface IsolatedRunner {
  readonly id: string;
  readonly enforcement: IsolationEnforcement;
  /** Directory under which worker-owned workspaces live. */
  readonly workspaceRoot: string;
  /**
   * The worker identity's own baseline environment (HOME, USER, TMPDIR, PATH,
   * LANG...). Callers pick from it by allowlist; Potts' own env is never used.
   */
  readonly baseEnv: Readonly<Record<string, string>>;
  adoptWorkspace(dir: string): Promise<void>;
  run(spec: RunSpec, signal?: AbortSignal): Promise<RunResult>;
}

/** Names that select separately billed model access; never forwarded to any worker. */
export const FORBIDDEN_WORKER_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS',
]);
const SECRETISH_ENV = /token|secret|passw(or)?d|api[-_]?key|private[-_]?key|cookie|credential|auth/i;

export class WorkerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerEnvError';
  }
}

/**
 * Rejects an environment that would hand a worker credentials or switch it to
 * separately billed model access. `allowSecretNames` lists the only
 * secret-looking names permitted for this particular invocation (e.g.
 * CLAUDE_CODE_OAUTH_TOKEN for the Claude Code process, never for tests).
 */
export function assertWorkerEnvSafe(env: Record<string, string>, allowSecretNames: readonly string[] = []): void {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') throw new WorkerEnvError(`env ${k} must be a string`);
    if (FORBIDDEN_WORKER_ENV.has(k)) throw new WorkerEnvError(`env ${k} is never given to a worker`);
    if (allowSecretNames.includes(k)) continue;
    if (SECRETISH_ENV.test(k)) throw new WorkerEnvError(`env ${k} looks like a credential; workers get none`);
    if (redact(v) !== v) throw new WorkerEnvError(`env ${k} holds a token-shaped value`);
  }
}

/** Builds an exact env from an allowlist of names read from `source` (the runner's baseEnv), plus fixed values. */
export function buildWorkerEnv(allowlist: readonly string[], source: Readonly<Record<string, string | undefined>>, fixed: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowlist) {
    const v = source[name];
    if (typeof v === 'string') out[name] = v;
  }
  return { ...out, ...fixed };
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export interface SpawnBoundedOptions {
  spec: RunSpec;
  signal?: AbortSignal;
  enforcement: IsolationEnforcement;
}

/** Spawns argv with an exact env, process-group kill on timeout/abort and capped output. */
export function spawnBounded({ spec, signal, enforcement }: SpawnBoundedOptions): Promise<RunResult> {
  const max = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();
  return new Promise((resolveP) => {
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (r: Omit<RunResult, 'enforcement' | 'network' | 'durationMs' | 'stdout' | 'stderr' | 'outputTruncated' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveP({
        ...r,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errb).toString('utf8'),
        outputTruncated: truncated,
        timedOut,
        durationMs: Date.now() - started,
        enforcement,
        network: spec.network,
      });
    };
    try {
      child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ exitCode: null, signal: null, spawnError: (e as Error).message });
      return;
    }
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, spec.timeoutMs);
    const onAbort = () => killTree();
    signal?.addEventListener('abort', onAbort);
    const take = (chunk: Buffer, which: 'out' | 'err') => {
      const len = which === 'out' ? outLen : errLen;
      const room = max - len;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (chunk.length > room) truncated = true;
      if (which === 'out') {
        out.push(piece);
        outLen += piece.length;
      } else {
        errb.push(piece);
        errLen += piece.length;
      }
    };
    child.stdout!.on('data', (c: Buffer) => take(c, 'out'));
    child.stderr!.on('data', (c: Buffer) => take(c, 'err'));
    child.stdin!.on('error', () => {});
    if (spec.stdin !== undefined) child.stdin!.end(spec.stdin);
    else child.stdin!.end();
    child.on('error', (e) => finish({ exitCode: null, signal: null, spawnError: e.message }));
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig, spawnError: null }));
  });
}

function validateSpec(spec: RunSpec, root: string): string {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every((a) => typeof a === 'string')) throw new Error('runner: argv must be a non-empty string array');
  if (!isAbsolute(spec.cwd)) throw new Error('runner: cwd must be absolute');
  let real: string;
  try {
    real = realpathSync(spec.cwd);
  } catch {
    throw new Error(`runner: cwd does not exist: ${spec.cwd}`);
  }
  if (!isInside(root, real)) throw new Error('runner: cwd is outside the worker workspace root');
  if (!(spec.timeoutMs > 0)) throw new Error('runner: timeoutMs required');
  return real;
}

export interface LocalTestRunnerOptions {
  workspaceRoot: string;
}

/**
 * Development/test runner: runs as the current user. Enforces cwd
 * confinement, exact env (with the worker env guard), timeouts and output
 * caps. Network policy is recorded but NOT enforced (enforcement.network=false).
 */
export function createLocalTestRunner(o: LocalTestRunnerOptions): IsolatedRunner {
  mkdirSync(o.workspaceRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(o.workspaceRoot);
  const enforcement: IsolationEnforcement = Object.freeze({ osUser: null, filesystem: false, network: false });
  const home = resolve(root, '.home');
  const tmp = resolve(root, '.tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const baseEnv = Object.freeze({
    HOME: home, TMPDIR: tmp, USER: process.env.USER ?? 'worker', LOGNAME: process.env.USER ?? 'worker', LANG: 'en_US.UTF-8',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  });
  return {
    id: 'local-test',
    enforcement,
    workspaceRoot: root,
    baseEnv,
    async adoptWorkspace(dir) {
      const real = realpathSync(dir);
      if (!isInside(root, real)) throw new Error('adoptWorkspace: directory is outside the workspace root');
    },
    async run(spec, signal) {
      const cwd = validateSpec(spec, root);
      assertWorkerEnvSafe(spec.env, permittedSecretNames(spec));
      return spawnBounded({ spec: { ...spec, cwd: resolve(cwd) }, ...(signal ? { signal } : {}), enforcement });
    },
  };
}

/** Last `n` characters of command output, redacted, for evidence and reports. */
export function outputTail(s: string, n = 4000): string {
  const t = s.length > n ? `…${s.slice(-n)}` : s;
  const r = redact(t) as string;
  return r.replace(/(password|secret|token)\s*[:=]\s*\S+/gi, `$1=${REDACTED}`);
}
