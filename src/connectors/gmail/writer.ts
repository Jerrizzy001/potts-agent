/**
 * Gmail writer (broker executor). Constructed ONLY by trusted broker startup
 * code and registered only when explicitly enabled in config (default off).
 *
 * Credential: a SEPARATE send-scoped credential (`gmail.send`), not the
 * reader's read-only token. Obtained per send from the TokenProvider.
 *
 * execute(): guards (payload hash, account, recipients, attachments, bound
 * approval) → verify the token's mailbox equals the approved sender
 * (OpenID userinfo: a gmail.send-only grant cannot call users.getProfile, so
 * the send consent also carries `openid email`) → build RFC 5322 MIME in-house with
 * Message-ID = <potts-{actionId}@{sender-domain}> and X-Potts-Action →
 * users.messages.send (single call, never retried here).
 *
 * lookup(): search the mailbox for rfc822msgid:<Message-ID> carrying the SENT
 * label; fall back to scanning recent Sent mail for the X-Potts-Action
 * header. "not_found" is only reported after a settle window (index lag),
 * otherwise "unknown" — the broker then keeps the dispatch uncertain.
 */
import type { Clock } from '../../core/clock.ts';
import { systemClock } from '../../core/clock.ts';
import { ExecutorRejectedError, type DispatchIntent, type Executor, type ExecutorReceipt, type LookupResult } from '../../broker/executor.ts';
import { enforceApproval, loadVerifiedAttachments, verifyMessageIntent, type ApprovalCheck, type AttachmentStore, type MessageKind, type WriterIdentity } from '../writers/writer-guard.ts';
import { classifySendResponse, getToken, messageIdFor, POTTS_ACTION_HEADER, preSendFetch, settled, UncertainProviderError, type FetchLike, type TokenProvider } from '../writers/writer-support.ts';
import { buildMime, toBase64Url } from './writer-mime.ts';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** lookup() needs to read Sent mail; the reader credential (gmail.readonly) can be supplied via lookupScopes. */
export const GMAIL_LOOKUP_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailWriterOptions extends WriterIdentity {
  tokens: TokenProvider;
  fetch?: FetchLike;
  clock?: Clock;
  attachments?: AttachmentStore;
  /** Defence-in-depth binding check (createApprovalBindingCheck(db)). Required in production wiring. */
  approvalCheck?: ApprovalCheck;
  kinds?: readonly MessageKind[];
  timeoutMs?: number;
  /** Seconds after the intent before an empty search is trusted as "not sent". Default 600. */
  lookupSettleSeconds?: number;
  apiBase?: string;
  /** OpenID userinfo endpoint used for the sender identity check (default Google's). */
  userinfoUrl?: string;
}

export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface WriterExecutor extends Executor {
  readonly accountId: string;
  readonly accountAddress: string;
}

