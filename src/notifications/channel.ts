/**
 * Delivery channel to the owner (WP-2 provides the Telegram implementation).
 *
 * Contract:
 *  - `send` delivers exactly one message of at most TELEGRAM_MAX_CHARS chars.
 *  - Throw `OwnerChannelRejectedError` ONLY when the provider definitively did
 *    not deliver (HTTP 4xx before acceptance, 429 with retry_after, connection
 *    refused before the request was written). The outbox may retry those.
 *  - Any other error or a timeout is treated as UNCERTAIN: the outbox records it
 *    and never re-sends automatically (at-most-once delivery).
 *  - `idempotencyKey` is stable per notification; pass it to the provider if it
 *    supports deduplication.
 */
export const TELEGRAM_MAX_CHARS = 4096;

export interface OwnerMessage {
  notificationId: string;
  idempotencyKey: string;
  text: string;
  category: string;
  quietHours?: import('./quiet-hours.ts').QuietHoursConfig;
  expectedDestination?: {channel:string;target:string};
}

/** Known-unsent policy hold, not a failed delivery attempt. */
export class OwnerChannelDeferredError extends Error {
  readonly notBeforeMs:number;
  constructor(notBeforeMs: number) { super('Held until quiet hours end'); this.notBeforeMs=notBeforeMs; }
}

export interface OwnerChannel {
  readonly name: string;
  send(msg: OwnerMessage, signal: AbortSignal): Promise<{ providerMessageId: string | null }>;
}

export class OwnerChannelRejectedError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly permanent: boolean;
  constructor(message: string, opts: { retryAfterMs?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = 'OwnerChannelRejectedError';
    this.retryAfterMs = opts.retryAfterMs;
    this.permanent = opts.permanent === true;
  }
}

export type FakeChannelMode = 'ok' | 'reject' | 'reject_permanent' | 'throw_uncertain' | 'hang';

export interface FakeOwnerChannel extends OwnerChannel {
  sent: (OwnerMessage & { at: number })[];
  mode: FakeChannelMode;
  /** Applies to the next N sends, then reverts to 'ok'. */
  setMode(mode: FakeChannelMode, times?: number): void;
}

/** In-memory channel for tests and dry runs. Never contacts a network. */
export function createFakeOwnerChannel(now: () => number = () => 0): FakeOwnerChannel {
  let remaining = Number.POSITIVE_INFINITY;
  let seq = 0;
  const ch: FakeOwnerChannel = {
    name: 'fake',
    sent: [],
    mode: 'ok',
    setMode(mode, times) {
      ch.mode = mode;
      remaining = times ?? Number.POSITIVE_INFINITY;
    },
    async send(msg, signal) {
      const mode = ch.mode;
      if (mode !== 'ok') {
        remaining -= 1;
        if (remaining <= 0) {
          ch.mode = 'ok';
          remaining = Number.POSITIVE_INFINITY;
        }
      }
      if (msg.text.length > TELEGRAM_MAX_CHARS) throw new OwnerChannelRejectedError('message too long', { permanent: true });
      switch (mode) {
        case 'reject':
          throw new OwnerChannelRejectedError('fake rejection', { retryAfterMs: 1000 });
        case 'reject_permanent':
          throw new OwnerChannelRejectedError('fake permanent rejection', { permanent: true });
        case 'throw_uncertain':
          ch.sent.push({ ...msg, at: now() }); // provider accepted, then the connection dropped
          throw new Error('fake connection reset after write');
        case 'hang':
          return await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
        default:
          ch.sent.push({ ...msg, at: now() });
          return { providerMessageId: `fake-${++seq}` };
      }
    },
  };
  return ch;
}
