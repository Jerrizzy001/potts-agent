/**
 * Calls to anyone other than the owner (`call_third_party`). This is an
 * always-approval action: it needs a specific owner instruction naming the
 * recipient AND the purpose, and the broker binds the approval to both.
 *
 * The question-only ConversationRelay executor is registered only when
 * telephony.conversation.enabled is true. Default remains disabled.
 */
import { ok, perr, type Result } from '../core/result.ts';
import type { ActionInput } from '../policy/action.ts';

/** Default, not a runtime capability flag; runtime registration follows conversation.enabled. */
export const THIRD_PARTY_CALLS_ENABLED = false as const;

export interface ThirdPartyCallInstruction {
  /** Telephony account (caller number) from the registry. */
  accountId: string;
  /** Exact E.164 number to call. */
  recipient: string;
  /** Who it is, as the owner described them (shown in the approval). */
  recipientName: string;
  /** What the call is for, in the owner's words. */
  purpose: string;
  /** Owner instruction reference (e.g. Telegram update id) that requested this call. */
  instructionRef: string;
}

export function buildThirdPartyCallProposal(i: ThirdPartyCallInstruction): Result<ActionInput> {
  if (!/^\+[1-9][0-9]{6,14}$/.test(i.recipient)) return perr('invalid_input', 'recipient must be an exact E.164 number');
  if (typeof i.recipientName !== 'string' || !i.recipientName.trim() || i.recipientName.length > 120) return perr('invalid_input', 'recipientName required');
  if (typeof i.purpose !== 'string' || i.purpose.trim().length < 10 || i.purpose.length > 1000) return perr('invalid_input', 'purpose must describe the call (10–1000 characters)');
  if (typeof i.instructionRef !== 'string' || !i.instructionRef) return perr('invalid_input', 'an owner instruction reference is required');
  return ok({
    kind: 'call_third_party',
    accountId: i.accountId,
    destination: [i.recipient],
    payload: {
      recipient: i.recipient,
      recipientName: i.recipientName.trim(),
      purpose: i.purpose.trim(),
      ownerInstruction: i.instructionRef,
      commitmentsAllowed: false,
    },
    summary: `Call ${i.recipientName.trim()} (${i.recipient}): ${i.purpose.trim()}`.slice(0, 1900),
  });
}