export function createGmailWriter(o: GmailWriterOptions): WriterExecutor {
  const fetchFn = o.fetch ?? (globalThis.fetch as FetchLike);
  const clock = o.clock ?? systemClock;
  const kinds = o.kinds ?? (['send_message'] as const);
  const api = o.apiBase ?? API;
  const settleSeconds = o.lookupSettleSeconds ?? 600;
  const who: WriterIdentity = { accountId: o.accountId, accountAddress: o.accountAddress };

  const authed = (token: string, extra: Record<string, string> = {}): RequestInit['headers'] => ({ authorization: `Bearer ${token}`, ...extra });

  return {
    name: `gmail-writer:${o.accountId}`,
    integration: 'gmail',
    kinds: [...kinds],
    accountId: o.accountId,
    accountAddress: o.accountAddress,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),

    async execute(intent: Readonly<DispatchIntent>, signal: AbortSignal): Promise<ExecutorReceipt> {
      const p = verifyMessageIntent(intent, who, { kinds, channel: 'email' });
      enforceApproval(o.approvalCheck, intent);
      const atts = await loadVerifiedAttachments(o.attachments, p.attachments ?? []);
      const token = await getToken(o.tokens, o.accountId, [GMAIL_SEND_SCOPE]);

      // The credential must belong to the approved sender mailbox (verified e-mail of the Google account).
      const prof = await preSendFetch(fetchFn, o.userinfoUrl ?? GOOGLE_USERINFO_URL, { headers: authed(token), signal }, 'gmail sender identity check');
      if (!prof.ok) throw new ExecutorRejectedError(`gmail sender identity check failed (HTTP ${prof.status}); nothing sent`);
      const profile = (await prof.json()) as { email?: string; email_verified?: boolean | string };
      if (profile.email_verified === false || profile.email_verified === 'false') throw new ExecutorRejectedError('send credential e-mail is not verified by Google; nothing sent');
      if ((profile.email ?? '').toLowerCase() !== o.accountAddress.toLowerCase())
        throw new ExecutorRejectedError('send credential belongs to a different mailbox than the approved sender account');

      const messageId = messageIdFor(intent.idempotencyKey, o.accountAddress);
      const mime = buildMime({
        from: o.accountAddress,
        to: p.to,
        ...(p.cc ? { cc: p.cc } : {}),
        ...(p.bcc ? { bcc: p.bcc } : {}),
        subject: p.subject ?? '',
        body: p.body,
        messageId,
        date: clock.now(),
        ...(p.reply ? { inReplyTo: p.reply.inReplyTo, references: referencesFor(p.reply.inReplyTo, p.reply.references) } : {}),
        extraHeaders: { [POTTS_ACTION_HEADER]: intent.idempotencyKey },
        attachments: atts.map((a) => ({ name: a.name, contentType: a.contentType, bytes: a.bytes })),
      });
      const body: { raw: string; threadId?: string } = { raw: toBase64Url(mime) };
      if (p.reply?.providerThreadId) body.threadId = p.reply.providerThreadId;

      let res: Response;
      try {
        res = await fetchFn(`${api}/messages/send`, { method: 'POST', headers: authed(token, { 'content-type': 'application/json' }), body: JSON.stringify(body), signal });
      } catch (e) {
        throw new UncertainProviderError(`gmail send: ${(e as Error).message}; outcome unknown`);
      }
      await classifySendResponse(res, 'gmail send');
      let sent: { id?: string; threadId?: string } = {};
      try {
        sent = (await res.json()) as typeof sent;
      } catch {
        throw new UncertainProviderError('gmail send accepted but response unreadable');
      }
      if (!sent.id) throw new UncertainProviderError('gmail send returned no message id');
      return { providerOperationId: `gmail:${sent.id}`, detail: { messageId, threadId: sent.threadId ?? null } };
    },

    async lookup(intent: Readonly<DispatchIntent>): Promise<LookupResult> {
      let token: string;
      try {
        token = await o.tokens.getAccessToken({ accountId: o.accountId, purpose: 'lookup', scopes: [GMAIL_LOOKUP_SCOPE] });
      } catch (e) {
        return { status: 'unknown', reason: `no lookup credential: ${(e as Error).message}` };
      }
      const messageId = messageIdFor(intent.idempotencyKey, o.accountAddress);
      try {
        const q = encodeURIComponent(`rfc822msgid:${messageId}`);
        const r = await fetchFn(`${api}/messages?q=${q}&includeSpamTrash=true`, { headers: authed(token) });
        if (!r.ok) return { status: 'unknown', reason: `gmail search HTTP ${r.status}` };
        const j = (await r.json()) as { messages?: { id: string }[] };
        for (const m of j.messages ?? []) {
          const meta = await fetchFn(`${api}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=${POTTS_ACTION_HEADER}`, { headers: authed(token) });
          if (!meta.ok) return { status: 'unknown', reason: `gmail get HTTP ${meta.status}` };
          const mj = (await meta.json()) as { labelIds?: string[] };
          if ((mj.labelIds ?? []).includes('SENT')) return { status: 'found', providerOperationId: `gmail:${m.id}`, detail: { via: 'rfc822msgid' } };
        }
        // Fallback: Gmail may rewrite Message-ID; scan recent Sent for our X-Potts-Action header.
        const after = Math.floor(Date.parse(intent.createdAt) / 1000) - 120;
        const r2 = await fetchFn(`${api}/messages?q=${encodeURIComponent(`in:sent after:${after}`)}&maxResults=50`, { headers: authed(token) });
        if (!r2.ok) return { status: 'unknown', reason: `gmail sent scan HTTP ${r2.status}` };
        const j2 = (await r2.json()) as { messages?: { id: string }[]; nextPageToken?: string };
        for (const m of j2.messages ?? []) {
          const meta = await fetchFn(`${api}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=${POTTS_ACTION_HEADER}`, { headers: authed(token) });
          if (!meta.ok) return { status: 'unknown', reason: `gmail get HTTP ${meta.status}` };
          const mj = (await meta.json()) as { labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
          const h = mj.payload?.headers?.find((x) => x.name.toLowerCase() === POTTS_ACTION_HEADER.toLowerCase());
          if (h?.value === intent.idempotencyKey && (mj.labelIds ?? []).includes('SENT')) return { status: 'found', providerOperationId: `gmail:${m.id}`, detail: { via: 'x-potts-action' } };
        }
        if (j2.nextPageToken) return { status: 'unknown', reason: 'sent scan truncated; cannot prove absence' };
        if (!settled(clock, intent.createdAt, settleSeconds)) return { status: 'unknown', reason: 'not visible yet; waiting for the settle window before trusting absence' };
        return { status: 'not_found' };
      } catch (e) {
        return { status: 'unknown', reason: `gmail lookup failed: ${(e as Error).message}` };
      }
    },
  };
}

/** References = prior chain + the message being answered (RFC 5322 section 3.6.4). */
export function referencesFor(inReplyTo: string, prior: readonly string[] = []): string[] {
  return prior.includes(inReplyTo) ? [...prior] : [...prior, inReplyTo];
}
