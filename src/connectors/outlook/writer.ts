/**
 * Outlook / Microsoft Graph writer (broker executor). Constructed only by
 * trusted broker startup code; registered only when enabled (default off).
 *
 * Credential: a SEPARATE delegated token with Mail.Send (+ Mail.ReadWrite to
 * create the draft), distinct from the reader's Mail.Read token.
 *
 * Two-step send so the provider id exists before the irreversible call:
 *   1. GET /me → the token's mailbox must equal the approved sender.
 *   2. Create a draft (POST /me/messages, or createReply for threaded
 *      replies) with `Prefer: IdType="ImmutableId"` so the id survives the
 *      move to Sent Items; internetMessageId = <potts-{actionId}@domain> and
 *      an X-Potts-Action internet header carry the idempotency key.
 *   3. Read the draft back and verify recipients/subject/body equal the
 *      approved payload (catches server-side additions on createReply).
 *   4. Persist the immutable id (writer_provider_refs) BEFORE sending.
 *   5. POST /me/messages/{id}/send (single call).
 *
 * lookup(): for every persisted id, GET it: isDraft=false → found. If no id
 * was ever persisted, send was never called → not_found. A still-draft
 * message is "not sent" only after the settle window (send is asynchronous).
 * A missing id (404) falls back to a Sent Items filter on internetMessageId.
 */
import type { Clock } from '../../core/clock.ts';
import { systemClock } from '../../core/clock.ts';
import { ExecutorRejectedError, type DispatchIntent, type ExecutorReceipt, type LookupResult } from '../../broker/executor.ts';
import { enforceApproval, loadVerifiedAttachments, verifyMessageIntent, type ApprovalCheck, type AttachmentStore, type MessageKind, type WriterIdentity } from '../writers/writer-guard.ts';
import {
  classifySendResponse, getToken, messageIdFor, POTTS_ACTION_HEADER, preSendFetch, settled, UncertainProviderError,
  type FetchLike, type ProviderRefStore, type TokenProvider,
} from '../writers/writer-support.ts';
import type { MessagePayload } from '../writers/writer-payload.ts';
import type { WriterExecutor } from '../gmail/writer.ts';

export const GRAPH_SEND_SCOPES = ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.ReadWrite'] as const;
export const GRAPH_LOOKUP_SCOPES = ['https://graph.microsoft.com/Mail.Read'] as const;
const API = 'https://graph.microsoft.com/v1.0';
/** Graph's limit for attachments sent inline in a create request. */
export const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const REF_KIND = 'graph_message_id';

