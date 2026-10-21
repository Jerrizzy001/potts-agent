/**
 * Verification of signed owner controls that are not broker intents
 * (currently: memory forget, owned by WP-3/WP-8). The potts-broker plugin
 * signs them with the ingress key under a separate domain separator
 * ("potts-owner-control:v1:"), so they cannot be confused with or replayed
 * as OwnerIngressProofs.
 *
 * Contract for the memory-control socket (served by WP-8, consumed by the
 * plugin's /forget): method `owner_forget {proof}`; the server must call
 * verifyOwnerControl() and then make proof.updateId single-use (e.g. via
 * consumeOwnerControlOnce with the broker DB's ingress_consumed table).
 */
import { canonicalJson, hexEqual, hmacSha256Hex } from '../core/hash.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { Db } from '../store/db.ts';

export interface OwnerControlProof {
  v: 1;
  source: 'telegram' | 'imessage';
  senderId: string;
  updateId: string;
  receivedAt: string;
  control: { type: string; [k: string]: unknown };
  mac: string;
}

export function ownerControlMac(key: string | Uint8Array, p: Omit<OwnerControlProof, 'v' | 'mac'>): string {
  return hmacSha256Hex(key, `potts-owner-control:v1:${canonicalJson({ source: p.source, senderId: p.senderId, updateId: p.updateId, receivedAt: p.receivedAt, control: p.control })}`);
}

export function verifyOwnerControl(
  raw: unknown,
  o: { key: string | Uint8Array; ownerSenderId: string; source?: 'telegram' | 'imessage'; clock?: Clock; maxAgeSeconds?: number; expectType?: string },
): Result<OwnerControlProof> {
  if (!raw || typeof raw !== 'object') return perr('ingress_invalid', 'proof missing');
  const p = raw as Partial<OwnerControlProof>;
  if (p.v !== 1 || p.source !== (o.source ?? 'telegram') || typeof p.senderId !== 'string' || typeof p.updateId !== 'string' || typeof p.receivedAt !== 'string' || typeof p.mac !== 'string')
    return perr('ingress_invalid', 'proof malformed');
  if (!p.control || typeof p.control !== 'object' || typeof p.control.type !== 'string') return perr('ingress_invalid', 'control malformed');
  if (o.expectType && p.control.type !== o.expectType) return perr('ingress_invalid', 'unexpected control type');
  let expected: string;
  try {
    expected = ownerControlMac(o.key, { source: p.source!, senderId: p.senderId, updateId: p.updateId, receivedAt: p.receivedAt, control: p.control });
  } catch {
    return perr('ingress_invalid', 'proof not canonicalizable');
  }
  if (!hexEqual(expected, p.mac)) return perr('ingress_invalid', 'proof MAC invalid');
  if (p.senderId !== o.ownerSenderId) return perr('ingress_wrong_sender', 'proof sender is not the owner');
  const at = Date.parse(p.receivedAt);
  const now = (o.clock ?? systemClock).nowMs();
  if (Number.isNaN(at) || now - at > (o.maxAgeSeconds ?? 600) * 1000 || at - now > 60_000) return perr('ingress_expired', 'proof is stale or from the future');
  return ok(p as OwnerControlProof);
}

/** Single use for owner controls, sharing the broker's ingress_consumed table under source "telegram-control". */
export function consumeOwnerControlOnce(db: Db, p: OwnerControlProof, clock: Clock = systemClock): Result<true> {
  const r = db.prepare('INSERT OR IGNORE INTO ingress_consumed (source, update_id, consumed_at) VALUES (?, ?, ?)').run(`${p.source}-control`, p.updateId, clock.nowIso());
  return Number(r.changes) === 1 ? ok(true) : perr('ingress_replayed', `control ${p.updateId} was already used`);
}
