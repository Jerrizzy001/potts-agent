import { readFileSync, statSync } from 'node:fs';
import { hashCanonical } from '../core/hash.ts';
import { validateSchema, type JsonSchema } from '../core/schema.ts';
import { ok, perr, type Result } from '../core/result.ts';

/**
 * Owner policy document. OWNERSHIP RULE: only the owner edits this file. The
 * model, OpenClaw plugin and workers must not be able to write it (WP-2
 * provides the OS boundary: separate account / file ownership). The broker
 * loads it read-only, refuses group/world-writable files, and binds every
 * approval to its version AND content hash, so any edit invalidates approvals.
 */
export interface PolicyDocument {
  policyVersion: string;
  description?: string;
  /** Default lifetime of an approval. */
  approvalTtlSeconds: number;
  /** Hard ceiling for any approval lifetime. */
  maxApprovalTtlSeconds: number;
  ownerAlert: { destination: string; maxAttemptsPerIncident: number; retryIntervalSeconds: number };
  support: { mode: 'shadow' | 'active'; registeredChannels: string[]; approvedKnowledgeIds: string[] };
  /** When true, scoped actions must carry scope.taskId. */
  scopedRequireTask: boolean;
}

export interface LoadedPolicy {
  readonly doc: Readonly<PolicyDocument>;
  readonly version: string;
  /** sha256 of the canonical JSON document. */
  readonly hash: string;
  readonly sourcePath?: string;
}

const POLICY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['policyVersion', 'approvalTtlSeconds', 'maxApprovalTtlSeconds', 'ownerAlert', 'support', 'scopedRequireTask'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    policyVersion: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
    description: { type: 'string' },
    approvalTtlSeconds: { type: 'integer', minimum: 60, maximum: 2592000 },
    maxApprovalTtlSeconds: { type: 'integer', minimum: 60, maximum: 2592000 },
    ownerAlert: {
      type: 'object',
      required: ['destination', 'maxAttemptsPerIncident', 'retryIntervalSeconds'],
      additionalProperties: false,
      properties: {
        destination: { type: 'string', minLength: 1 },
        maxAttemptsPerIncident: { type: 'integer', minimum: 1, maximum: 10 },
        retryIntervalSeconds: { type: 'integer', minimum: 30 },
      },
    },
    support: {
      type: 'object',
      required: ['mode', 'registeredChannels', 'approvedKnowledgeIds'],
      additionalProperties: false,
      properties: {
        mode: { enum: ['shadow', 'active'] },
        registeredChannels: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        approvedKnowledgeIds: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
    },
    scopedRequireTask: { type: 'boolean' },
  },
};

export const DEFAULT_POLICY: PolicyDocument = {
  policyVersion: '2026-10-06.1',
  approvalTtlSeconds: 86400,
  maxApprovalTtlSeconds: 604800,
  ownerAlert: { destination: 'owner', maxAttemptsPerIncident: 3, retryIntervalSeconds: 300 },
  support: { mode: 'shadow', registeredChannels: [], approvedKnowledgeIds: [] },
  scopedRequireTask: true,
};

export function buildPolicy(doc: unknown, sourcePath?: string): Result<LoadedPolicy> {
  const issues = validateSchema(doc, POLICY_SCHEMA);
  if (issues.length) return perr('policy_invalid', `policy invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const d = doc as PolicyDocument;
  if (d.approvalTtlSeconds > d.maxApprovalTtlSeconds) return perr('policy_invalid', 'approvalTtlSeconds exceeds maxApprovalTtlSeconds');
  const frozen = Object.freeze(structuredClone(d));
  return ok(Object.freeze({ doc: frozen, version: d.policyVersion, hash: hashCanonical(d), ...(sourcePath ? { sourcePath } : {}) }));
}

/**
 * Loads the owner policy file. Refuses files that are group/world writable or
 * not owned by the current uid (best-effort check; real isolation is WP-2's
 * OS boundary). If expectedVersion is given (from config), it must match.
 */
export function loadPolicyFile(path: string, opts: { expectedVersion?: string; skipOwnershipCheck?: boolean } = {}): Result<LoadedPolicy> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return perr('policy_invalid', `policy file not found: ${path}`);
  }
  if (!opts.skipOwnershipCheck) {
    if ((st.mode & 0o022) !== 0) return perr('policy_file_insecure', `policy file ${path} is group/world writable (mode ${(st.mode & 0o777).toString(8)}); chmod 600`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      return perr('policy_file_insecure', `policy file ${path} is not owned by the broker's user`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return perr('policy_invalid', `cannot parse policy: ${(e as Error).message}`);
  }
  const r = buildPolicy(doc, path);
  if (r.ok && opts.expectedVersion && r.value.version !== opts.expectedVersion)
    return perr('policy_invalid', `policy version ${r.value.version} does not match configured ${opts.expectedVersion}`);
  return r;
}
