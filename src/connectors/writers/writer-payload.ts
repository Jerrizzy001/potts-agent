/**
 * The payload contract for outbound personal messages (`send_message`) and
 * support replies (`support_reply`). Proposers (drafts workflow, support
 * engine, owner instructions) build this JSON; the broker hashes it and binds
 * the hash into the owner's approval; writers re-validate and re-hash it at
 * execute time and render exactly this content — nothing else — to the
 * provider.
 *
 * Recipients: `action.destination` must be exactly the sorted, de-duplicated
 * union of `to`, `cc` and `bcc` (the broker sorts destination). Attachments:
 * `payload.attachments` carries {name, sha256, contentType, size} so content
 * type and size are bound by the payload hash too; `action.attachments`
 * ({name, sha256}) must describe the same set.
 */
import { ok, perr, type Result } from '../../core/result.ts';
import { SHA256_HEX } from '../../core/hash.ts';

export const MESSAGE_CHANNELS = ['email', 'imessage'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface ReplyContext {
  /** RFC 5322 Message-ID of the message being answered, with angle brackets. */
  inReplyTo: string;
  /** Prior References chain (oldest first), with angle brackets. */
  references?: string[];
  /** Provider thread id (Gmail threadId) so the reply lands in the same thread. */
  providerThreadId?: string;
  /** Provider message id of the original (Graph message id; used for createReply). */
  providerMessageId?: string;
  /** Shown to the owner in the approval preview only; never sent. */
  context?: { from?: string; subject?: string; receivedAt?: string; snippet?: string };
}

export interface PayloadAttachment {
  name: string;
  sha256: string;
  contentType: string;
  size: number;
}

export interface MessagePayload {
  channel: MessageChannel;
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** Required for email; must be absent for iMessage. */
  subject?: string;
  /** Plain-text body; sent exactly as approved. */
  body: string;
  reply?: ReplyContext;
  attachments?: PayloadAttachment[];
  // support_reply only (read by policy decide()):
  classification?: string;
  knowledgeIds?: string[];
  requiresOwner?: boolean;
  kbVersion?: string;
  supportDraftId?: string;
}

export const PAYLOAD_LIMITS = {
  maxBodyChars: 100_000,
  maxSubjectChars: 998,
  maxRecipients: 50,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxImessageChars: 10_000,
} as const;

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const MSGID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;
// eslint-disable-next-line no-control-regex
const CTRL_EXCEPT_TAB_NL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const ANY_CRLF_OR_CTRL = /[\u0000-\u001F\u007F]/;

export const isEmailAddress = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s);
export const isE164 = (s: string): boolean => E164_RE.test(s);
export const isImessageHandle = (s: string): boolean => isE164(s) || isEmailAddress(s);

const SUPPORT_KEYS = ['classification', 'knowledgeIds', 'requiresOwner', 'kbVersion', 'supportDraftId'];
const BASE_KEYS = ['channel', 'to', 'cc', 'bcc', 'subject', 'body', 'reply', 'attachments'];

const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Strict parser. Unknown fields are rejected so that nothing outside the
 * documented shape can ride along in an approved payload.
 */
