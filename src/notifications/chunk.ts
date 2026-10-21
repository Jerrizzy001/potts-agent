import { TELEGRAM_MAX_CHARS } from './channel.ts';

/**
 * Splits text into chunks of at most `max` characters, preferring paragraph,
 * then line, then word boundaries. Never returns an empty chunk.
 * Counts UTF-16 code units (what Telegram's 4096 limit counts) and never
 * splits a surrogate pair.
 */
export function chunkText(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  if (max < 16) throw new Error('chunkText: max too small');
  const out: string[] = [];
  let rest = text.replace(/\s+$/, '');
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.4) cut = window.lastIndexOf('\n');
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut < max * 0.4) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // keep surrogate pairs together
    }
    const piece = rest.slice(0, cut).replace(/\s+$/, '');
    if (piece) out.push(piece);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

/** Chunks and, when there are several parts, labels them "(1/3)" while staying within `max`. */
export function chunkWithLabels(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  const first = chunkText(text, max);
  if (first.length === 1) return first;
  const labelRoom = 12; // " (99/99)\n" headroom
  const parts = chunkText(text, max - labelRoom);
  return parts.map((p, i) => `(${i + 1}/${parts.length})\n${p}`);
}
