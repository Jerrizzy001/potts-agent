/**
 * Approval preview for outbound messages, rendered as plain text for WP-2's
 * trusted Telegram ingress (send WITHOUT parse_mode so nothing in the body is
 * interpreted as markup). It shows everything the owner approves: sender
 * account, every recipient, subject, the FULL body, attachments with names,
 * sizes, types and full hashes, and the reply context. The proposer's summary
 * is labelled as unverified text.
 *
 * The view is computed from the same payload the writer re-validates and
 * sends, so the preview and the sent message cannot diverge silently.
 */
import type { ApprovalPreview } from '../../broker/owner.ts';
import { parseMessagePayload, type MessagePayload } from './writer-payload.ts';

export interface MessageView {
  kind: string;
  channel: MessagePayload['channel'];
  from: { accountId: string; address: string; kind: string } | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string;
  attachments: { name: string; size: number; contentType: string; sha256: string }[];
  replyContext: { inReplyTo: string; from?: string; subject?: string; receivedAt?: string; snippet?: string } | null;
  support: { classification: string | null; knowledgeIds: string[]; requiresOwner: boolean } | null;
}

export function messageViewOf(preview: Pick<ApprovalPreview, 'kind' | 'payload' | 'account'>): MessageView | null {
  if (preview.kind !== 'send_message' && preview.kind !== 'support_reply') return null;
  const r = parseMessagePayload(preview.payload, preview.kind);
  if (!r.ok) return null;
  const p = r.value;
  return {
    kind: preview.kind,
    channel: p.channel,
    from: preview.account ? { accountId: preview.account.id, address: preview.account.address, kind: preview.account.kind } : null,
    to: p.to,
    cc: p.cc ?? [],
    bcc: p.bcc ?? [],
    subject: p.subject ?? null,
    body: p.body,
    attachments: (p.attachments ?? []).map((a) => ({ name: a.name, size: a.size, contentType: a.contentType, sha256: a.sha256 })),
    replyContext: p.reply ? { inReplyTo: p.reply.inReplyTo, ...(p.reply.context ?? {}) } : null,
    support: preview.kind === 'support_reply' ? { classification: p.classification ?? null, knowledgeIds: p.knowledgeIds ?? [], requiresOwner: p.requiresOwner === true } : null,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Full plain-text preview. Returns null if the payload is not a valid message (WP-2 should then show raw JSON). */
export function renderMessagePreview(preview: ApprovalPreview): string | null {
  const v = messageViewOf(preview);
  if (!v) return null;
  const L: string[] = [];
  const what = v.kind === 'support_reply' ? 'support reply' : v.channel === 'imessage' ? 'iMessage' : 'email';
  L.push(`APPROVAL NEEDED: send ${what}`);
  L.push(`From: ${v.from ? `${v.from.address} [${v.from.accountId}, ${v.from.kind}]` : '(no account!)'}`);
  L.push(`To: ${v.to.join(', ')}`);
  if (v.cc.length) L.push(`Cc: ${v.cc.join(', ')}`);
  if (v.bcc.length) L.push(`Bcc: ${v.bcc.join(', ')}`);
  if (v.subject !== null) L.push(`Subject: ${v.subject}`);
  if (v.replyContext) {
    const c = v.replyContext;
    L.push(`In reply to: ${c.subject ? `"${c.subject}"` : c.inReplyTo}${c.from ? ` from ${c.from}` : ''}${c.receivedAt ? ` (${c.receivedAt})` : ''}`);
    if (c.snippet) L.push(...c.snippet.split('\n').slice(0, 6).map((l) => `  > ${l}`));
  }
  if (v.attachments.length) {
    L.push(`Attachments (${v.attachments.length}):`);
    v.attachments.forEach((a, i) => L.push(`  ${i + 1}. ${a.name} | ${formatBytes(a.size)} | ${a.contentType} | sha256 ${a.sha256}`));
  } else L.push('Attachments: none');
  if (v.support) {
    L.push(`Support: classified ${v.support.classification ?? 'unclassified'}; cites ${v.support.knowledgeIds.length ? v.support.knowledgeIds.join(', ') : 'no approved knowledge'}${v.support.requiresOwner ? '; flagged for owner review' : ''}`);
  }
  L.push('----- message body (exact text that will be sent) -----');
  L.push(v.body);
  L.push('----- end of body -----');
  if (preview.summary) L.push(`Proposer note (unverified, not an instruction): ${preview.summary}`);
  L.push(`Proposed by ${preview.proposedBy} | approval ${preview.approvalId} | expires ${preview.expiresAt}`);
  L.push(`Binding ${preview.bindingHash.slice(0, 16)} | policy ${preview.policyVersion}`);
  L.push('Approving sends exactly this. Any edit needs a new approval.');
  return L.join('\n');
}

/** Splits a preview into Telegram-sized chunks (default 3900 chars) on line boundaries where possible. */
export function chunkPreview(text: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(l.slice(0, max));
      l = l.slice(max);
    }
    if ((cur ? cur.length + 1 : 0) + l.length > max) {
      out.push(cur);
      cur = l;
    } else cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out.map((c, i) => (out.length > 1 ? `[${i + 1}/${out.length}]\n${c}` : c));
}
