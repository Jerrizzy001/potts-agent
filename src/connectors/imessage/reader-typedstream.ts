/**
 * Best-effort decoder for Messages' `message.attributedBody` column: an
 * NSAttributedString archived with NSArchiver's "typedstream" format.
 *
 * Layout of the part we need (observed on macOS 11–15):
 *
 *   04 0B "streamtyped" 81 E8 03          header (version 1000)
 *   84 01 40 84 84 84 12 "NSAttributedString" 00 ...  class chain
 *   ... 84 84 84 08 "NSString" 01 94      NSString (or NSMutableString) class
 *   84 01 2B <len> <len bytes of UTF-8>   type "+" then the string bytes
 *
 * <len> is a typedstream integer: a byte < 0x80 is the value itself, 0x81 is
 * followed by a little-endian uint16, 0x82 by a little-endian uint32.
 *
 * Strategy: (1) find the NSString/NSMutableString class name and read the
 * first "+" string after it; (2) otherwise scan the blob for any well-formed
 * "+"-typed UTF-8 run that looks like text. Returns null if nothing decodes.
 * Never throws on malformed input.
 */

const enc = new TextEncoder();
const CLASS_MARKERS = [enc.encode('NSString'), enc.encode('NSMutableString')];
const HEADER = enc.encode('streamtyped');
const strict = new TextDecoder('utf-8', { fatal: true });

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Reads a typedstream integer at pos. Returns [value, bytesConsumed] or null. */
export function readTsInt(buf: Uint8Array, pos: number): [number, number] | null {
  if (pos >= buf.length) return null;
  const b = buf[pos]!;
  if (b === 0x81) {
    if (pos + 3 > buf.length) return null;
    return [buf[pos + 1]! | (buf[pos + 2]! << 8), 3];
  }
  if (b === 0x82) {
    if (pos + 5 > buf.length) return null;
    return [(buf[pos + 1]! | (buf[pos + 2]! << 8) | (buf[pos + 3]! << 16) | (buf[pos + 4]! << 24)) >>> 0, 5];
  }
  if (b < 0x80) return [b, 1];
  return null;
}

function decodeAt(buf: Uint8Array, plusPos: number): string | null {
  // plusPos points at the '+' (0x2B) type byte.
  const n = readTsInt(buf, plusPos + 1);
  if (!n) return null;
  const [len, used] = n;
  const start = plusPos + 1 + used;
  if (len === 0 || start + len > buf.length) return null;
  try {
    return strict.decode(buf.subarray(start, start + len));
  } catch {
    return null;
  }
}

function clean(s: string): string {
  return s.replace(/[￼�\u0000]/g, '').trim();
}

function looksLikeText(s: string): boolean {
  if (!s) return false;
  let ctrl = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) ctrl++;
  }
  return ctrl / s.length < 0.05 && !/^(NS[A-Z]\w+|__kIM\w+)$/.test(s);
}

export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 8) return null;
  const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Pass 1: the string that follows the NSString / NSMutableString class definition.
  for (const marker of CLASS_MARKERS) {
    let at = indexOf(buf, marker);
    while (at >= 0) {
      const end = at + marker.length;
      // The type tag 84 01 2B normally follows within a few bytes (class version + superclass ref).
      for (let i = end; i < Math.min(buf.length - 2, end + 40); i++) {
        if (buf[i] === 0x84 && buf[i + 1] === 0x01 && buf[i + 2] === 0x2b) {
          const s = decodeAt(buf, i + 2);
          if (s !== null) {
            const c = clean(s);
            if (c && looksLikeText(c)) return c;
          }
          break;
        }
      }
      at = indexOf(buf, marker, end);
    }
  }
  // Pass 2: any "+"-typed run after the header that decodes as text.
  const startScan = Math.max(0, indexOf(buf, HEADER));
  for (let i = startScan; i < buf.length - 2; i++) {
    if (buf[i] !== 0x2b) continue;
    if (i > 0 && buf[i - 1] !== 0x01) continue; // the type string "+" has length 1
    const s = decodeAt(buf, i);
    if (s === null) continue;
    const c = clean(s);
    if (c && looksLikeText(c)) return c;
  }
  return null;
}

/** Test/fixture helper: encodes a string the way Messages archives it. */
export function encodeAttributedBodyForTest(text: string, opts: { mutable?: boolean } = {}): Uint8Array {
  const bytes = enc.encode(text);
  const parts: number[] = [];
  const push = (...xs: number[]) => parts.push(...xs);
  const pushStr = (s: string) => push(...enc.encode(s));
  push(0x04, 0x0b);
  pushStr('streamtyped');
  push(0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84);
  const outer = opts.mutable ? 'NSMutableAttributedString' : 'NSAttributedString';
  push(outer.length);
  pushStr(outer);
  if (opts.mutable) {
    push(0x00, 0x84, 0x84, 0x12);
    pushStr('NSAttributedString');
  }
  push(0x00, 0x84, 0x84, 0x08);
  pushStr('NSObject');
  push(0x00, 0x85, 0x92, 0x84, 0x84, 0x84);
  const inner = opts.mutable ? 'NSMutableString' : 'NSString';
  push(inner.length);
  pushStr(inner);
  push(0x01, 0x94, 0x84, 0x01, 0x2b);
  if (bytes.length < 0x80) push(bytes.length);
  else if (bytes.length <= 0xffff) push(0x81, bytes.length & 0xff, bytes.length >> 8);
  else push(0x82, bytes.length & 0xff, (bytes.length >> 8) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >>> 24) & 0xff);
  for (const b of bytes) parts.push(b);
  // Trailing attribute run (NSDictionary with __kIMMessagePartAttributeName), as in real blobs.
  push(0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x05, 0x92, 0x84, 0x84, 0x84, 0x0c);
  pushStr('NSDictionary');
  push(0x00, 0x94, 0x84, 0x01, 0x69, 0x01, 0x92, 0x84, 0x96, 0x96, 0x1d);
  pushStr('__kIMMessagePartAttributeName');
  push(0x86, 0x92, 0x84, 0x84, 0x84, 0x08);
  pushStr('NSNumber');
  push(0x00, 0x84, 0x84, 0x07);
  pushStr('NSValue');
  push(0x00, 0x94, 0x84, 0x01, 0x2a, 0x84, 0x99, 0x99, 0x00, 0x86, 0x86, 0x86);
  return Uint8Array.from(parts);
}
