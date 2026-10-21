/**
 * The IsolatedRunner contract is owned by WP-6 (src/delegation/runner.ts);
 * WP-2 implements it here:
 *
 *  - createSandboxExecRunner   macOS Seatbelt profile, runs as the CURRENT
 *    user (enforcement.osUser = null, filesystem = true, network = true for
 *    'none' / port-form allowlists). Development / second layer only: callers
 *    that need a real boundary refuse it because osUser is null.
 *  - createDedicatedUserRunner `sudo -n -u potts-worker <root-owned wrapper>`
 *    plus the same Seatbelt profile inside (osUser = 'potts-worker'). Needs
 *    deploy/isolation/create-worker-user.sh run once by the owner.
 *
 * Network: Seatbelt filters outbound TCP only as "localhost:<port>" or
 * "*:<port>" (no hostnames). A NetworkPolicy allowlist whose entries all have
 * that form is enforced exactly. Hostname entries ("api.anthropic.com") cannot
 * be enforced by Seatbelt: they open "*:443" and the run reports
 * enforcement.network = false (or are refused with `strictNetwork: true`).
 * Hostname filtering needs a filtering proxy on localhost.
 */
export type { IsolatedRunner, IsolationEnforcement, NetworkPolicy, RunResult, RunSpec } from '../../delegation/runner.ts';
export { assertWorkerEnvSafe, permittedSecretNames, WorkerEnvError, WORKER_PERMITTED_SECRET_ENV, FORBIDDEN_WORKER_ENV } from '../../delegation/runner.ts';

/** Optional audit hook: one record per run (no output bodies, no env values). */
export interface IsolationRunRecord {
  runner: string;
  osUser: string | null;
  executable: string;
  argCount: number;
  cwd: string;
  network: 'none' | 'allowlist';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  label?: string;
}
export type IsolationAuditSink = (r: IsolationRunRecord) => void;
