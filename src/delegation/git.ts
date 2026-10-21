/**
 * Git helper for TRUSTED Potts code. It runs as the Potts/broker identity, so
 * it must only ever be pointed at repositories whose config Potts controls:
 * the owner's registered checkout (read-only commands), Potts' own evidence
 * clones and the release executor's clean checkouts. It is never run inside a
 * worker-writable working copy (a worker could plant config such as
 * core.fsmonitor or a filter driver that would execute as Potts); commands in
 * worker copies go through the IsolatedRunner as the worker identity.
 *
 * Hardening: no system/global config, hooks disabled, fsmonitor disabled, no
 * external diff or textconv, no terminal prompts, fixed locale.
 */
import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  /** Extra environment (e.g. author dates). Never secrets except in the release executor. */
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
}

const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never'];

export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

export function git(args: string[], o: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...HARDEN, ...args],
      { cwd: o.cwd, env: gitEnv(o.env), timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

export class GitError extends Error {
  readonly result: GitResult;
  constructor(args: string[], r: GitResult) {
    // Only the subcommand is named: arguments can contain remote URLs.
    super(`git ${args[0] ?? ''} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`);
    this.name = 'GitError';
    this.result = r;
  }
}

/** Runs git and throws GitError on a non-zero exit. Returns trimmed stdout. */
export async function gitOk(args: string[], o: GitOptions = {}): Promise<string> {
  const r = await git(args, o);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout.trim();
}

export const SHA_RE = /^[0-9a-f]{40}$/;

/** Resolves a ref in a repository to a full commit SHA, or null. */
export async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
  const s = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(s) ? s : null;
}

/** Head of `branch` on a remote (URL or path) via ls-remote, or null if absent. */
export async function remoteBranchHead(remote: string, branch: string, env: Record<string, string> = {}): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await gitOk(['ls-remote', '--', remote, ref], { env, timeoutMs: 60_000 });
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha && SHA_RE.test(sha)) return sha;
  }
  return null;
}

/** `git status --porcelain` without taking optional locks (does not rewrite the index). */
export async function porcelainStatus(repo: string): Promise<string> {
  return gitOk(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo });
}
