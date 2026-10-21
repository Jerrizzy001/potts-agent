import { execFile } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnBounded } from '../../delegation/runner.ts';
import { checkGrantPath, IsolationError, isWithin } from './paths.ts';
import { DEFAULT_PATH, CLT_DIR, prepareSandboxedRun } from './sandbox-runner.ts';
import type { IsolatedRunner, IsolationAuditSink, IsolationEnforcement, RunResult, RunSpec } from './types.ts';

/** Defaults match deploy/isolation/create-worker-user.sh. */
export const WORKER_DEFAULTS = {
  user: 'potts-worker',
  home: '/Users/potts-worker',
  wrapper: '/usr/local/libexec/potts/potts-worker-run',
  jobsRoot: '/Users/Shared/potts-jobs',
  sudo: '/usr/bin/sudo',
} as const;

/** ACL granted on adopted workspaces (same set the setup script puts on the jobs root). */
export const WORKER_ACL_PERMS = 'read,write,append,execute,delete,list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit';

export interface DedicatedUserRunnerOptions {
  user?: string;
  workerHome?: string;
  wrapper?: string;
  jobsRoot?: string;
  sudo?: string;
  readOnlyPaths?: string[];
  machServices?: string[];
  strictNetwork?: boolean;
  audit?: IsolationAuditSink;
}

function execP(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) })),
  );
}

/**
 * Runs jobs as the dedicated `potts-worker` macOS user through the root-owned
 * wrapper allowed by a single sudoers rule, with the Seatbelt profile applied
 * inside. The exact env goes through a per-job file in the job workspace
 * (never argv, which `ps` shows to every local user); the wrapper reads and
 * deletes it.
 *
 * Timeout: the wrapper's perl alarm (spec.timeoutMs) ends the job as the
 * worker uid. The outer kill (timeout + 5 s, or abort) can only reach the
 * owner-side sudo process; the worker-side job is bounded by the alarm.
 */
export function createDedicatedUserRunner(o: DedicatedUserRunnerOptions = {}): IsolatedRunner & { available(): Promise<{ ok: true } | { ok: false; reason: string }> } {
  const user = o.user ?? WORKER_DEFAULTS.user;
  const workerHome = o.workerHome ?? WORKER_DEFAULTS.home;
  const wrapper = o.wrapper ?? WORKER_DEFAULTS.wrapper;
  const jobsRoot = o.jobsRoot ?? WORKER_DEFAULTS.jobsRoot;
  const sudo = o.sudo ?? WORKER_DEFAULTS.sudo;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new IsolationError('invalid_option', 'bad worker user name');
  const enforcement: IsolationEnforcement = Object.freeze({ osUser: user, filesystem: true, network: true });
  const baseEnv: Record<string, string> = { HOME: workerHome, TMPDIR: join(workerHome, '.tmp'), USER: user, LOGNAME: user, LANG: 'en_US.UTF-8', PATH: DEFAULT_PATH };
  if (existsSync(CLT_DIR)) baseEnv.DEVELOPER_DIR = CLT_DIR;

  const root = () => {
    if (!existsSync(jobsRoot)) throw new IsolationError('unavailable', `jobs root ${jobsRoot} missing (run deploy/isolation/create-worker-user.sh --apply)`);
    return realpathSync(jobsRoot);
  };

  return {
    id: 'dedicated-user',
    enforcement,
    get workspaceRoot() {
      return existsSync(jobsRoot) ? realpathSync(jobsRoot) : jobsRoot;
    },
    baseEnv: Object.freeze(baseEnv),
    async available() {
      if (process.platform !== 'darwin') return { ok: false, reason: 'macOS only' };
      if ((await execP('/usr/bin/id', ['-u', user])).code !== 0) return { ok: false, reason: `user ${user} does not exist (run deploy/isolation/create-worker-user.sh --apply)` };
      if (!existsSync(wrapper)) return { ok: false, reason: `wrapper ${wrapper} not installed` };
      if (!existsSync(jobsRoot)) return { ok: false, reason: `jobs root ${jobsRoot} missing` };
      if ((await execP(sudo, ['-n', '-u', user, '-l', wrapper])).code !== 0) return { ok: false, reason: 'sudoers rule for the wrapper is missing (sudo -n -l failed)' };
      return { ok: true };
    },
    async adoptWorkspace(dir) {
      const r = root();
      const real = realpathSync(dir);
      if (!isWithin(real, r) || real === r) throw new IsolationError('unsafe_path', 'adoptWorkspace: directory must be inside the jobs root');
      // Directories created inside the jobs root inherit the worker ACL; moved-in trees do not, so grant explicitly.
      const res = await execP('/bin/chmod', ['-R', '+a', `user:${user} allow ${WORKER_ACL_PERMS}`, real]);
      if (res.code !== 0) throw new IsolationError('unavailable', `could not grant ${user} access to the workspace: ${res.stderr.slice(0, 200)}`);
    },
    async run(spec: RunSpec, signal?: AbortSignal): Promise<RunResult> {
      const r0 = root();
      const readOnlyPaths = (o.readOnlyPaths ?? []).map((p, i) => checkGrantPath(p, `readOnlyPaths[${i}]`));
      const prep = prepareSandboxedRun(spec, { root: r0, sharedWritable: [workerHome], readOnlyPaths, machServices: o.machServices ?? [], strictNetwork: o.strictNetwork === true, osUser: user });
      if (prep.workspace === r0) throw new IsolationError('unsafe_path', 'cwd must be inside a job directory under the jobs root, not the root itself');
      const envFile = join(prep.workspace, `.potts-env-${process.pid}-${Math.random().toString(36).slice(2)}`);
      const lines = Object.entries(spec.env).map(([k, v]) => {
        if (/[\n\r\u0000]/.test(v)) throw new IsolationError('invalid_option', `env ${k} contains a newline`);
        return `${k}=${v}`;
      });
      writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
      // 0600 owner file: the worker reads it through the inherited ACL on the jobs root.
      try {
        const timeoutSec = Math.max(1, Math.ceil(spec.timeoutMs / 1000));
        const r = await spawnBounded({
          spec: {
            ...spec,
            cwd: prep.cwd,
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
            timeoutMs: spec.timeoutMs + 5000,
            argv: [sudo, '-n', '-u', user, wrapper, '--workspace', prep.workspace, '--cwd', prep.cwd, '--timeout-sec', String(timeoutSec), '--env-file', envFile, '--profile-b64', Buffer.from(prep.profile).toString('base64'), '--', ...spec.argv],
          },
          ...(signal ? { signal } : {}),
          enforcement: prep.enforcement,
        });
        const timedOut = r.timedOut || r.signal === 'SIGALRM' || r.exitCode === 142;
        o.audit?.({ runner: 'dedicated-user', osUser: user, executable: spec.argv[0]!, argCount: spec.argv.length - 1, cwd: prep.cwd, network: spec.network.mode, exitCode: r.exitCode, signal: r.signal, timedOut, durationMs: r.durationMs, ...(spec.label ? { label: spec.label } : {}) });
        return { ...r, timedOut, network: spec.network };
      } finally {
        rmSync(envFile, { force: true });
      }
    },
  };
}
