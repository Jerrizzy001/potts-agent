import { canonicalJson, hexEqual, hmacSha256Hex } from '../core/hash.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { ActionInput } from '../policy/action.ts';
import type { Db } from '../store/db.ts';

/**
 * TRUSTED OWNER INGRESS
 *
 * Only the trusted ingress (WP-2: the single Telegram update consumer, running
 * as broker-side code, not as the model) holds the ingress HMAC key. For each
 * Telegram update whose `from.id` equals the configured owner id in a private
 * chat, it turns the owner's button press / command into a structured
 * OwnerIntent and signs it with signOwnerIngress(). The broker accepts owner
 * operations only with a proof that verifies under that key, comes from the
 * owner's sender id, is fresh, and whose update id was never used before.
 *
 * Threat model (honest): the HMAC separates "holds the key" from "does not".
 * It defeats the model/plugin forging approvals over the propose socket,
 * model-authored text ("owner approved this"), emails/logs claiming owner
 * authority, replayed updates and edited payloads. It does NOT protect
 * against a process that can read the key (same Unix user with no OS
 * boundary, or a compromised broker) or against someone controlling the
 * owner's Telegram account. Keeping the key unreadable by the model/worker is
 * WP-2's OS-isolation job; until then this is defence in depth, not a proof.
 */
export type OwnerIntent =
  | { type: 'approve'; approvalId: string; bindingHash: string }
  | { type: 'deny'; approvalId: string; reason?: string }
  | { type: 'cancel_approval'; approvalId: string; reason?: string }
  | { type: 'cancel_action'; actionId: string; reason?: string }
  | { type: 'direct_instruction'; action: ActionInput }
  | { type: 'pause_all'; reason?: string }
  | { type: 'pause_integration'; integration: string; reason?: string }
  | { type: 'resume'; scope: 'global' | `integration:${string}` }
  | { type: 'revoke_account'; accountId: string; reason?: string }
  | { type: 'reinstate_account'; accountId: string }
  /** Owner-requested `test` owner-alert call (WP-9). Still subject to telephony.enabled and quiet hours. */
  | { type: 'test_call' };

export const OWNER_INTENT_TYPES = [
  'approve', 'deny', 'cancel_approval', 'cancel_action', 'direct_instruction', 'pause_all', 'pause_integration', 'resume',
  'revoke_account', 'reinstate_account', 'test_call',
] as const;

export interface OwnerIngressFields {
  source: 'telegram' | 'imessage';
  /** Telegram from.id of the sender (string to avoid precision issues). */
  senderId: string;
  chatId: string;
  chatType: 'private';
  /** Telegram update_id; single use. */
  updateId: string;
  /** When the trusted ingress received the update (UTC ISO). */
  receivedAt: string;
  intent: OwnerIntent;
}

export interface OwnerIngressProof extends OwnerIngressFields {
  v: 1;
  /** HMAC-SHA256(key, canonicalJson(fields + v)). */
  mac: string;
}

export const MIN_INGRESS_KEY_BYTES = 32;

function macInput(f: OwnerIngressFields): string {
  return canonicalJson({ v: 1, source: f.source, senderId: f.senderId, chatId: f.chatId, chatType: f.chatType, updateId: f.updateId, receivedAt: f.receivedAt, intent: f.intent });
}

function keyBytes(key: string | Uint8Array): Uint8Array {
  const b = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (b.length < MIN_INGRESS_KEY_BYTES) throw new Error(`ingress key must be at least ${MIN_INGRESS_KEY_BYTES} bytes`);
  return b;
}

/** Used ONLY by the trusted ingress module (WP-2). Requires the broker-held key. */
export function signOwnerIngress(key: string | Uint8Array, fields: OwnerIngressFields): OwnerIngressProof {
  return { v: 1, ...fields, mac: hmacSha256Hex(keyBytes(key), macInput(fields)) };
}

