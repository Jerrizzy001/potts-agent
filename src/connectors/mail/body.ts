import { detectInjection } from './injection.ts';
import { hiddenTextOf, htmlToText } from './html.ts';

const MAX_BODY_CHARS = 200_000;

/**
 * Chooses the body text: prefer text/plain, fall back to stripped HTML.
 * Hidden HTML text is never included in the body; its presence is flagged
 * (and flagged more strongly if it contains instruction patterns).
 */
export function chooseBody(parts: { text?: string | null; html?: string | null }): { bodyText: string; bodySource: 'text' | 'html' | 'none'; contentFlags: string[] } {
  const flags: string[] = [];
  if (parts.html) {
    const hidden = hiddenTextOf(parts.html);
    if (hidden.length > 0) {
      flags.push('hidden_html_text');
      if (detectInjection(hidden).flagged) flags.push('hidden_instructions');
    }
  }
  if (parts.text && parts.text.trim()) return { bodyText: clip(parts.text.replace(/\r\n/g, '\n')), bodySource: 'text', contentFlags: flags };
  if (parts.html && parts.html.trim()) return { bodyText: clip(htmlToText(parts.html)), bodySource: 'html', contentFlags: flags };
  return { bodyText: '', bodySource: 'none', contentFlags: flags };
}

function clip(s: string): string {
  return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + '\n[truncated]' : s;
}

export function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const buf = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}
