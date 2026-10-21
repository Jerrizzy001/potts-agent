/**
 * Trusted owner ingress signing (plugin side).
 *
 * Wire-compatible with `src/approvals/ingress.ts`: the broker's
 * createIngressVerifier() accepts proofs produced by signOwnerIngress() here.
 * Only this plugin's owner-command / button handlers call it, after the
 * owner checks in guard.ts passed. The model never reaches this code: agent
 * tools in tools.ts talk to the proposer socket, which has no owner methods.
 */
import { canonicalJson, hmacSha256Hex } from './crypto.ts';

export type OwnerIntent =
  | { type: 'approve'; approvalId: string; bindingHash: string }
  | { type: 'deny'; approvalId: string; reason?: string }
  | { type: 'cancel_approval'; approvalId: string; reason?: string }
  | { type: 'cancel_action'; actionId: string; reason?: string }
  | { type: 'pause_all'; reason?: string }
  | { type: 'pause_integration'; integration: string; reason?: string }
  | { type: 'resume'; scope: 'global' | `integration:${string}` }
  | { type: 'revoke_account'; accountId: string; reason?: string }
  | { type: 'reinstate_account'; accountId: string }
  | { type: 'test_call' };

export interface OwnerIngressFields {
  source: 'telegram' | 'imessage';
  senderId: string;
  chatId: string;
  chatType: 'private';
  updateId: string;
  receivedAt: string;
  intent: OwnerIntent;
}

export interface OwnerIngressProof extends OwnerIngressFields {
  v: 1;
  mac: string;
}

export const MIN_INGRESS_KEY_BYTES = 32;

export function keyBytes(key: string | Uint8Array): Uint8Array {
  const b = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (b.length < MIN_INGRESS_KEY_BYTES) throw new Error(`ingress key must be at least ${MIN_INGRESS_KEY_BYTES} bytes`);
  return b;
}

function macInput(f: OwnerIngressFields): string {
  return canonicalJson({ v: 1, source: f.source, senderId: f.senderId, chatId: f.chatId, chatType: f.chatType, updateId: f.updateId, receivedAt: f.receivedAt, intent: f.intent });
}

export function signOwnerIngress(key: string | Uint8Array, fields: OwnerIngressFields): OwnerIngressProof {
  return { v: 1, ...fields, mac: hmacSha256Hex(keyBytes(key), macInput(fields)) };
}

/** Response to the ingress socket challenge (matches src/broker/server.ts ingressAuthResponse). */
export function ingressAuthResponse(key: string | Uint8Array, challenge: string): string {
  return hmacSha256Hex(key, `potts-ingress-auth:v1:${challenge}`);
}

/**
 * Generic signed owner control for capabilities that are not broker intents
 * (e.g. memory forget, owned by WP-3/WP-8). Same key, different domain
 * separator, so a control MAC can never be replayed as an ingress proof.
 */
export interface OwnerControlFields {
  source: 'telegram' | 'imessage';
  senderId: string;
  updateId: string;
  receivedAt: string;
  control: { type: string; [k: string]: unknown };
}
export interface OwnerControlProof extends OwnerControlFields {
  v: 1;
  mac: string;
}
export function signOwnerControl(key: string | Uint8Array, f: OwnerControlFields): OwnerControlProof {
  const input = `potts-owner-control:v1:${canonicalJson({ source: f.source, senderId: f.senderId, updateId: f.updateId, receivedAt: f.receivedAt, control: f.control })}`;
  return { v: 1, ...f, mac: hmacSha256Hex(keyBytes(key), input) };
}
