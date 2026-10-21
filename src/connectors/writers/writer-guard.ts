/**
 * Execute-time guards shared by every writer. A writer calls these BEFORE it
 * touches the provider; any failure throws ExecutorRejectedError (nothing was
 * sent, so the broker records a definitive failure and releases nothing to
 * the model).
 *
 *  1. Kind is one the writer serves.
 *  2. The payload it is about to render re-hashes to intent.payloadHash.
 *  3. The sending account (id AND exact address) is the writer's own account.
 *  4. Recipients derived from the payload equal the approved destination.
 *  5. Attachment refs in the payload equal the approved attachment refs, and
 *     the bytes loaded from the store hash to the approved sha256.
 *  6. (Defence in depth, independent of the broker's own checks) the
 *     dispatch row is in flight and its consumed approval's binding names this
 *     exact action, account, destination, payload hash and attachments.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../store/db.ts';
import { hashCanonical, SHA256_HEX } from '../../core/hash.ts';
import { ok, perr, type Result } from '../../core/result.ts';
import type { ApprovalBinding } from '../../approvals/binding.ts';
import { ExecutorRejectedError, type DispatchIntent } from '../../broker/executor.ts';
import { parseMessagePayload, recipientsOf, type MessageChannel, type MessagePayload, type PayloadAttachment } from './writer-payload.ts';

export interface WriterIdentity {
  /** Registry account id this writer's credential belongs to. */
  accountId: string;
  /** Exact sender identity (email address / iMessage handle). */
  accountAddress: string;
}

export type MessageKind = 'send_message' | 'support_reply';

/** Returns ok when the dispatch is bound to a consumed approval that matches the intent exactly. */
export type ApprovalCheck = (intent: Readonly<DispatchIntent>) => Result<{ approvalId: string | null }>;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const attKey = (a: { name: string; sha256: string }) => `${a.sha256}:${a.name}`;

export function reject(message: string): never {
  throw new ExecutorRejectedError(message);
}

/** Checks 1–5 (minus attachment bytes). Throws ExecutorRejectedError on any mismatch. */
export function verifyMessageIntent(intent: Readonly<DispatchIntent>, who: WriterIdentity, opts: { kinds: readonly MessageKind[]; channel: MessageChannel }): MessagePayload {
  if (!(opts.kinds as readonly string[]).includes(intent.kind)) reject(`writer does not handle ${intent.kind}`);
  if (hashCanonical(intent.payload) !== intent.payloadHash) reject('payload does not match the approved payload hash');
  if (intent.accountId !== who.accountId) reject(`writer for account ${who.accountId} refuses a dispatch for account ${intent.accountId ?? '(none)'}`);
  if (intent.accountAddress !== who.accountAddress) reject('sender address does not equal the approved account address');
  const parsed = parseMessagePayload(intent.payload, intent.kind as MessageKind);
  if (!parsed.ok) reject(`payload invalid: ${parsed.error.message}`);
  const p = parsed.value;
  if (p.channel !== opts.channel) reject(`payload channel ${p.channel} does not match writer channel ${opts.channel}`);
  if (!sameList(recipientsOf(p), [...intent.destination].sort())) reject('recipients in the payload do not equal the approved recipients');
  const payloadAtt = (p.attachments ?? []).map(attKey).sort();
  const approvedAtt = intent.attachments.map(attKey).sort();
  if (!sameList(payloadAtt, approvedAtt)) reject('attachments in the payload do not equal the approved attachments');
  return p;
}

/**
 * Reads the broker's dispatch + approval rows (read-only) and compares the
 * consumed approval's binding with the intent. support_reply actions that the
 * policy allowed automatically have no approval; they pass only if the stored
 * decision is "allow".
 */
