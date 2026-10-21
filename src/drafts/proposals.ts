/**
 * The ONLY way a draft can move towards an external effect: a broker
 * proposal (submit_application / send_message). These
 * kinds are always-approval in the policy catalog, so the broker records the
 * proposal as awaiting the owner's approval of the exact payload. This module
 * only ever calls `propose`; it has no reference to execute().
 */
import { parseMessagePayload, recipientsOf } from '../connectors/writers/writer-payload.ts';
import { sha256Hex } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { ActionInput } from '../policy/action.ts';
import type { DraftKind, DraftRecord, DraftWorkspace } from './workspace.ts';

export type SubmissionKind = 'submit_application' | 'send_message';

const KIND_FOR: Partial<Record<DraftKind, SubmissionKind>> = {
  resume: 'submit_application',
  cover_letter: 'submit_application',
  application: 'submit_application',
  email_reply: 'send_message',
};

export interface ProposalParams {
  /** Registered account the effect would use (e.g. gmail-personal). */
  accountId: string;
  /** Exact destination: recipients for send_message; application endpoint for submissions. */
  destination: string[];
  taskId?: string;
  /** Extra files bound by hash (e.g. an exported PDF). */
  attachments?: { name: string; sha256: string }[];
  summary?: string;
}

/** Narrow structural type: proposers can propose, nothing else. */
export interface Proposer {
  propose(input: unknown, actor: string): Result<{ actionId: string; status: string; approvalId: string | null; bindingHash: string | null }>;
}

/** Builds the exact action input bound to the draft's current content. */
export function buildProposal(draft: DraftRecord, content: string, p: ProposalParams): Result<ActionInput> {
  const kind = KIND_FOR[draft.kind];
  if (!kind) return perr('invalid_input', 'this local draft has no submission route; prepare an exact message proposal separately');
  if (!p.destination.length) return perr('invalid_input', 'a proposal needs an exact destination');
  if (draft.status === 'archived') return perr('invalid_input', 'archived drafts cannot be proposed');
  const contentSha256 = sha256Hex(content);
  if (contentSha256 !== draft.contentSha256) return perr('invalid_input', 'draft file changed outside the workspace; re-save it before proposing');
  let payload: Record<string, unknown>;
  if (kind === 'send_message') {
    const m = draft.meta as { subject?: string; inReplyTo?: string | null; replyBody?: string; fromAccountId?: string; to?: string[] };
    if (m.fromAccountId && m.fromAccountId !== p.accountId) return perr('invalid_input', 'sending account differs from the draft');
    if (p.attachments?.length) return perr('invalid_input', 'email draft attachments need a writer payload with content type and size');
    payload = { channel: 'email', to: [...p.destination], subject: m.subject ?? draft.title, body: m.replyBody ?? content,
      ...(m.inReplyTo ? { reply: { inReplyTo: m.inReplyTo } } : {}),
    };
    const parsed = parseMessagePayload(payload);
    if (!parsed.ok) return parsed;
    if (m.to && JSON.stringify([...m.to].sort()) !== JSON.stringify(recipientsOf(parsed.value))) return perr('invalid_input', 'recipients differ from the draft; create a revised draft');
  } else {
    payload = { draftId: draft.id, draftKind: draft.kind, contentSha256, content };
    if (draft.unresolved.length) payload.unresolved = draft.unresolved;
  }
  return ok({
    kind,
    accountId: p.accountId,
    destination: [...p.destination],
    payload,
    attachments: p.attachments ?? [],
    scope: { ...(p.taskId ? { taskId: p.taskId } : {}), sourceIds: draft.sourceRefs.map((s) => `${s.type}:${s.id}`).slice(0, 50) },
    summary: p.summary ?? `${kind} for draft "${draft.title}"`,
  });
}

/**
 * Creates the broker proposal for a draft and marks the draft `proposed`.
 * Never executes: execution happens only in the daemon after the owner approves.
 */
export function proposeDraft(ws: DraftWorkspace, proposer: Proposer, draftId: string, p: ProposalParams, actor = 'potts:drafts'): Result<{ actionId: string; status: string; approvalId: string | null }> {
  const d = ws.get(draftId);
  if (!d) return perr('not_found', 'draft not found');
  if (d.status === 'proposed' && d.proposalActionId) return perr('action_state', `draft already proposed as ${d.proposalActionId}`);
  const input = buildProposal(d, ws.read(draftId), p);
  if (!input.ok) return input;
  const r = proposer.propose(input.value, actor);
  if (!r.ok) return r;
  ws._markProposed(draftId, r.value.actionId);
  return ok({ actionId: r.value.actionId, status: r.value.status, approvalId: r.value.approvalId });
}
