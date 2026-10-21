import { hashCanonical } from '../core/hash.ts';
import type { AttachmentRef } from '../policy/action.ts';
import type { LoadedPolicy } from '../policy/document.ts';

/**
 * Everything an approval is bound to. Any change to any field yields a
 * different bindingHash and therefore invalidates the approval.
 */
export interface ApprovalBinding {
  actionId: string;
  kind: string;
  actor: string;
  accountId: string | null;
  destination: string[];
  payloadHash: string;
  attachments: AttachmentRef[];
  policyVersion: string;
  policyHash: string;
}

/** Minimal shape of a stored action needed to compute its binding. */
export interface BindableAction {
  id: string;
  kind: string;
  actor: string;
  accountId: string | null;
  destination: readonly string[];
  payloadHash: string;
  attachments: readonly AttachmentRef[];
}

export function bindingFor(action: BindableAction, policy: Pick<LoadedPolicy, 'version' | 'hash'>): ApprovalBinding {
  return {
    actionId: action.id,
    kind: action.kind,
    actor: action.actor,
    accountId: action.accountId,
    destination: [...action.destination].sort(),
    payloadHash: action.payloadHash,
    attachments: [...action.attachments].map((a) => ({ name: a.name, sha256: a.sha256 })).sort((a, b) => (a.sha256 + a.name < b.sha256 + b.name ? -1 : 1)),
    policyVersion: policy.version,
    policyHash: policy.hash,
  };
}

export const bindingHash = (b: ApprovalBinding): string => hashCanonical(b);
