/**
 * Clock abstraction. All logic that depends on time takes a Clock so tests can
 * simulate DST transitions, quiet hours, expiry and sleep/wake. Never call
 * Date.now() directly in logic.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch (UTC). */
  nowMs(): number;
  /** Current instant as a Date. */
  now(): Date;
  /** Current instant as a UTC ISO-8601 string (e.g. 2026-10-06T13:00:00.000Z). */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/** Deterministic, manually advanced clock for tests. */
export interface FakeClock extends Clock {
  set(instant: Date | string | number): void;
  advanceMs(ms: number): void;
  advanceSeconds(s: number): void;
}

export function createFakeClock(start: Date | string | number = '2026-10-06T13:00:00.000Z'): FakeClock {
  let current = new Date(start).getTime();
  if (Number.isNaN(current)) throw new Error('createFakeClock: invalid start instant');
  return {
    nowMs: () => current,
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    set(instant) {
      const t = new Date(instant).getTime();
      if (Number.isNaN(t)) throw new Error('FakeClock.set: invalid instant');
      current = t;
    },
    advanceMs(ms) {
      current += ms;
    },
    advanceSeconds(s) {
      current += s * 1000;
    },
  };
}
