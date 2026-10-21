/**
 * Small shared pieces for HTTP-based writers: credential interface, HTTP
 * outcome classification and persisted provider references.
 */
import type { Db } from '../../store/db.ts';
import type { Clock } from '../../core/clock.ts';
import { newId } from '../../core/ids.ts';
import { ExecutorRejectedError } from '../../broker/executor.ts';

/**
 * Supplies a short-lived access token for a SEND-scoped credential. This is a
 * different credential from the reader's (Gmail: gmail.send; Graph:
 * Mail.Send), stored under its own secret reference. purpose "lookup" asks for
 * a READ credential (the reader's gmail.readonly / Mail.Read token) used only
 * by lookup() to reconcile uncertain sends. WP-4's TokenStore
 * implements it; WP-8 wires it. The token is never logged or persisted.
 */
export interface TokenProvider {
  getAccessToken(req: { accountId: string; purpose: 'send' | 'lookup'; scopes: readonly string[] }): Promise<string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown when an HTTP call may or may not have taken effect (5xx, network, timeout). */
export class UncertainProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainProviderError';
  }
}

/**
 * Classifies a provider response for a NON-idempotent call. 2xx → ok.
 * 4xx (including 401/403/429) → the provider refused; nothing was sent →
 * ExecutorRejectedError. 5xx → uncertain (the provider may have accepted).
 */
export async function classifySendResponse(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string | number; status?: string } };
    detail = String(j?.error?.message ?? j?.error?.status ?? j?.error?.code ?? '').slice(0, 200);
  } catch {
    /* non-JSON */
  }
  if (res.status >= 400 && res.status < 500) throw new ExecutorRejectedError(`${what} refused by provider (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  throw new UncertainProviderError(`${what} returned HTTP ${res.status}; outcome unknown`);
}

/** Wraps fetch so network errors in a pre-send step become a definitive rejection. */
export async function preSendFetch(fetchFn: FetchLike, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (e) {
    throw new ExecutorRejectedError(`${what} failed before sending: ${(e as Error).message}`);
  }
}

export async function getToken(tokens: TokenProvider, accountId: string, scopes: readonly string[]): Promise<string> {
  try {
    const t = await tokens.getAccessToken({ accountId, purpose: 'send', scopes });
    if (!t) throw new Error('empty token');
    return t;
  } catch (e) {
    throw new ExecutorRejectedError(`send credential unavailable for ${accountId}: ${(e as Error).message}`);
  }
}

/** Persisted provider references (e.g. a Graph draft id) written BEFORE the irreversible call. */
export interface ProviderRefStore {
  put(r: { actionId: string; dispatchId: string; attempt: number; writer: string; refKind: string; refValue: string }): void;
  forAction(actionId: string, refKind?: string): { dispatchId: string; attempt: number; refKind: string; refValue: string; createdAt: string }[];
}

export function createProviderRefStore(db: Db, clock: Clock): ProviderRefStore {
  return {
    put(r) {
      db.prepare(
        `INSERT INTO writer_provider_refs (id, action_id, dispatch_id, attempt, writer, ref_kind, ref_value, created_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(dispatch_id, ref_kind) DO UPDATE SET ref_value = excluded.ref_value`,
      ).run(newId('wref', clock), r.actionId, r.dispatchId, r.attempt, r.writer, r.refKind, r.refValue, clock.nowIso());
    },
    forAction(actionId, refKind) {
      const rows = (refKind
        ? db.prepare('SELECT dispatch_id, attempt, ref_kind, ref_value, created_at FROM writer_provider_refs WHERE action_id = ? AND ref_kind = ? ORDER BY attempt').all(actionId, refKind)
        : db.prepare('SELECT dispatch_id, attempt, ref_kind, ref_value, created_at FROM writer_provider_refs WHERE action_id = ? ORDER BY attempt').all(actionId)) as {
        dispatch_id: string; attempt: number; ref_kind: string; ref_value: string; created_at: string;
      }[];
      return rows.map((x) => ({ dispatchId: x.dispatch_id, attempt: x.attempt, refKind: x.ref_kind, refValue: x.ref_value, createdAt: x.created_at }));
    },
  };
}

/** Message-ID derived from the action's idempotency key; stable across attempts. */
export function messageIdFor(idempotencyKey: string, senderAddress: string): string {
  const domain = senderAddress.split('@')[1] ?? 'potts.local';
  const local = idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '');
  return `<${local}@${domain}>`;
}

export const POTTS_ACTION_HEADER = 'X-Potts-Action';

/** True when enough time has passed that "not found" can be trusted (index lag, async send). */
export function settled(clock: Clock, sinceIso: string, settleSeconds: number): boolean {
  return clock.nowMs() - Date.parse(sinceIso) >= settleSeconds * 1000;
}
