import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Runtime home: private state outside Git (DB, sockets, policy, logs).
 * POTTS_HOME overrides; default ~/Library/Application Support/Potts/.
 */
export function resolvePottsHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POTTS_HOME;
  if (override && override.trim()) {
    return isAbsolute(override) ? override : resolve(override);
  }
  return join(homedir(), 'Library', 'Application Support', 'Potts');
}

export interface PottsPaths {
  home: string;
  db: string;
  policy: string;
  runDir: string;
  /** Socket for propose/status/list (OpenClaw plugin). */
  brokerSocket: string;
  /** Socket for trusted owner ingress only. */
  ingressSocket: string;
  logsDir: string;
}

export function pottsPaths(home: string): PottsPaths {
  return {
    home,
    db: join(home, 'potts.db'),
    policy: join(home, 'policy.json'),
    runDir: join(home, 'run'),
    brokerSocket: join(home, 'run', 'broker.sock'),
    ingressSocket: join(home, 'run', 'ingress.sock'),
    logsDir: join(home, 'logs'),
  };
}

/** Creates (or tightens) a directory with mode 0700. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Ensures the home and its run/logs subdirectories exist with mode 0700. */
export function ensurePottsHome(home: string = resolvePottsHome()): PottsPaths {
  const paths = pottsPaths(home);
  ensurePrivateDir(home);
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(paths.logsDir);
  return paths;
}
