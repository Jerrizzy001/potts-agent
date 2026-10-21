import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted (code-point order), no whitespace,
 * `undefined` object members omitted, arrays keep order. Rejects values that
 * JSON cannot represent faithfully (NaN/Infinity, bigint, functions, symbols,
 * cyclic structures) so two different values can never hash the same.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
        return JSON.stringify(v);
      case 'object': {
        if (seen.has(v as object)) throw new TypeError('canonicalJson: cyclic structure');
        seen.add(v as object);
        let out: string;
        if (Array.isArray(v)) {
          out = '[' + v.map((x) => (x === undefined ? 'null' : walk(x))).join(',') + ']';
        } else if (v instanceof Date) {
          out = JSON.stringify(v.toISOString());
        } else {
          const obj = v as Record<string, unknown>;
          const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
          out = '{' + keys.map((k) => JSON.stringify(k) + ':' + walk(obj[k])).join(',') + '}';
        }
        seen.delete(v as object);
        return out;
      }
      default:
        throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
    }
  };
  return walk(value);
}

/** SHA-256 hex digest of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 hex over the canonical JSON of a value. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** HMAC-SHA256 hex. */
export function hmacSha256Hex(key: string | Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time comparison of two hex strings (false on length/format mismatch). */
export function hexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
