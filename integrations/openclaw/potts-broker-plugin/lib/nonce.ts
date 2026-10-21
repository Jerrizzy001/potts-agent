/**
 * Approval button / confirmation codes.
 *
 * code = first 16 hex chars of HMAC(ingressKey, "potts-approval-code:v1:<action>:<approvalId>:<bindingHash>")
 *
 * - Only holders of the ingress key (the plugin's owner handlers and the
 *   Potts daemon) can mint a code, so a button or text forged by the model,
 *   an email or a delegated agent cannot carry a valid one.
 * - The code is bound to the exact binding hash the owner was shown; if the
 *   action is revised, the old button stops working.
 * - Approval itself is single-use in the broker; the code is not a bearer
 *   token for anything else.
 *
 * Telegram callback_data is limited to 64 bytes:
 *   "potts:a:" (8) + approvalId (apr_ + 26 = 30) + ":" (1) + code (16) = 55.
 */
import { hexEqual, hmacSha256Hex } from './crypto.ts';
import { keyBytes } from './ingress.ts';

export const CALLBACK_NAMESPACE = 'potts';
export const APPROVAL_ID_PATTERN = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
export const ACTION_ID_PATTERN = /^act_[0-9A-HJKMNP-TV-Z]{26}$/;
export const CODE_PATTERN = /^[0-9a-f]{16}$/;

export type ButtonAction = 'a' | 'd';

export function approvalCode(key: string | Uint8Array, action: ButtonAction, approvalId: string, bindingHash: string): string {
  return hmacSha256Hex(keyBytes(key), `potts-approval-code:v1:${action}:${approvalId}:${bindingHash}`).slice(0, 16);
}

export function verifyApprovalCode(key: string | Uint8Array, action: ButtonAction, approvalId: string, bindingHash: string, code: string): boolean {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return false;
  return hexEqual(approvalCode(key, action, approvalId, bindingHash), code);
}

export function callbackData(key: string | Uint8Array, action: ButtonAction, approvalId: string, bindingHash: string): string {
  return `${CALLBACK_NAMESPACE}:${action}:${approvalId}:${approvalCode(key, action, approvalId, bindingHash)}`;
}

export type ParsedCallback = { ok: true; action: ButtonAction; approvalId: string; code: string } | { ok: false; reason: string };

/** Parses the payload part (after "potts:") of callback data. */
export function parseCallbackPayload(payload: string): ParsedCallback {
  if (typeof payload !== 'string' || payload.length > 64) return { ok: false, reason: 'malformed' };
  const parts = payload.split(':');
  const [action, approvalId, code] = parts;
  if (action !== 'a' && action !== 'd') return { ok: false, reason: 'unknown_action' };
  if (!approvalId || !APPROVAL_ID_PATTERN.test(approvalId)) return { ok: false, reason: 'malformed' };
  if (parts.length < 3 || !code) return { ok: false, reason: 'missing_nonce' };
  if (parts.length > 3 || !CODE_PATTERN.test(code)) return { ok: false, reason: 'malformed' };
  return { ok: true, action, approvalId, code };
}
