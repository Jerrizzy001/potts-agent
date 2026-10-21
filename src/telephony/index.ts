/**
 * WP-7 telephony: owner alert calls (Twilio adapter), callback webhook,
 * third-party call proposals (executor intentionally absent).
 *
 * NOT AN EMERGENCY SERVICE. These calls depend on this Mac being on and
 * online, a working paid provider account and carrier delivery, and they are
 * suppressed during quiet hours. Never rely on them in place of 911/112.
 */
import type { TelephonyProvider } from './types.ts';
import type { TelephonyStore } from './store.ts';

export * from './types.ts';
export * from './script.ts';
export * from './twilio.ts';
export * from './store.ts';
export * from './owner-alert.ts';
export * from './webhook.ts';
export * from './third-party.ts';
export * from './config.ts';

/**
 * Fills provider-reported price/duration for placed calls that have no price
 * yet (Twilio prices a call some time after it ends). Usage is reported, never
 * capped. Returns the number of calls updated.
 */
export async function refreshCallUsage(store: TelephonyStore, provider: TelephonyProvider, sinceIso: string): Promise<number> {
  let n = 0;
  for (const c of store.unpricedCalls(sinceIso)) {
    const p = await provider.getCall(c.providerCallId!);
    if (p && p.price !== null && p.priceUnit) {
      store.updateCall(c.id, { price: p.price, priceUnit: p.priceUnit, status: p.status, ...(p.durationSeconds !== null ? { durationSeconds: p.durationSeconds } : {}) });
      n++;
    }
  }
  return n;
}
