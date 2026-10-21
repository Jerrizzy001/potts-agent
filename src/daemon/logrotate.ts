/**
 * Size-based rotation for the daemon's stdout/stderr logs in $POTTS_HOME/logs
 * (launchd StandardOutPath / StandardErrorPath).
 *
 * launchd keeps the log file descriptors open for the life of the process, so
 * a rename would leave the daemon writing into the rotated file. Rotation is
 * therefore copy-then-truncate: the current content is copied to `<name>.1`
 * (older generations shift to `.2` ... `.<keep>`, the oldest is removed) and
 * the live file is truncated in place. launchd opens these files with
 * O_APPEND, so writes continue at the new end of file. Every file touched is
 * chmod 0600. A few lines written between copy and truncate can be lost; that
 * is accepted for diagnostics logs (the audit ledger is the record of truth).
 */
import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

export interface LogRotationConfig {
  /** Rotate a file once it is larger than this many bytes. Default 10 MiB. */
  maxBytes: number;
  /** Rotated generations to keep (`.1` … `.keep`). Default 5. */
  keep: number;
  /** File names inside the log directory. Default daemon.out.log, daemon.err.log. */
  files: string[];
}

export const DEFAULT_LOG_ROTATION: LogRotationConfig = { maxBytes: 10 * 1024 * 1024, keep: 5, files: ['daemon.out.log', 'daemon.err.log'] };

export interface RotationResult {
  rotated: string[];
  removed: string[];
}

const size = (p: string): number | null => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};

const secure = (p: string) => {
  try {
    chmodSync(p, 0o600);
  } catch {
    /* file vanished */
  }
};

export function rotateLogs(dir: string, cfg: Partial<LogRotationConfig> = {}): RotationResult {
  const c: LogRotationConfig = { ...DEFAULT_LOG_ROTATION, ...cfg };
  if (!Number.isInteger(c.keep) || c.keep < 1) throw new Error('log rotation keep must be a positive integer');
  const out: RotationResult = { rotated: [], removed: [] };
  for (const name of c.files) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid log file name ${name}`);
    const live = join(dir, name);
    const n = size(live);
    if (n === null) continue;
    secure(live);
    if (n <= c.maxBytes) continue;
    // Drop generations beyond `keep` (including stale ones left by a larger earlier keep).
    for (let i = c.keep; i < c.keep + 50; i++) {
      const p = `${live}.${i}`;
      if (!existsSync(p)) {
        if (i > c.keep) break;
        continue;
      }
      rmSync(p, { force: true });
      out.removed.push(p);
    }
    for (let i = c.keep - 1; i >= 1; i--) {
      const from = `${live}.${i}`;
      if (existsSync(from)) {
        renameSync(from, `${live}.${i + 1}`);
        secure(`${live}.${i + 1}`);
      }
    }
    copyFileSync(live, `${live}.1`);
    secure(`${live}.1`);
    truncateSync(live, 0);
    secure(live);
    out.rotated.push(live);
  }
  return out;
}