export function createApprovalBindingCheck(db: Db): ApprovalCheck {
  return (intent) => {
    const d = db.prepare('SELECT state, approval_id, action_id FROM dispatches WHERE id = ?').get(intent.dispatchId) as
      | { state: string; approval_id: string | null; action_id: string }
      | undefined;
    if (!d) return perr('approval_missing', 'dispatch record not found');
    if (d.state !== 'dispatching') return perr('approval_used', `dispatch is ${d.state}, not in flight (replay?)`);
    if (d.action_id !== intent.actionId) return perr('approval_mismatch', 'dispatch belongs to another action');
    if (!d.approval_id) {
      const a = db.prepare('SELECT decision FROM actions WHERE id = ?').get(intent.actionId) as { decision: string } | undefined;
      if (intent.kind === 'support_reply' && a?.decision === 'allow') return ok({ approvalId: null });
      return perr('approval_missing', `${intent.kind} dispatch has no bound approval`);
    }
    const apr = db.prepare('SELECT status, used_by_dispatch, binding_json FROM approvals WHERE id = ?').get(d.approval_id) as
      | { status: string; used_by_dispatch: string | null; binding_json: string }
      | undefined;
    if (!apr) return perr('approval_missing', 'approval record not found');
    if (apr.status !== 'used' || apr.used_by_dispatch !== intent.dispatchId) return perr('approval_used', 'approval is not consumed by this dispatch');
    const b = JSON.parse(apr.binding_json) as ApprovalBinding;
    const changed: string[] = [];
    if (b.actionId !== intent.actionId) changed.push('actionId');
    if (b.kind !== intent.kind) changed.push('kind');
    if (b.accountId !== intent.accountId) changed.push('accountId');
    if (!sameList([...b.destination].sort(), [...intent.destination].sort())) changed.push('destination');
    if (b.payloadHash !== intent.payloadHash) changed.push('payloadHash');
    if (!sameList(b.attachments.map(attKey).sort(), intent.attachments.map(attKey).sort())) changed.push('attachments');
    if (changed.length) return perr('approval_mismatch', `dispatch differs from the approved binding: ${changed.join(', ')}`, { changed });
    return ok({ approvalId: d.approval_id });
  };
}

export function enforceApproval(check: ApprovalCheck | undefined, intent: Readonly<DispatchIntent>): void {
  if (!check) return;
  const r = check(intent);
  if (!r.ok) reject(`approval check failed: ${r.error.message}`);
}

/** Content-addressed attachment bytes. Production: files named by sha256 in a 0700 directory. */
export interface AttachmentStore {
  get(sha256: string): Promise<Uint8Array | undefined>;
}

export function createDirAttachmentStore(dir: string): AttachmentStore {
  return {
    async get(sha256) {
      if (!SHA256_HEX.test(sha256)) return undefined;
      try {
        return new Uint8Array(await readFile(join(dir, sha256)));
      } catch {
        return undefined;
      }
    },
  };
}

export function createMemoryAttachmentStore(items: Uint8Array[] = []): AttachmentStore & { put(bytes: Uint8Array): string } {
  const m = new Map<string, Uint8Array>();
  const put = (b: Uint8Array) => {
    const h = createHash('sha256').update(b).digest('hex');
    m.set(h, b);
    return h;
  };
  items.forEach(put);
  return { put, get: async (h) => m.get(h) };
}

export interface LoadedAttachment extends PayloadAttachment {
  bytes: Uint8Array;
}

/** Loads each approved attachment and verifies bytes against the approved hash and size. */
export async function loadVerifiedAttachments(store: AttachmentStore | undefined, list: readonly PayloadAttachment[]): Promise<LoadedAttachment[]> {
  if (!list.length) return [];
  if (!store) reject('attachments present but no attachment store is configured');
  const out: LoadedAttachment[] = [];
  for (const a of list) {
    const bytes = await store.get(a.sha256);
    if (!bytes) reject(`attachment ${a.name} (${a.sha256.slice(0, 12)}) is not in the attachment store`);
    const h = createHash('sha256').update(bytes).digest('hex');
    if (h !== a.sha256) reject(`attachment ${a.name} bytes do not match the approved hash`);
    if (bytes.byteLength !== a.size) reject(`attachment ${a.name} size ${bytes.byteLength} differs from approved size ${a.size}`);
    out.push({ ...a, bytes });
  }
  return out;
}
