/**
 * Minimal path glob used by the project registry (CI workflow paths, release
 * check paths, working-copy exclusions). Supports `**` (any number of path
 * segments), `*` (within a segment) and `?`. Paths are repo-relative with `/`.
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

export function matchesAny(path: string, globs: readonly string[], caseInsensitive = false): boolean {
  return globs.some((g) => globToRegExp(g, caseInsensitive).test(path));
}
