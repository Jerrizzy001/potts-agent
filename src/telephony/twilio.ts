/**
 * Twilio adapter (REST Calls API via global fetch; no SDK) and Twilio webhook
 * signature validation.
 *
 * Credentials (Account SID + Auth Token, or an API Key SID + secret) are
 * resolved by broker-side wiring from secret references and handed in as a
 * function; they are never logged or stored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ExecutorRejectedError } from '../broker/executor.ts';
import type { PlaceCallRequest, ProviderCall, TelephonyProvider } from './types.ts';
import { alertTwiml } from './script.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TwilioOptions {
  accountSid: string;
  /** Basic-auth credentials: {username: AccountSid or API Key SID, password: Auth Token or API Key secret}. */
  credentials: () => Promise<{ username: string; password: string }>;
  fetch?: FetchLike;
  apiBase?: string;
  voice?: string;
}

const API = 'https://api.twilio.com';

type TwilioCall = {
  sid: string; to: string; from: string; status: string; date_created: string | null; duration: string | null;
  price: string | null; price_unit: string | null; answered_by: string | null;
};
const toCall = (c: TwilioCall): ProviderCall => ({
  providerCallId: c.sid, to: c.to, from: c.from, status: c.status, createdAt: c.date_created ? new Date(c.date_created).toISOString() : '',
  durationSeconds: c.duration === null || c.duration === undefined ? null : Number(c.duration), price: c.price ?? null, priceUnit: c.price_unit ?? null,
  answeredBy: c.answered_by ?? null,
});

export function createTwilioProvider(o: TwilioOptions): TelephonyProvider {
  if (!/^AC[0-9a-f]{32}$/.test(o.accountSid)) throw new Error('Twilio account SID must look like AC + 32 hex characters');
  const fetchFn = o.fetch ?? (globalThis.fetch as FetchLike);
  const base = `${o.apiBase ?? API}/2010-04-01/Accounts/${o.accountSid}`;
  const auth = async () => {
    const c = await o.credentials();
    return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
  };
  return {
    name: 'twilio',
    async placeCall(req: PlaceCallRequest, signal: AbortSignal) {
      let authorization: string;
      try {
        authorization = await auth();
      } catch (e) {
        throw new ExecutorRejectedError(`twilio credentials unavailable: ${(e as Error).message}`);
      }
      const form = new URLSearchParams();
      form.set('To', req.to);
      form.set('From', req.from);
      form.set('Twiml', alertTwiml(req.script.say, req.script.gatherUrl, o.voice));
      form.set('StatusCallback', req.script.statusUrl);
      form.set('StatusCallbackMethod', 'POST');
      for (const ev of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', ev);
      form.set('Timeout', String(req.ringTimeoutSeconds));
      if (req.machineDetection) form.set('MachineDetection', 'Enable');
      let res: Response;
      try {
        res = await fetchFn(`${base}/Calls.json`, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal });
      } catch (e) {
        throw new Error(`twilio create call: ${(e as Error).message}; outcome unknown`);
      }
      if (res.status >= 400 && res.status < 500) {
        let detail = '';
        try {
          const j = (await res.json()) as { code?: number; message?: string };
          detail = `${j.code ?? ''} ${j.message ?? ''}`.trim().slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new ExecutorRejectedError(`twilio refused the call (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
      }
      if (!res.ok) throw new Error(`twilio create call HTTP ${res.status}; outcome unknown`);
      const j = (await res.json()) as { sid?: string; status?: string };
      if (!j.sid) throw new Error('twilio returned no call sid; outcome unknown');
      return { providerCallId: j.sid, status: j.status ?? 'queued' };
    },
    async findCalls(q) {
      try {
        const p = new URLSearchParams();
        p.set('To', q.to);
        p.set('From', q.from);
        // Date-granular filter (key "StartTime>"), widened by a day; exact filtering below.
        p.set('StartTime>', new Date(Date.parse(q.since) - 86400_000).toISOString().slice(0, 10));
        p.set('PageSize', '50');
        const r = await fetchFn(`${base}/Calls.json?${p.toString()}`, { headers: { authorization: await auth() } });
        if (!r.ok) return { ok: false, reason: `twilio list calls HTTP ${r.status}` };
        const j = (await r.json()) as { calls?: TwilioCall[]; next_page_uri?: string | null };
        const since = Date.parse(q.since);
        const calls = (j.calls ?? []).map(toCall).filter((c) => c.createdAt && Date.parse(c.createdAt) >= since);
        return { ok: true, calls, complete: !j.next_page_uri };
      } catch (e) {
        return { ok: false, reason: `twilio list calls failed: ${(e as Error).message}` };
      }
    },
    async getCall(sid) {
      if (!/^CA[0-9a-f]{32}$/.test(sid)) return undefined;
      const r = await fetchFn(`${base}/Calls/${sid}.json`, { headers: { authorization: await auth() } });
      if (!r.ok) return undefined;
      return toCall((await r.json()) as TwilioCall);
    },
  };
}

/**
 * Twilio request signature (X-Twilio-Signature): base64(HMAC-SHA1(authToken,
 * fullUrl + concat(sorted(param name + value)))) for form-encoded POSTs.
 * `fullUrl` must be the exact public URL Twilio requested, including query.
 */
export function twilioSignature(authToken: string, fullUrl: string, params: URLSearchParams): string {
  const keys = [...new Set([...params.keys()])].sort();
  let data = fullUrl;
  for (const k of keys) for (const v of params.getAll(k).sort()) data += k + v;
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function validTwilioSignature(authToken: string, fullUrl: string, params: URLSearchParams, header: string | undefined): boolean {
  if (!header || header.length > 256) return false;
  const expected = Buffer.from(twilioSignature(authToken, fullUrl, params));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
