export interface MailAddress {
  address: string;
  name: string | null;
}

export interface MailAttachmentMeta {
  name: string;
  mimeType: string;
  size: number;
  /** Provider attachment id so a later, explicit step could fetch it. Never downloaded by default. */
  providerAttachmentId: string | null;
  inline: boolean;
}

/** Provider-neutral message as produced by the Gmail and Outlook readers. */
export interface NormalizedMail {
  accountId: string;
  provider: 'gmail' | 'outlook';
  providerMessageId: string;
  threadId: string | null;
  internetMessageId: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodySource: 'text' | 'html' | 'none';
  receivedAt: string | null;
  labels: string[];
  /** Selected headers, lower-cased names (list-unsubscribe, list-id, precedence, auto-submitted, ...). */
  headers: Record<string, string>;
  attachments: MailAttachmentMeta[];
  /** Reader-detected content flags, e.g. 'hidden_html_text', 'hidden_instructions'. */
  contentFlags: string[];
}

/** Headers kept from providers; everything else is discarded. */
export const KEPT_HEADERS = [
  'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'precedence', 'auto-submitted', 'x-auto-response-suppress',
  'reply-to', 'return-path', 'in-reply-to', 'references', 'x-mailer', 'feedback-id', 'x-campaign', 'x-mailgun-tag',
] as const;

/** Parses "Name <addr@x>" / "addr@x" header values, comma separated (quotes respected). */
export function parseAddressList(v: string | undefined | null): MailAddress[] {
  if (!v) return [];
  const parts: string[] = [];
  let cur = '';
  let q = false;
  let angle = 0;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (!q && ch === '<') angle++;
    if (!q && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !q && angle === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: MailAddress[] = [];
  for (const p of parts) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(p);
    if (m) out.push({ address: m[2]!.trim().toLowerCase(), name: m[1]?.trim() || null });
    else if (p.includes('@')) out.push({ address: p.trim().toLowerCase(), name: null });
  }
  return out;
}

export function domainOf(address: string | undefined | null): string {
  if (!address) return '';
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}
