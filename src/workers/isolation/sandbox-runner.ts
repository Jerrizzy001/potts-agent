import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkerEnvSafe, permittedSecretNames, spawnBounded } from '../../delegation/runner.ts';
import { checkGrantPath, IsolationError, isWithin, resolveJobWorkspace } from './paths.ts';
import { buildSandboxProfile, mapNetworkPolicy } from './sandbox-profile.ts';
import type { IsolatedRunner, IsolationAuditSink, IsolationEnforcement, RunResult, RunSpec } from './types.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';
export const CLT_DIR = '/Library/Developer/CommandLineTools';

export interface SandboxExecRunnerOptions {
  /** Root under which job workspaces live (created 0700 if missing). Must not overlap protected locations. */
  workspaceRoot: string;
  /** Extra read-only roots (toolchains, e.g. ~/.local/share/claude). */
  readOnlyPaths?: string[];
  /** Extra Mach services (e.g. "com.apple.trustd.agent" for TLS). Default none. */
  machServices?: string[];
  /** Refuse hostname allowlists instead of opening *:port with enforcement.network=false. */
  strictNetwork?: boolean;
  audit?: IsolationAuditSink;
  /** Tests: override the owner's home / Potts home used by the protected-path checks. */
  home?: string;
  pottsHome?: string;
}


/**
 * Shared by both runners: validates the spec, picks the job workspace, and
 * builds the Seatbelt profile (job workspace + shared writable dirs writable,
 * everything under /Users etc. unreadable except those and read-only roots).
 */
export function prepareSandboxedRun(
  spec: RunSpec,
  ctx: { root: string; sharedWritable: string[]; readOnlyPaths: string[]; machServices: string[]; strictNetwork: boolean; osUser: string | null },
): { cwd: string; workspace: string; profile: string; enforcement: IsolationEnforcement } {
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every((a) => typeof a === 'string' && !a.includes('\u0000')))
    throw new IsolationError('invalid_option', 'argv must be a non-empty string array');
  if (!(Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0 && spec.timeoutMs <= 6 * 3600_000)) throw new IsolationError('invalid_option', 'timeoutMs out of range');
  if (!spec.env || typeof spec.env !== 'object') throw new IsolationError('invalid_option', 'env required (exact environment)');
  assertWorkerEnvSafe(spec.env, permittedSecretNames(spec));
  const { cwd, workspace } = resolveJobWorkspace(ctx.root, spec.cwd);
  const net = mapNetworkPolicy(spec.network);
  if (!net.enforced && ctx.strictNetwork) throw new IsolationError('invalid_option', `hostname allowlists cannot be enforced by Seatbelt (${net.hostnames.join(', ')}); use localhost:<port> via a filtering proxy`);
  const machServices = [...ctx.machServices];
  const profile = buildSandboxProfile({
    writablePaths: [workspace, ...ctx.sharedWritable.filter((p) => !isWithin(p, workspace))],
    readOnlyPaths: ctx.readOnlyPaths,
    network: net.mode,
    networkAllow: net.allow,
    machServices,
  });
  return { cwd, workspace, profile, enforcement: Object.freeze({ osUser: ctx.osUser, filesystem: true, network: net.enforced }) };
}

/**
 * Seatbelt-only runner, as the CURRENT user (enforcement.osUser = null).
 * Use for development and as the inner layer; the dedicated-user runner is
 * the real boundary.
 */
export function createSandboxExecRunner(o: SandboxExecRunnerOptions): IsolatedRunner & { available(): Promise<{ ok: true } | { ok: false; reason: string }> } {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) throw new IsolationError('unavailable', 'sandbox-exec is not available on this machine');
  mkdirSync(o.workspaceRoot, { recursive: true, mode: 0o700 });
  const grant = { ...(o.home ? { home: o.home } : {}), ...(o.pottsHome ? { pottsHome: o.pottsHome } : {}) };
  const root = checkGrantPath(realpathSync(o.workspaceRoot), 'workspaceRoot', grant);
  const readOnlyPaths = (o.readOnlyPaths ?? []).map((p, i) => checkGrantPath(p, `readOnlyPaths[${i}]`, grant));
  const home = join(root, '.home');
  const tmp = join(root, '.tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const baseEnv: Record<string, string> = {
    HOME: home, TMPDIR: tmp, USER: process.env.USER ?? 'worker', LOGNAME: process.env.USER ?? 'worker', LANG: 'en_US.UTF-8', PATH: DEFAULT_PATH,
  };
  // Without DEVELOPER_DIR the /usr/bin python3/git shims need the per-user temp dir (blocked by the profile).
  if (existsSync(CLT_DIR)) baseEnv.DEVELOPER_DIR = CLT_DIR;
  const runner = {
    id: 'sandbox-exec',
    enforcement: Object.freeze({ osUser: null, filesystem: true, network: true }) as IsolationEnforcement,
    workspaceRoot: root,
    baseEnv: Object.freeze(baseEnv),
    async adoptWorkspace(dir: string) {
      const real = realpathSync(dir);
      if (!isWithin(real, root)) throw new IsolationError('unsafe_path', 'adoptWorkspace: directory is outside the workspace root');
    },
    async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
      const probe = mkdtempSync(join(root, 'probe-'));
      try {
        const r = await runner.run({ argv: ['/usr/bin/true'], cwd: probe, env: { PATH: DEFAULT_PATH }, network: { mode: 'none' }, timeoutMs: 10_000 });
        return r.exitCode === 0 ? { ok: true } : { ok: false, reason: `probe failed: ${r.stderr.slice(0, 200) || r.spawnError}` };
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    },
    async run(spec: RunSpec, signal?: AbortSignal): Promise<RunResult> {
      const prep = prepareSandboxedRun(spec, { root, sharedWritable: [home, tmp], readOnlyPaths, machServices: o.machServices ?? [], strictNetwork: o.strictNetwork === true, osUser: null });
      const profDir = mkdtempSync(join(tmpdir(), 'potts-sbx-'));
      const profFile = join(profDir, 'profile.sb');
      writeFileSync(profFile, prep.profile, { mode: 0o600 });
      try {
        const r = await spawnBounded({
          spec: { ...spec, cwd: prep.cwd, argv: [SANDBOX_EXEC, '-f', profFile, ...spec.argv] },
          ...(signal ? { signal } : {}),
          enforcement: prep.enforcement,
        });
        o.audit?.({ runner: 'sandbox-exec', osUser: null, executable: spec.argv[0]!, argCount: spec.argv.length - 1, cwd: prep.cwd, network: spec.network.mode, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, durationMs: r.durationMs, ...(spec.label ? { label: spec.label } : {}) });
        return r;
      } finally {
        rmSync(profDir, { recursive: true, force: true });
      }
    },
  };
  return runner;
}
