import { canonicalJson, hashCanonical, SHA256_HEX } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { ActionScope } from './decide.ts';

/** An attachment is referenced by name + content hash; bytes stay with the connector. */
export interface AttachmentRef {
  name: string;
  sha256: string;
}

/** What a proposer (model plugin, trusted job, owner instruction) submits. */
export interface ActionInput {
  kind: string;
  accountId?: string | null;
  /** Exact recipients/targets (email addresses, phone numbers, branch@repo, deploy target...). */
  destination?: string[];
  /** JSON payload: message body, commit sha, artifact digest, etc. */
  payload?: unknown;
  attachments?: AttachmentRef[];
  scope?: ActionScope | null;
  /** Free-text rationale shown to the owner; NOT part of the approval binding and never authority. */
  summary?: string;
}

export interface NormalizedAction {
  kind: string;
  accountId: string | null;
  destination: string[];
  payload: unknown;
  payloadHash: string;
  attachments: AttachmentRef[];
  scope: ActionScope | null;
  summary: string | null;
}

export const ACTION_LIMITS = {
  maxPayloadBytes: 256 * 1024,
  maxDestinations: 50,
  maxDestinationLength: 512,
  maxAttachments: 20,
  maxSummaryLength: 2000,
  maxKindLength: 64,
} as const;

/** Validates and canonicalizes a proposal. Destinations are de-duplicated-checked and sorted. */
export function normalizeActionInput(input: unknown): Result<NormalizedAction> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return perr('invalid_input', 'action must be an object');
  const i = input as Record<string, unknown>;
  const allowed = new Set(['kind', 'accountId', 'destination', 'payload', 'attachments', 'scope', 'summary']);
  for (const k of Object.keys(i)) if (!allowed.has(k)) return perr('invalid_input', `unknown action field "${k}"`);
  if (typeof i.kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(i.kind) || i.kind.length > ACTION_LIMITS.maxKindLength)
    return perr('invalid_input', 'kind must be a lower_snake_case string');
  const accountId = i.accountId ?? null;
  if (accountId !== null && (typeof accountId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)))
    return perr('invalid_input', 'accountId must be a registered account id');
  const dest = i.destination ?? [];
  if (!Array.isArray(dest) || dest.length > ACTION_LIMITS.maxDestinations) return perr('invalid_input', 'destination must be an array');
  for (const d of dest)
    if (typeof d !== 'string' || d.trim() !== d || d.length === 0 || d.length > ACTION_LIMITS.maxDestinationLength)
      return perr('invalid_input', 'destination entries must be non-empty trimmed strings');
  const destination = [...(dest as string[])].sort();
  if (new Set(destination).size !== destination.length) return perr('invalid_input', 'duplicate destination');
  const payload = i.payload ?? null;
  let canon: string;
  try {
    canon = canonicalJson(payload);
  } catch (e) {
    return perr('invalid_input', `payload is not plain JSON: ${(e as Error).message}`);
  }
  if (Buffer.byteLength(canon) > ACTION_LIMITS.maxPayloadBytes) return perr('invalid_input', 'payload too large');
  const att = i.attachments ?? [];
  if (!Array.isArray(att) || att.length > ACTION_LIMITS.maxAttachments) return perr('invalid_input', 'attachments must be an array');
  const attachments: AttachmentRef[] = [];
  for (const a of att) {
    const r = a as Record<string, unknown>;
    if (!r || typeof r.name !== 'string' || !r.name || typeof r.sha256 !== 'string' || !SHA256_HEX.test(r.sha256) || Object.keys(r).length !== 2)
      return perr('invalid_input', 'attachment must be {name, sha256(lowercase hex)}');
    attachments.push({ name: r.name, sha256: r.sha256 });
  }
  attachments.sort((a, b) => (a.sha256 + a.name < b.sha256 + b.name ? -1 : 1));
  let scope: ActionScope | null = null;
  if (i.scope !== undefined && i.scope !== null) {
    const s = i.scope as Record<string, unknown>;
    if (typeof s !== 'object' || Array.isArray(s)) return perr('invalid_input', 'scope must be an object');
    for (const k of Object.keys(s)) if (!['taskId', 'sourceIds', 'projectId'].includes(k)) return perr('invalid_input', `unknown scope field ${k}`);
    if (s.taskId !== undefined && typeof s.taskId !== 'string') return perr('invalid_input', 'scope.taskId must be a string');
    if (s.projectId !== undefined && typeof s.projectId !== 'string') return perr('invalid_input', 'scope.projectId must be a string');
    if (s.sourceIds !== undefined && (!Array.isArray(s.sourceIds) || !s.sourceIds.every((x) => typeof x === 'string')))
      return perr('invalid_input', 'scope.sourceIds must be strings');
    scope = JSON.parse(canonicalJson(s)) as ActionScope;
  }
  const summary = i.summary === undefined ? null : i.summary;
  if (summary !== null && (typeof summary !== 'string' || summary.length > ACTION_LIMITS.maxSummaryLength)) return perr('invalid_input', 'summary too long');
  return ok({ kind: i.kind, accountId: accountId as string | null, destination, payload: JSON.parse(canon), payloadHash: hashCanonical(payload), attachments, scope, summary });
}
