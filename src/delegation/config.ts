/**
 * Reads the `projects` and `delegation` sections of a loaded Potts config
 * (already schema-validated by core) and fills defaults. Used by WP-8 wiring.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import type { LoadedConfig } from '../core/config.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { DEFAULT_CLAUDE_CONFIG, type ClaudeCodeConfig } from './claude.ts';
import { DEFAULT_LIMITS, type DelegationLimits } from './governor.ts';
import { DEFAULT_PAID_GUARD, type PaidGuardConfig } from './paid.ts';
import { loadProjectsFile, type ProjectRegistry } from './projects.ts';
import { DEFAULT_ROUTING, type RoutingConfig } from './routing.ts';

export interface DelegationConfig {
  limits: DelegationLimits;
  routing: RoutingConfig;
  claudeCode: ClaudeCodeConfig & { enabled: boolean; billing: 'subscription' | 'separately_billed'; oauthTokenRef: string | null };
  external: { mode: 'manual' | 'verified_route'; routeEvidence: string | null };
  paid: PaidGuardConfig;
}

type Raw = {
  limits?: Partial<DelegationLimits>;
  routing?: Partial<RoutingConfig>;
  claudeCode?: Partial<ClaudeCodeConfig> & { enabled?: boolean; billing?: 'subscription' | 'separately_billed'; oauthTokenRef?: string };
  external?: { mode?: 'manual' | 'verified_route'; routeEvidence?: string };
  paidUsage?: { onAllowanceExhausted?: 'wait' | 'propose_purchase' };
};

export function resolveDelegationConfig(cfg: { readonly [section: string]: unknown }): DelegationConfig {
  const d = (cfg.delegation ?? {}) as Raw;
  const cc = d.claudeCode ?? {};
  const billing = cc.billing ?? 'subscription';
  return {
    limits: { ...DEFAULT_LIMITS, ...(d.limits ?? {}) },
    routing: { ...DEFAULT_ROUTING, ...(d.routing ?? {}) },
    claudeCode: {
      ...DEFAULT_CLAUDE_CONFIG,
      ...(cc.command ? { command: cc.command } : {}),
      ...(cc.model ? { model: cc.model } : {}),
      ...(cc.timeoutSeconds ? { timeoutSeconds: cc.timeoutSeconds } : {}),
      ...(cc.networkAllowlist ? { networkAllowlist: [...cc.networkAllowlist] } : {}),
      ...(cc.acceptedAuthMethods ? { acceptedAuthMethods: [...cc.acceptedAuthMethods] } : {}),
      ...(cc.extraArgs ? { extraArgs: [...cc.extraArgs] } : {}),
      enabled: cc.enabled === true,
      billing,
      oauthTokenRef: cc.oauthTokenRef ?? null,
    },
    external: { mode: d.external?.mode ?? 'manual', routeEvidence: d.external?.routeEvidence ?? null },
    paid: {
      billing: { ...DEFAULT_PAID_GUARD.billing, claude_code: billing },
      onAllowanceExhausted: d.paidUsage?.onAllowanceExhausted ?? DEFAULT_PAID_GUARD.onAllowanceExhausted,
    },
  };
}

/** Loads the projects registry named by config.projects.file (relative to the config file). */
export function loadProjectsForConfig(cfg: LoadedConfig): Result<ProjectRegistry> {
  const section = cfg.projects as { file?: string } | undefined;
  if (!section?.file) return perr('config_invalid', 'config has no projects.file');
  const base = cfg.sourcePath ? dirname(cfg.sourcePath) : process.cwd();
  const path = isAbsolute(section.file) ? section.file : resolve(base, section.file);
  const r = loadProjectsFile(path);
  return r.ok ? ok(r.value) : r;
}
