import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instantOn,
  isInLocalWindow,
  localParts,
  localToUtc,
  nextDailyOccurrence,
  previousDailyOccurrence,
  localDateKey,
} from '../../src/jobs/tz.ts';

const TZ = 'America/Toronto';
const iso = (ms: number) => new Date(ms).toISOString();

test('local parts and offsets around DST', () => {
  assert.deepEqual(localParts(Date.parse('2026-10-31T13:00:00Z'), TZ).hour, 9); // EDT
  assert.deepEqual(localParts(Date.parse('2026-11-01T14:00:00Z'), TZ).hour, 9); // EST
  assert.equal(localDateKey(Date.parse('2026-10-07T03:30:00Z'), TZ), '2026-10-06');
});

test('09:00 maps to the right UTC instant on both sides of fall-back and spring-forward', () => {
  assert.equal(iso(instantOn({ year: 2026, month: 10, day: 31 }, '09:00', TZ)), '2026-10-31T13:00:00.000Z');
  assert.equal(iso(instantOn({ year: 2026, month: 11, day: 1 }, '09:00', TZ)), '2026-11-01T14:00:00.000Z');
  assert.equal(iso(instantOn({ year: 2027, month: 3, day: 13 }, '09:00', TZ)), '2027-03-13T14:00:00.000Z');
  assert.equal(iso(instantOn({ year: 2027, month: 3, day: 14 }, '09:00', TZ)), '2027-03-14T13:00:00.000Z');
});

test('ambiguous fall-back time resolves to the earlier instant; gap time is pushed forward', () => {
  assert.equal(iso(localToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, TZ)), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(localToUtc({ year: 2027, month: 3, day: 14, hour: 2, minute: 30, second: 0 }, TZ)), '2027-03-14T07:30:00.000Z');
});

test('nextDailyOccurrence walks across DST without skipping or doubling', () => {
  let t = Date.parse('2026-10-30T20:00:00Z');
  const got: string[] = [];
  for (let i = 0; i < 4; i++) {
    t = nextDailyOccurrence(t, '09:00', TZ);
    got.push(iso(t));
  }
  assert.deepEqual(got, ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  // 01:30 on fall-back day occurs once (first occurrence)
  let u = Date.parse('2026-10-31T12:00:00Z');
  const am: string[] = [];
  for (let i = 0; i < 3; i++) {
    u = nextDailyOccurrence(u, '01:30', TZ);
    am.push(iso(u));
  }
  assert.deepEqual(am, ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
  assert.equal(iso(previousDailyOccurrence(Date.parse('2026-11-01T15:00:00Z'), '09:00', TZ)), '2026-11-01T14:00:00.000Z');
});

test('quiet window 23:00-08:00 crosses midnight', () => {
  const q = (s: string) => isInLocalWindow(Date.parse(s), '23:00', '08:00', TZ);
  assert.equal(q('2026-10-07T02:59:00Z'), false); // 22:59 EDT
  assert.equal(q('2026-10-07T03:01:00Z'), true); // 23:01 EDT
  assert.equal(q('2026-10-07T11:59:00Z'), true); // 07:59 EDT
  assert.equal(q('2026-10-07T12:00:00Z'), false); // 08:00 EDT
  assert.equal(q('2026-11-02T12:30:00Z'), true); // 07:30 EST
  assert.equal(q('2026-11-02T13:00:00Z'), false); // 08:00 EST
});
