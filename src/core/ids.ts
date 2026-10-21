import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from './clock.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID-like identifier: 10 chars of millisecond timestamp + 16 chars of
 * randomness (Crockford base32). Lexicographically sortable by creation time.
 * An optional prefix (e.g. "act", "apr") is joined with "_".
 */
export function newId(prefix?: string, clock: Clock = systemClock): string {
  let t = clock.nowMs();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  const id = time + rand;
  return prefix ? `${prefix}_${id}` : id;
}