export function parseMessagePayload(raw: unknown, kind: 'send_message' | 'support_reply' = 'send_message'): Result<MessagePayload> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return perr('invalid_input', 'message payload must be an object');
  const p = raw as Record<string, unknown>;
  const allowed = new Set(kind === 'support_reply' ? [...BASE_KEYS, ...SUPPORT_KEYS] : BASE_KEYS);
  for (const k of Object.keys(p)) if (!allowed.has(k)) return perr('invalid_input', `unknown message payload field "${k}"`);
  if (p.channel !== 'email' && p.channel !== 'imessage') return perr('invalid_input', 'payload.channel must be "email" or "imessage"');
  const channel = p.channel;
  for (const f of ['to', 'cc', 'bcc'] as const) {
    if (p[f] !== undefined && !strArr(p[f])) return perr('invalid_input', `payload.${f} must be an array of strings`);
  }
  const to = (p.to as string[] | undefined) ?? [];
  const cc = (p.cc as string[] | undefined) ?? [];
  const bcc = (p.bcc as string[] | undefined) ?? [];
  if (to.length === 0) return perr('invalid_input', 'payload.to must name at least one recipient');
  const all = [...to, ...cc, ...bcc];
  if (all.length > PAYLOAD_LIMITS.maxRecipients) return perr('invalid_input', 'too many recipients');
  if (new Set(all.map((a) => a.toLowerCase())).size !== all.length) return perr('invalid_input', 'a recipient appears more than once');
  if (typeof p.body !== 'string') return perr('invalid_input', 'payload.body must be a string');
  if (p.body.length === 0) return perr('invalid_input', 'payload.body is empty');
  if (CTRL_EXCEPT_TAB_NL.test(p.body)) return perr('invalid_input', 'payload.body contains control characters');

  if (channel === 'email') {
    for (const a of all) if (!isEmailAddress(a)) return perr('invalid_input', `not a plain email address: ${JSON.stringify(a)}`);
    if (typeof p.subject !== 'string') return perr('invalid_input', 'email payload requires a subject string');
    if (p.subject.length > PAYLOAD_LIMITS.maxSubjectChars || ANY_CRLF_OR_CTRL.test(p.subject)) return perr('invalid_input', 'subject contains line breaks/control characters or is too long');
    if (p.body.length > PAYLOAD_LIMITS.maxBodyChars) return perr('invalid_input', 'body too long');
  } else {
    if (cc.length || bcc.length) return perr('invalid_input', 'iMessage has no cc/bcc');
    if (to.length !== 1) return perr('invalid_input', 'iMessage writer sends to exactly one handle (group chats unsupported)');
    if (!isImessageHandle(to[0]!)) return perr('invalid_input', 'iMessage recipient must be an E.164 phone number or an email handle');
    if (p.subject !== undefined) return perr('invalid_input', 'iMessage payload has no subject');
    if (p.body.length > PAYLOAD_LIMITS.maxImessageChars) return perr('invalid_input', 'iMessage body too long');
    if (p.attachments !== undefined && (!Array.isArray(p.attachments) || p.attachments.length)) return perr('invalid_input', 'iMessage attachments are not supported');
    if (p.reply !== undefined) return perr('invalid_input', 'iMessage reply context is not supported');
  }

  let reply: ReplyContext | undefined;
  if (p.reply !== undefined) {
    const r = p.reply as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return perr('invalid_input', 'payload.reply must be an object');
    for (const k of Object.keys(r)) if (!['inReplyTo', 'references', 'providerThreadId', 'providerMessageId', 'context'].includes(k)) return perr('invalid_input', `unknown reply field ${k}`);
    if (typeof r.inReplyTo !== 'string' || !MSGID_RE.test(r.inReplyTo)) return perr('invalid_input', 'reply.inReplyTo must be an <id@host> Message-ID');
    if (r.references !== undefined && (!strArr(r.references) || !r.references.every((x) => MSGID_RE.test(x)))) return perr('invalid_input', 'reply.references must be Message-IDs');
    for (const k of ['providerThreadId', 'providerMessageId'] as const) {
      if (r[k] !== undefined && (typeof r[k] !== 'string' || !/^[A-Za-z0-9_=+/-]{1,512}$/.test(r[k]))) return perr('invalid_input', `reply.${k} is malformed`);
    }
    if (r.context !== undefined && (typeof r.context !== 'object' || r.context === null || Array.isArray(r.context))) return perr('invalid_input', 'reply.context must be an object');
    reply = r as unknown as ReplyContext;
  }

  let attachments: PayloadAttachment[] | undefined;
  if (p.attachments !== undefined) {
    if (!Array.isArray(p.attachments)) return perr('invalid_input', 'payload.attachments must be an array');
    attachments = [];
    for (const a of p.attachments as unknown[]) {
      const x = a as Record<string, unknown>;
      if (!x || typeof x !== 'object' || Object.keys(x).some((k) => !['name', 'sha256', 'contentType', 'size'].includes(k))) return perr('invalid_input', 'attachment must be {name, sha256, contentType, size}');
      if (typeof x.name !== 'string' || !x.name || x.name.length > 255 || ANY_CRLF_OR_CTRL.test(x.name) || /[/\\"]/.test(x.name)) return perr('invalid_input', 'attachment name is invalid');
      if (typeof x.sha256 !== 'string' || !SHA256_HEX.test(x.sha256)) return perr('invalid_input', 'attachment sha256 must be lowercase hex');
      if (typeof x.contentType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(x.contentType)) return perr('invalid_input', 'attachment contentType is invalid');
      if (typeof x.size !== 'number' || !Number.isInteger(x.size) || x.size < 0 || x.size > PAYLOAD_LIMITS.maxAttachmentBytes) return perr('invalid_input', 'attachment size is invalid');
      attachments.push({ name: x.name, sha256: x.sha256, contentType: x.contentType, size: x.size });
    }
  }

  if (kind === 'support_reply') {
    if (p.knowledgeIds !== undefined && !strArr(p.knowledgeIds)) return perr('invalid_input', 'knowledgeIds must be strings');
    if (p.requiresOwner !== undefined && typeof p.requiresOwner !== 'boolean') return perr('invalid_input', 'requiresOwner must be boolean');
    for (const k of ['classification', 'kbVersion', 'supportDraftId'] as const) if (p[k] !== undefined && typeof p[k] !== 'string') return perr('invalid_input', `${k} must be a string`);
  }

  const out: MessagePayload = { channel, to: [...to], body: p.body };
  if (cc.length) out.cc = [...cc];
  if (bcc.length) out.bcc = [...bcc];
  if (typeof p.subject === 'string') out.subject = p.subject;
  if (reply) out.reply = reply;
  if (attachments?.length) out.attachments = attachments;
  for (const k of SUPPORT_KEYS) if (p[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = p[k];
  return ok(out);
}

/** Sorted recipient list exactly as the broker stores `destination`. */
export const recipientsOf = (p: Pick<MessagePayload, 'to' | 'cc' | 'bcc'>): string[] => [...p.to, ...(p.cc ?? []), ...(p.bcc ?? [])].sort();
