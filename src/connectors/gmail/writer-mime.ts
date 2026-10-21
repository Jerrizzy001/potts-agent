/**
 * In-house RFC 5322 / MIME (RFC 2045-2047, 2231) builder for the Gmail
 * writer. Text bodies and attachments are base64 encoded (76-char lines), so
 * no body content can ever be interpreted as headers or boundaries. Header
 * values are validated upstream (no CR/LF); non-ASCII subjects use RFC 2047
 * encoded-words. Includes a small parser used by tests and lookup checks.
 */
import { createHash } from 'node:crypto';

export interface MimeAttachment {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface MimeMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  messageId: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  /** Extra X- headers (validated: name is X-[A-Za-z-]+, value has no CR/LF). */
  extraHeaders?: Record<string, string>;
  attachments?: MimeAttachment[];
}

const CRLF = '\r\n';
const isAscii = (s: string) => /^[\x20-\x7E]*$/.test(s);

export function base64Lines(b: Uint8Array | string): string {
  const s = Buffer.from(b).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}

/** RFC 2047 B-encoding, split on UTF-8 character boundaries, each word <= 75 chars. */
export function encodeHeaderWords(value: string): string {
  if (isAscii(value) && value.length <= 900) return value;
  const words: string[] = [];
  let chunk = '';
  const maxRaw = 45; // 45 bytes -> 60 base64 chars + 12 overhead = 72 <= 75
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > maxRaw) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(`${CRLF} `);
}

function formatDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

function filenameParam(name: string): string {
  if (isAscii(name)) return `filename="${name}"`;
  return `filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`header ${name} contains a line break`);
}

export function boundaryFor(messageId: string): string {
  // '_' never appears in base64 output, so the boundary cannot collide with encoded content.
  return `potts_${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
}

/** Builds the complete message with CRLF line endings. */
export function buildMime(m: MimeMessage): string {
  const headers: [string, string][] = [
    ['From', m.from],
    ['To', m.to.join(', ')],
  ];
  if (m.cc?.length) headers.push(['Cc', m.cc.join(', ')]);
  if (m.bcc?.length) headers.push(['Bcc', m.bcc.join(', ')]);
  headers.push(['Subject', encodeHeaderWords(m.subject)], ['Date', formatDate(m.date)], ['Message-ID', m.messageId]);
  if (m.inReplyTo) headers.push(['In-Reply-To', m.inReplyTo]);
  const refs = m.references?.length ? m.references : m.inReplyTo ? [m.inReplyTo] : [];
  if (refs.length) headers.push(['References', refs.join(`${CRLF} `)]);
  for (const [k, v] of Object.entries(m.extraHeaders ?? {})) {
    if (!/^X-[A-Za-z0-9-]+$/.test(k)) throw new Error(`extra header ${k} must be an X- header`);
    headers.push([k, v]);
  }
  headers.push(['MIME-Version', '1.0']);
  for (const [k, v] of headers) assertHeaderSafe(k, v.replace(/\r\n /g, ''));

  const textPart = [`Content-Type: text/plain; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', base64Lines(m.body)].join(CRLF);
  const head = headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
  if (!m.attachments?.length) return `${head}${CRLF}${textPart}${CRLF}`;

  const boundary = boundaryFor(m.messageId);
  const parts = [textPart];
  for (const a of m.attachments) {
    assertHeaderSafe('filename', a.name);
    parts.push(
      [
        `Content-Type: ${a.contentType}; name="${isAscii(a.name) ? a.name : 'attachment'}"`,
        `Content-Disposition: attachment; ${filenameParam(a.name)}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(a.bytes),
      ].join(CRLF),
    );
  }
  const body = parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join('') + `--${boundary}--${CRLF}`;
  return `${head}${CRLF}Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}${body}`;
}

export const toBase64Url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

// ---------------------------------------------------------------- parser

export interface ParsedMime {
  headers: Map<string, string>;
  subject: string;
  body: string;
  attachments: { name: string; contentType: string; bytes: Buffer; sha256: string }[];
}

function decodeWords(v: string): string {
  return v.replace(/\r\n /g, ' ').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=(\s+(?==\?UTF-8\?B\?))?/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function splitHeaders(block: string): Map<string, string> {
  const unfolded = block.replace(/\r\n[ \t]/g, '\r\n ').split(CRLF);
  const out = new Map<string, string>();
  let last = '';
  for (const line of unfolded) {
    if (line.startsWith(' ') && last) {
      out.set(last, `${out.get(last)}\r\n${line}`);
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    last = line.slice(0, i).toLowerCase();
    out.set(last, line.slice(i + 1).trim());
  }
  return out;
}

/** Minimal parser for messages produced by buildMime (and similar simple messages). */
export function parseMime(raw: string): ParsedMime {
  const sep = raw.indexOf(CRLF + CRLF);
  const headers = splitHeaders(raw.slice(0, sep));
  const rest = raw.slice(sep + 4);
  const subject = decodeWords(headers.get('subject') ?? '');
  const ct = headers.get('content-type') ?? 'text/plain';
  const attachments: ParsedMime['attachments'] = [];
  let body = '';
  const decodePart = (h: Map<string, string>, content: string) => {
    const enc = (h.get('content-transfer-encoding') ?? '').toLowerCase();
    return enc === 'base64' ? Buffer.from(content.replace(/\r\n/g, ''), 'base64') : Buffer.from(content, 'utf8');
  };
  if (/^multipart\//i.test(ct)) {
    const b = /boundary="([^"]+)"/.exec(ct)?.[1];
    if (!b) throw new Error('multipart without boundary');
    const segments = rest.split(`--${b}`).slice(1);
    for (const seg of segments) {
      if (seg.startsWith('--')) break;
      const s = seg.replace(/^\r\n/, '').replace(/\r\n$/, '');
      const i = s.indexOf(CRLF + CRLF);
      const ph = splitHeaders(s.slice(0, i));
      const content = s.slice(i + 4);
      const bytes = decodePart(ph, content);
      const disp = ph.get('content-disposition') ?? '';
      if (/^attachment/i.test(disp)) {
        const star = /filename\*=UTF-8''([^;\s]+)/i.exec(disp)?.[1];
        const name = star ? decodeURIComponent(star) : (/filename="([^"]*)"/.exec(disp)?.[1] ?? '');
        attachments.push({ name, contentType: (ph.get('content-type') ?? '').split(';')[0]!.trim(), bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
      } else body = bytes.toString('utf8');
    }
  } else {
    body = decodePart(headers, rest.replace(/\r\n$/, '')).toString('utf8');
  }
  return { headers, subject, body, attachments };
}