export interface OutlookWriterOptions extends WriterIdentity {
  tokens: TokenProvider;
  refs: ProviderRefStore;
  fetch?: FetchLike;
  clock?: Clock;
  attachments?: AttachmentStore;
  approvalCheck?: ApprovalCheck;
  kinds?: readonly MessageKind[];
  timeoutMs?: number;
  lookupSettleSeconds?: number;
  apiBase?: string;
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
const recips = (l: string[] | undefined) => (l ?? []).map((address) => ({ emailAddress: { address } }));
const addrs = (l: { emailAddress?: { address?: string } }[] | undefined) => (l ?? []).map((r) => (r.emailAddress?.address ?? '').toLowerCase()).sort();

export function createOutlookWriter(o: OutlookWriterOptions): WriterExecutor {
  const fetchFn = o.fetch ?? (globalThis.fetch as FetchLike);
  const clock = o.clock ?? systemClock;
  const kinds = o.kinds ?? (['send_message'] as const);
  const api = o.apiBase ?? API;
  const settleSeconds = o.lookupSettleSeconds ?? 600;
  const who: WriterIdentity = { accountId: o.accountId, accountAddress: o.accountAddress };
  const name = `outlook-writer:${o.accountId}`;
  const H = (token: string, json = false): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    prefer: 'IdType="ImmutableId"',
    ...(json ? { 'content-type': 'application/json' } : {}),
  });

  const verifyDraft = (d: Record<string, unknown>, p: MessagePayload) => {
    const body = d.body as { content?: string; contentType?: string } | undefined;
    const problems: string[] = [];
    if ((d.subject ?? '') !== (p.subject ?? '')) problems.push('subject');
    if ((body?.contentType ?? '').toLowerCase() !== 'text' || norm(body?.content ?? '') !== norm(p.body)) problems.push('body');
    const lc = (l?: string[]) => (l ?? []).map((x) => x.toLowerCase()).sort();
    if (addrs(d.toRecipients as never).join() !== lc(p.to).join()) problems.push('to');
    if (addrs(d.ccRecipients as never).join() !== lc(p.cc).join()) problems.push('cc');
    if (addrs(d.bccRecipients as never).join() !== lc(p.bcc).join()) problems.push('bcc');
    if (problems.length) throw new ExecutorRejectedError(`draft created by Graph differs from the approved payload (${problems.join(', ')}); not sent`);
  };

  return {
    name,
    integration: 'outlook',
    kinds: [...kinds],
    accountId: o.accountId,
    accountAddress: o.accountAddress,
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),

    async execute(intent: Readonly<DispatchIntent>, signal: AbortSignal): Promise<ExecutorReceipt> {
      const p = verifyMessageIntent(intent, who, { kinds, channel: 'email' });
      enforceApproval(o.approvalCheck, intent);
      const atts = await loadVerifiedAttachments(o.attachments, p.attachments ?? []);
      if (atts.reduce((n, a) => n + a.size, 0) > GRAPH_INLINE_ATTACHMENT_LIMIT) throw new ExecutorRejectedError('attachments exceed 3 MB; Graph upload sessions are not implemented');
      const token = await getToken(o.tokens, o.accountId, GRAPH_SEND_SCOPES);

      const me = await preSendFetch(fetchFn, `${api}/me?$select=mail,userPrincipalName`, { headers: H(token), signal }, 'graph identity check');
      if (!me.ok) throw new ExecutorRejectedError(`graph identity check failed (HTTP ${me.status}); nothing sent`);
      const mj = (await me.json()) as { mail?: string | null; userPrincipalName?: string };
      const ids = [mj.mail, mj.userPrincipalName].filter((x): x is string => !!x).map((x) => x.toLowerCase());
      if (!ids.includes(o.accountAddress.toLowerCase())) throw new ExecutorRejectedError('send credential belongs to a different mailbox than the approved sender account');

      const internetMessageId = messageIdFor(intent.idempotencyKey, o.accountAddress);
      const headers = [{ name: POTTS_ACTION_HEADER, value: intent.idempotencyKey }];
      const content = {
        subject: p.subject ?? '',
        body: { contentType: 'Text', content: p.body },
        toRecipients: recips(p.to),
        ccRecipients: recips(p.cc),
        bccRecipients: recips(p.bcc),
      };
      let draftId: string;
      if (p.reply?.providerMessageId) {
        const r = await preSendFetch(fetchFn, `${api}/me/messages/${encodeURIComponent(p.reply.providerMessageId)}/createReply`, {
          method: 'POST', headers: H(token, true), body: JSON.stringify({ message: { internetMessageHeaders: headers } }), signal,
        }, 'graph createReply');
        if (!r.ok) throw new ExecutorRejectedError(`graph createReply refused (HTTP ${r.status}); nothing sent`);
        draftId = ((await r.json()) as { id: string }).id;
        const u = await preSendFetch(fetchFn, `${api}/me/messages/${encodeURIComponent(draftId)}`, { method: 'PATCH', headers: H(token, true), body: JSON.stringify(content), signal }, 'graph draft update');
        if (!u.ok) throw new ExecutorRejectedError(`graph draft update refused (HTTP ${u.status}); nothing sent`);
      } else {
        const r = await preSendFetch(fetchFn, `${api}/me/messages`, {
          method: 'POST', headers: H(token, true), body: JSON.stringify({ ...content, internetMessageId, internetMessageHeaders: headers }), signal,
        }, 'graph create draft');
        if (!r.ok) throw new ExecutorRejectedError(`graph create draft refused (HTTP ${r.status}); nothing sent`);
        draftId = ((await r.json()) as { id: string }).id;
      }
      if (!draftId) throw new ExecutorRejectedError('graph returned no draft id; nothing sent');
      for (const a of atts) {
        const r = await preSendFetch(fetchFn, `${api}/me/messages/${encodeURIComponent(draftId)}/attachments`, {
          method: 'POST', headers: H(token, true), signal,
          body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: Buffer.from(a.bytes).toString('base64') }),
        }, 'graph add attachment');
        if (!r.ok) throw new ExecutorRejectedError(`graph add attachment refused (HTTP ${r.status}); nothing sent`);
      }
      const g = await preSendFetch(fetchFn, `${api}/me/messages/${encodeURIComponent(draftId)}?$select=subject,body,toRecipients,ccRecipients,bccRecipients,isDraft`, { headers: { ...H(token), prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' }, signal }, 'graph draft read-back');
      if (!g.ok) throw new ExecutorRejectedError(`graph draft read-back failed (HTTP ${g.status}); nothing sent`);
      verifyDraft((await g.json()) as Record<string, unknown>, p);

      // Persist before the irreversible call so lookup() can always find it.
      o.refs.put({ actionId: intent.actionId, dispatchId: intent.dispatchId, attempt: intent.attempt, writer: name, refKind: REF_KIND, refValue: draftId });

      let res: Response;
      try {
        res = await fetchFn(`${api}/me/messages/${encodeURIComponent(draftId)}/send`, { method: 'POST', headers: H(token), signal });
      } catch (e) {
        throw new UncertainProviderError(`graph send: ${(e as Error).message}; outcome unknown`);
      }
      await classifySendResponse(res, 'graph send');
      return { providerOperationId: `graph:${draftId}`, detail: { internetMessageId } };
    },

    async lookup(intent: Readonly<DispatchIntent>): Promise<LookupResult> {
      const refs = o.refs.forAction(intent.actionId, REF_KIND);
      if (refs.length === 0) return { status: 'not_found' }; // send is only ever called after the id is persisted
      let token: string;
      try {
        token = await o.tokens.getAccessToken({ accountId: o.accountId, purpose: 'lookup', scopes: GRAPH_LOOKUP_SCOPES });
      } catch (e) {
        return { status: 'unknown', reason: `no lookup credential: ${(e as Error).message}` };
      }
      try {
        let allDraftsSettled = true;
        for (const ref of refs) {
          const r = await fetchFn(`${api}/me/messages/${encodeURIComponent(ref.refValue)}?$select=isDraft,internetMessageId,sentDateTime`, { headers: H(token) });
          if (r.status === 404) {
            const imid = messageIdFor(intent.idempotencyKey, o.accountAddress);
            const f = await fetchFn(`${api}/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`internetMessageId eq '${imid.replace(/'/g, "''")}'`)}&$select=id`, { headers: H(token) });
            if (!f.ok) return { status: 'unknown', reason: `graph sentitems filter HTTP ${f.status}` };
            const fj = (await f.json()) as { value?: { id: string }[] };
            if (fj.value?.length) return { status: 'found', providerOperationId: `graph:${fj.value[0]!.id}`, detail: { via: 'internetMessageId' } };
            return { status: 'unknown', reason: 'persisted message id no longer exists and Sent Items has no match' };
          }
          if (!r.ok) return { status: 'unknown', reason: `graph get HTTP ${r.status}` };
          const j = (await r.json()) as { isDraft?: boolean };
          if (j.isDraft === false) return { status: 'found', providerOperationId: `graph:${ref.refValue}`, detail: { via: 'immutable-id' } };
          if (!settled(clock, ref.createdAt, settleSeconds)) allDraftsSettled = false;
        }
        return allDraftsSettled ? { status: 'not_found' } : { status: 'unknown', reason: 'message still a draft; Graph send is asynchronous, waiting for the settle window' };
      } catch (e) {
        return { status: 'unknown', reason: `graph lookup failed: ${(e as Error).message}` };
      }
    },
  };
}
