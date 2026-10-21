import { isInLocalWindow, nextDailyOccurrence, OWNER_TIMEZONE, parseHhmm } from '../jobs/tz.ts';

/**
 * Quiet hours: no unsolicited owner messages or calls between start and end
 * (owner's local time). There is deliberately NO urgent override: the spec
 * sets overnightEmergencyOverride=false and this module ignores any attempt to
 * enable it (see `normalizeQuietHours`).
 */
export interface QuietHoursConfig {
  start: string; // "23:00"
  end: string; // "08:00"
  timezone: string; // "America/Toronto"
  /** Owner-initiated chat during quiet hours may get an immediate reply. Default false (strict). */
  ownerInitiatedReplyAllowed: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = Object.freeze({
  start: '23:00',
  end: '08:00',
  timezone: OWNER_TIMEZONE,
  ownerInitiatedReplyAllowed: false,
});

export function normalizeQuietHours(raw: Partial<QuietHoursConfig> | undefined): QuietHoursConfig {
  const q = { ...DEFAULT_QUIET_HOURS, ...(raw ?? {}) };
  parseHhmm(q.start);
  parseHhmm(q.end);
  return {
    start: q.start,
    end: q.end,
    timezone: q.timezone,
    ownerInitiatedReplyAllowed: q.ownerInitiatedReplyAllowed === true,
  };
}

/** Builds quiet-hours config from the WP-1 PottsConfig fields (quietHours, owner.timezone). */
export function quietHoursFromConfig(cfg: {
  owner: { timezone: string };
  quietHours: { start: string; end: string };
  notifications?: unknown;
}): QuietHoursConfig {
  const n = (cfg.notifications ?? {}) as { ownerInitiatedReplyDuringQuiet?: unknown };
  return normalizeQuietHours({
    start: cfg.quietHours.start,
    end: cfg.quietHours.end,
    timezone: cfg.owner.timezone,
    ownerInitiatedReplyAllowed: n.ownerInitiatedReplyDuringQuiet === true,
  });
}

export function isQuietAt(ms: number, q: QuietHoursConfig): boolean {
  return isInLocalWindow(ms, q.start, q.end, q.timezone);
}

/** The instant quiet hours end, if `ms` is inside quiet hours; otherwise `ms`. */
export function quietEndAfter(ms: number, q: QuietHoursConfig): number {
  if (!isQuietAt(ms, q)) return ms;
  return nextDailyOccurrence(ms, q.end, q.timezone);
}
