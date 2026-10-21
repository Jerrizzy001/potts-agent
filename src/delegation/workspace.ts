/**
 * Isolated working copies. Potts (trusted) makes a fresh clone of the
 * registered repository for each task:
 *
 *   git clone --no-hardlinks --local <repoPath> <workspace>/<taskId>/work
 *
 * A clone (not `git worktree add`) so the worker never shares the owner's
 * .git (objects, config, hooks, refs). Remotes are removed, so the copy has
 * nowhere to push. Untracked files (the owner's `output/`, `.env*`) are never
 * part of a clone; if a credential-like path is TRACKED, the copy is refused.
 * The owner's checkout is only read (`--no-optional-locks`, no index
 * refresh) and is verified unchanged afterwards.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gitOk, porcelainStatus, revParse } from './git.ts';
import { matchesAny } from './glob.ts';
import { DEFAULT_WORKING_COPY_EXCLUDES, EXAMPLE_FILE_RE, type ProjectEntry } from './projects.ts';
import type { IsolatedRunner } from './runner.ts';

export interface WorkingCopy {
  taskId: string;
  projectId: string;
  dir: string;
  baseSha: string;
  branch: string;
  /** Owner checkout state at copy time (informational: unrelated work is preserved there). */
  ownerCheckout: { head: string | null; dirtyEntries: number };
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const TASK_DIR_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Lists files under dir (repo-relative, posix), skipping .git. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (d === dir && name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out;
}

/** Paths in a tree that must never reach a worker copy. */
export function forbiddenPaths(files: readonly string[], project: Pick<ProjectEntry, 'workingCopy'>): string[] {
  const globs = [...DEFAULT_WORKING_COPY_EXCLUDES, ...(project.workingCopy?.excludePatterns ?? [])];
  return files.filter((f) => !EXAMPLE_FILE_RE.test(f) && matchesAny(f, globs));
}

export interface CloneOptions {
  /** Source repository (owner checkout or a Potts evidence repo). */
  source: string;
  dest: string;
  /** Commit to check out on a fresh local branch. */
  sha: string;
  branch: string;
}

/** Fresh clone with no hardlinks and no remotes, checked out at an exact commit. Trusted code only. */
export async function cloneDetached(o: CloneOptions): Promise<void> {
  if (existsSync(o.dest)) throw new WorkspaceError(`destination already exists: ${o.dest}`);
  await gitOk(['clone', '--quiet', '--no-hardlinks', '--local', '--no-checkout', '--', o.source, o.dest], { timeoutMs: 600_000 });
  for (const r of (await gitOk(['remote'], { cwd: o.dest })).split('\n').filter(Boolean)) await gitOk(['remote', 'remove', r], { cwd: o.dest });
  await gitOk(['checkout', '--quiet', '-B', o.branch, o.sha], { cwd: o.dest });
  const remotes = await gitOk(['remote'], { cwd: o.dest });
  if (remotes) throw new WorkspaceError('clone still has remotes');
  const head = await revParse(o.dest, 'HEAD');
  if (head !== o.sha) throw new WorkspaceError(`clone HEAD ${head} != ${o.sha}`);
}

export interface CreateWorkingCopyOptions {
  project: ProjectEntry;
  taskId: string;
  runner: IsolatedRunner;
  /** Ref in the owner's repo to base on (default: project.defaultBranch). */
  baseRef?: string;
}

/** Creates the worker's working copy and hands it to the worker identity. */
export async function createWorkingCopy(o: CreateWorkingCopyOptions): Promise<WorkingCopy> {
  if (!TASK_DIR_RE.test(o.taskId)) throw new WorkspaceError('bad task id');
  const repo = o.project.repoPath;
  if (!existsSync(join(repo, '.git'))) throw new WorkspaceError(`registered repoPath is not a git checkout: ${repo}`);
  const ref = o.baseRef ?? `refs/heads/${o.project.defaultBranch}`;
  const baseSha = await revParse(repo, ref);
  if (!baseSha) throw new WorkspaceError(`cannot resolve ${ref} in the registered repository`);
  const before = { head: await revParse(repo, 'HEAD'), status: await porcelainStatus(repo) };
  const taskDir = join(o.runner.workspaceRoot, o.taskId);
  const dir = join(taskDir, 'work');
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const branch = `potts/${o.taskId}`;
  try {
    await cloneDetached({ source: repo, dest: dir, sha: baseSha, branch });
    const bad = forbiddenPaths(listFiles(dir), o.project);
    if (bad.length) throw new WorkspaceError(`repository tracks credential-like or excluded paths; refusing to hand it to a worker: ${bad.slice(0, 10).join(', ')}`);
    await o.runner.adoptWorkspace(dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const after = { head: await revParse(repo, 'HEAD'), status: await porcelainStatus(repo) };
  if (after.head !== before.head || after.status !== before.status) throw new WorkspaceError('the owner checkout changed while the working copy was created; refusing to continue');
  return {
    taskId: o.taskId, projectId: o.project.id, dir, baseSha, branch,
    ownerCheckout: { head: before.head, dirtyEntries: before.status ? before.status.split('\n').filter(Boolean).length : 0 },
  };
}
