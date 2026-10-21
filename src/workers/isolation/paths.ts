import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export class IsolationError extends Error {
  readonly code: 'invalid_option' | 'unsafe_path' | 'unavailable';
  constructor(code: 'invalid_option' | 'unsafe_path' | 'unavailable', message: string) {
    super(message);
    this.name = 'IsolationError';
    this.code = code;
  }
}

/** True when `child` is `parent` or below it (both already canonical). */
export function isWithin(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Paths a worker must never get read or write access to, even if a caller asks. */
export function sensitivePaths(home: string = homedir(), pottsHome?: string): string[] {
  const lib = join(home, 'Library');
  return [
    join(home, '.ssh'), join(home, '.gnupg'), join(home, '.aws'), join(home, '.config'), join(home, '.netrc'), join(home, '.npmrc'),
    join(home, '.docker'), join(home, '.kube'), join(home, '.claude'), join(home, '.openclaw'), join(home, '.lmstudio'),
    join(home, '.git-credentials'), join(home, '.zsh_history'), join(home, '.bash_history'),
    join(lib, 'Keychains'), join(lib, 'Messages'), join(lib, 'Mail'), join(lib, 'Cookies'), join(lib, 'Safari'),
    join(lib, 'Application Support'), join(lib, 'Containers'), join(lib, 'Group Containers'), join(lib, 'Preferences'),
    pottsHome ?? join(lib, 'Application Support', 'Potts'),
  ];
}

function canonical(p: string, what: string): string {
  if (typeof p !== 'string' || !isAbsolute(p)) throw new IsolationError('invalid_option', `${what} must be an absolute path`);
  if (!existsSync(p)) throw new IsolationError('invalid_option', `${what} does not exist`);
  return realpathSync(p);
}

/**
 * Validates a root the worker may write below (workspace root, worker home)
 * or read (toolchains): canonical (symlinks resolved), not too broad, does not
 * contain the owner's home, does not overlap a protected location.
 */
export function checkGrantPath(p: string, what: string, o: { home?: string; pottsHome?: string } = {}): string {
  const home = realpathSync(o.home ?? homedir());
  const r = canonical(p, what);
  if (r.split(sep).filter(Boolean).length < 2) throw new IsolationError('unsafe_path', `${what} is too close to the filesystem root`);
  if (isWithin(home, r)) throw new IsolationError('unsafe_path', `${what} must not contain the owner's home directory`);
  for (const s0 of sensitivePaths(home, o.pottsHome)) {
    const s = existsSync(s0) ? realpathSync(s0) : s0;
    if (isWithin(r, s) || isWithin(s, r)) throw new IsolationError('unsafe_path', `${what} overlaps a protected location`);
  }
  return r;
}

/**
 * Resolves the job workspace for a cwd: the first directory below
 * `workspaceRoot` on the way to cwd (or the root itself when cwd is the root).
 * Each job only gets write access to its own workspace, not its siblings.
 */
export function resolveJobWorkspace(workspaceRoot: string, cwd: string): { cwd: string; workspace: string } {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new IsolationError('invalid_option', 'cwd must be absolute');
  if (!existsSync(cwd)) throw new IsolationError('invalid_option', `cwd does not exist: ${cwd}`);
  const real = realpathSync(cwd);
  if (!statSync(real).isDirectory()) throw new IsolationError('invalid_option', 'cwd must be a directory');
  if (!isWithin(real, workspaceRoot)) throw new IsolationError('unsafe_path', 'cwd is outside the worker workspace root');
  const rel = relative(workspaceRoot, real);
  const first = rel.split(sep).filter(Boolean)[0];
  return { cwd: real, workspace: first ? join(workspaceRoot, first) : workspaceRoot };
}
