/**
 * Test fakes for telephony. Production wiring (WP-8) uses WP-5's real
 * OwnerAlertDecider / IncidentValidator and the Twilio provider.
 */
import type { Clock } from '../core/clock.ts';
import { ExecutorRejectedError } from '../broker/executor.ts';
import type { IncidentValidator, OwnerAlertDecider, PlaceCallRequest, ProviderCall, TelephonyProvider } from './types.ts';

const localHm = (d: Date, tz: string): number => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h * 60 + m;
};

/** Quiet-hours fake: blocks calls between start and end local time (wrapping midnight). */
export function createFakeQuietHoursDecider(o: { start?: string; end?: string; timeZone?: string } = {}): OwnerAlertDecider & { calls: Date[] } {
  const tz = o.timeZone ?? 'America/Toronto';
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const start = toMin(o.start ?? '23:00');
  const end = toMin(o.end ?? '08:00');
  const quiet = (d: Date) => {
    const t = localHm(d, tz);
    return start > end ? t >= start || t < end : t >= start && t < end;
  };
  const calls: Date[] = [];
  return {
    calls,
    evaluateCall(at) {
      calls.push(at);
      if (!quiet(at)) return { allowed: true, reason: 'outside quiet hours' };
      let t = at.getTime() - (at.getTime() % 60_000);
      for (let i = 0; i < 24 * 60 && quiet(new Date(t)); i++) t += 60_000;
      return { allowed: false, reason: 'quiet hours (23:00-08:00 America/Toronto)', nextAllowedAt: new Date(t).toISOString() };
    },
  };
}

export function createFakeIncidentValidator(): IncidentValidator & { inactive: Map<string, string> } {
  const inactive = new Map<string, string>();
  return { inactive, revalidate: (id) => (inactive.has(id) ? { active: false, reason: inactive.get(id)! } : { active: true, reason: 'still open' }) };
}

export type FakeCallMode = 'ok' | 'reject' | 'accept_then_throw' | 'throw_before_accept';

/** Fake telephony provider: records placed calls; never dials anything. */
export function createFakeTelephonyProvider(clock: Clock): TelephonyProvider & { placed: (PlaceCallRequest & { sid: string; at: string })[]; mode: FakeCallMode; listUnavailable: boolean; prices: Map<string, { price: string; unit: string; duration: number }> } {
  let n = 0;
  const placed: (PlaceCallRequest & { sid: string; at: string })[] = [];
  const prices = new Map<string, { price: string; unit: string; duration: number }>();
  const asCall = (p: (typeof placed)[number]): ProviderCall => ({
    providerCallId: p.sid, to: p.to, from: p.from, status: prices.has(p.sid) ? 'completed' : 'queued', createdAt: p.at,
    durationSeconds: prices.get(p.sid)?.duration ?? null, price: prices.get(p.sid)?.price ?? null, priceUnit: prices.get(p.sid)?.unit ?? null, answeredBy: null,
  });
  const fake = {
    name: 'twilio',
    placed,
    prices,
    mode: 'ok' as FakeCallMode,
    listUnavailable: false,
    async placeCall(req: PlaceCallRequest) {
      if (fake.mode === 'reject') throw new ExecutorRejectedError('fake provider: 21211 invalid To number');
      if (fake.mode === 'throw_before_accept') throw new Error('fake provider: network error before accept');
      const sid = `CA${(++n).toString(16).padStart(32, '0')}`;
      placed.push({ ...structuredClone(req), sid, at: clock.nowIso() });
      if (fake.mode === 'accept_then_throw') throw new Error('fake provider: response lost after accept');
      return { providerCallId: sid, status: 'queued' };
    },
    async findCalls(q: { to: string; from: string; since: string }) {
      if (fake.listUnavailable) return { ok: false as const, reason: 'fake list unavailable' };
      return { ok: true as const, complete: true, calls: placed.filter((p) => p.to === q.to && p.from === q.from && Date.parse(p.at) >= Date.parse(q.since)).map(asCall) };
    },
    async getCall(sid: string) {
      const p = placed.find((x) => x.sid === sid);
      return p ? asCall(p) : undefined;
    },
  };
  return fake;
}