/** Opaque, runtime-branded result of verification. Only verify() creates these. */
export interface VerifiedOwnerIngress {
  readonly proof: Readonly<OwnerIngressProof>;
  /** Stable reference recorded on approvals/audit: "telegram:<updateId>". */
  readonly ref: string;
  readonly actor: string;
}
const VERIFIED = new WeakSet<object>();
export function isVerifiedOwnerIngress(x: unknown): x is VerifiedOwnerIngress {
  return typeof x === 'object' && x !== null && VERIFIED.has(x);
}

export interface IngressVerifierOptions {
  key: string | Uint8Array;
  /** Resolved owner Telegram user id (from config.owner.telegramOwnerIdRef). */
  ownerSenderId: string;
  source?: 'telegram' | 'imessage';
  clock?: Clock;
  /** Reject proofs older than this (default 600 s) or more than 60 s in the future. */
  maxAgeSeconds?: number;
}

export interface IngressVerifier {
  /** Checks shape, MAC, sender, chat and freshness. Replay is checked by consumeIngressOnce(). */
  verify(proof: unknown): Result<VerifiedOwnerIngress>;
}

export function createIngressVerifier(opts: IngressVerifierOptions): IngressVerifier {
  const key = keyBytes(opts.key);
  const clock = opts.clock ?? systemClock;
  const maxAgeMs = (opts.maxAgeSeconds ?? 600) * 1000;
  return {
    verify(raw) {
      if (!raw || typeof raw !== 'object') return perr('ingress_invalid', 'proof missing');
      const p = raw as Partial<OwnerIngressProof>;
      if (p.v !== 1 || p.source !== (opts.source ?? 'telegram')) return perr('ingress_invalid', 'proof is not from the configured owner ingress');
      if (typeof p.senderId !== 'string' || typeof p.chatId !== 'string' || typeof p.updateId !== 'string' || typeof p.receivedAt !== 'string' || typeof p.mac !== 'string')
        return perr('ingress_invalid', 'proof fields malformed');
      if (!p.intent || typeof p.intent !== 'object' || !(OWNER_INTENT_TYPES as readonly string[]).includes((p.intent as { type?: string }).type ?? ''))
        return perr('ingress_invalid', 'unknown owner intent');
      const fields: OwnerIngressFields = { source: p.source!, senderId: p.senderId, chatId: p.chatId, chatType: p.chatType as 'private', updateId: p.updateId, receivedAt: p.receivedAt, intent: p.intent };
      let expected: string;
      try {
        expected = hmacSha256Hex(key, macInput(fields));
      } catch {
        return perr('ingress_invalid', 'proof not canonicalizable');
      }
      if (!hexEqual(expected, p.mac)) return perr('ingress_invalid', 'proof MAC invalid');
      if (p.senderId !== opts.ownerSenderId) return perr('ingress_wrong_sender', 'proof sender is not the owner');
      if (p.chatType !== 'private' || p.chatId !== opts.ownerSenderId) return perr('ingress_wrong_sender', 'proof is not from the owner private chat');
      const at = Date.parse(p.receivedAt);
      const now = clock.nowMs();
      if (Number.isNaN(at) || now - at > maxAgeMs || at - now > 60_000) return perr('ingress_expired', 'proof is stale or from the future');
      const v: VerifiedOwnerIngress = Object.freeze({ proof: Object.freeze({ ...(p as OwnerIngressProof) }), ref: `${p.source}:${p.updateId}`, actor: `owner:${p.source}:${p.senderId}` });
      VERIFIED.add(v);
      return ok(v);
    },
  };
}

/** Records the update id as used. Returns ingress_replayed if it was used before. */
export function consumeIngressOnce(db: Db, v: VerifiedOwnerIngress, clock: Clock = systemClock): Result<true> {
  if (!isVerifiedOwnerIngress(v)) return perr('ingress_invalid', 'not a verified ingress');
  const r = db.prepare('INSERT OR IGNORE INTO ingress_consumed (source, update_id, consumed_at) VALUES (?, ?, ?)').run(v.proof.source, v.proof.updateId, clock.nowIso());
  return Number(r.changes) === 1 ? ok(true) : perr('ingress_replayed', `update ${v.proof.updateId} was already used`);
}
