/**
 * WP-2 worker isolation entry module. Implements WP-6's IsolatedRunner
 * contract (src/delegation/runner.ts).
 */
export * from './types.ts';
export * from './paths.ts';
export * from './sandbox-profile.ts';
export { createSandboxExecRunner, prepareSandboxedRun, SANDBOX_EXEC, DEFAULT_PATH, CLT_DIR, type SandboxExecRunnerOptions } from './sandbox-runner.ts';
export * from './dedicated-user-runner.ts';

import { createDedicatedUserRunner, type DedicatedUserRunnerOptions } from './dedicated-user-runner.ts';
import { createSandboxExecRunner } from './sandbox-runner.ts';
import type { IsolatedRunner } from './types.ts';

/**
 * Returns the dedicated potts-worker runner when the owner has set it up.
 * Otherwise, only if `allowSameUserFallback` is set (development), a
 * Seatbelt-only runner as the current user (enforcement.osUser = null).
 */
export async function selectIsolatedRunner(o: DedicatedUserRunnerOptions & { allowSameUserFallback?: { workspaceRoot: string } } = {}): Promise<{ runner: IsolatedRunner; note: string }> {
  const { allowSameUserFallback, ...dopts } = o;
  const dedicated = createDedicatedUserRunner(dopts);
  const d = await dedicated.available();
  if (d.ok) return { runner: dedicated, note: 'dedicated potts-worker user + sandbox-exec' };
  if (!allowSameUserFallback) throw new Error(`dedicated worker user unavailable: ${d.reason}`);
  const sbx = createSandboxExecRunner({ workspaceRoot: allowSameUserFallback.workspaceRoot, ...(o.audit ? { audit: o.audit } : {}) });
  return { runner: sbx, note: `sandbox-exec only, same uid as the owner (dedicated user unavailable: ${d.reason})` };
}
