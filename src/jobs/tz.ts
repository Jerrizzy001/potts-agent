/**
 * Wall-clock <-> UTC conversion for an IANA timezone using only Intl APIs.
 *
 * Rules (same as Temporal's "compatible" disambiguation):
 *  - A wall time inside a spring-forward gap (e.g. 02:30 on 2027-03-14 in
 *    America/Toronto) resolves to the instant that wall time would have had
 *    with the pre-transition offset, i.e. it is pushed forward (03:30 EDT).
 *  - An ambiguous wall time in a fall-back overlap (e.g. 01:30 on 2026-11-01)
 *    resolves to the EARLIER instant, so a daily job fires once.
 */

export const OWNER_TIMEZONE = 'America/Toronto';

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function assertTimezone(tz: string): void {
  formatter(tz); // throws RangeError for unknown zones
}

/** Local wall-clock fields of a UTC instant in `tz`. */
export function localParts(ms: number, tz: string): LocalDateTime {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour === 24 ? 0 : out.hour!,
    minute: out.minute!,
    second: out.second!,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (EDT = -4h). */
export function offsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(ms / 1000) * 1000;
  return asUtc - truncated;
}

function sameWall(ms: number, tz: string, w: LocalDateTime): boolean {
  const p = localParts(ms, tz);
  return p.year === w.year && p.month === w.month && p.day === w.day && p.hour === w.hour && p.minute === w.minute;
}

/** UTC instant for a local wall time (see module doc for gap/overlap rules). */
export function localToUtc(w: LocalDateTime | (LocalDate & { hour: number; minute: number; second?: number }), tz: string): number {
  const wall: LocalDateTime = { second: 0, ...w } as LocalDateTime;
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Offsets either side of the wall time; DST transitions are months apart, so
  // at most one transition lies inside this +-12h window.
  const before = offsetMs(guess - 12 * 3600_000, tz);
  const after = offsetMs(guess + 12 * 3600_000, tz);
  const candidates = [...new Set([guess - before, guess - after])].sort((a, b) => a - b);
  const valid = candidates.filter((c) => sameWall(c, tz, wall));
  if (valid.length > 0) return valid[0]!; // earliest for an ambiguous (fall-back) time
  // Gap (spring-forward): use the pre-transition offset, which moves the time forward.
  return guess - before;
}

export function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`invalid HH:MM time "${hhmm}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function localDateOf(ms: number, tz: string): LocalDate {
  const p = localParts(ms, tz);
  return { year: p.year, month: p.month, day: p.day };
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function dateKey(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function localDateKey(ms: number, tz: string): string {
  return dateKey(localDateOf(ms, tz));
}

/** Instant of `hhmm` on local date `d`. */
export function instantOn(d: LocalDate, hhmm: string, tz: string): number {
  const { hour, minute } = parseHhmm(hhmm);
  return localToUtc({ ...d, hour, minute, second: 0 }, tz);
}

/** First instant strictly after `afterMs` at which the local clock reads `hhmm` (one per local date). */
export function nextDailyOccurrence(afterMs: number, hhmm: string, tz: string): number {
  let d = addDays(localDateOf(afterMs, tz), -1);
  for (let i = 0; i < 4; i++) {
    const t = instantOn(d, hhmm, tz);
    if (t > afterMs) return t;
    d = addDays(d, 1);
  }
  throw new Error('nextDailyOccurrence: no occurrence found');
}

/** Latest occurrence of `hhmm` at or before `atMs`. */
export function previousDailyOccurrence(atMs: number, hhmm: string, tz: string): number {
  let d = addDays(localDateOf(atMs, tz), 1);
  for (let i = 0; i < 4; i++) {
    const t = instantOn(d, hhmm, tz);
    if (t <= atMs) return t;
    d = addDays(d, -1);
  }
  throw new Error('previousDailyOccurrence: no occurrence found');
}

/** Local date key of the occurrence (slot identity for a daily job). */
export function dailySlotKey(occurrenceMs: number, tz: string): string {
  return localDateKey(occurrenceMs, tz);
}

function minutesOfDay(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return p.hour * 60 + p.minute;
}

/** True if the local wall time at `ms` is in [start, end), handling windows that cross midnight. */
export function isInLocalWindow(ms: number, start: string, end: string, tz: string): boolean {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  const sm = s.hour * 60 + s.minute;
  const em = e.hour * 60 + e.minute;
  const x = minutesOfDay(ms, tz);
  if (sm === em) return false;
  return sm < em ? x >= sm && x < em : x >= sm || x < em;
}

/** Wall-clock label for messages, e.g. "09:00". */
export function localHhmm(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Owner-facing local timestamp, e.g. "2026-10-07 01:35". */
export function formatLocal(ms: number, tz: string): string {
  return `${localDateKey(ms, tz)} ${localHhmm(ms, tz)}`;
}
