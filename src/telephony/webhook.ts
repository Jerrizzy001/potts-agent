/**
 * Twilio callback handling and the minimal callback HTTP server.
 *
 * The server exposes ONLY:
 *   POST /telephony/twilio/status   call progress (never acknowledgement)
 *   POST /telephony/twilio/gather   DTMF result; Digits=1 acknowledges
 * on its own port (default 127.0.0.1:8790), separate from the gateway and
 * the broker sockets. Everything else is 404. Publish it through a tunnel
 * restricted to the /telephony/twilio/ prefix.
 *
 * Each request must carry a valid X-Twilio-Signature computed over the PUBLIC
 * URL (publicBaseUrl + path + query) and the form parameters, and the
 * AccountSid must match. Callbacks are de-duplicated (CallSid + status +
 * sequence/timestamp for status, CallSid + Digits for gather) and stale ones
 * (Timestamp older than maxSkewSeconds) are ignored, so replays change nothing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Clock } from '../core/clock.ts';
import { sha256Hex } from '../core/hash.ts';
import type { TelephonyStore } from './store.ts';
import { validTwilioSignature } from './twilio.ts';
import { ACK_TWIML, EMPTY_TWIML, NOT_ACK_TWIML } from './script.ts';
import { GATHER_PATH, STATUS_PATH } from './owner-alert.ts';

export interface WebhookRequest {
  method: string;
  /** Path including query string, exactly as received (e.g. /telephony/twilio/status?c=call_...). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface WebhookResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface TwilioWebhookOptions {
  store: TelephonyStore;
  clock: Clock;
  accountSid: string;
  authToken: () => Promise<string>;
  /** Public HTTPS origin Twilio calls (the URL signed by Twilio), without trailing slash. */
  publicBaseUrl: string;
  maxSkewSeconds?: number;
  /** Called after an acknowledgement is recorded (e.g. WP-5 posts "acknowledged" to Telegram). */
  onAcknowledged?: (incidentId: string) => void;
}

const xml = (status: number, body: string): WebhookResponse => ({ status, contentType: 'text/xml; charset=utf-8', body });
const text = (status: number, body: string): WebhookResponse => ({ status, contentType: 'text/plain; charset=utf-8', body });
const header = (h: WebhookRequest['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const STATUS_FIELDS = ['CallSid', 'CallStatus', 'AnsweredBy', 'CallDuration', 'SequenceNumber', 'Timestamp', 'ErrorCode'] as const;

export function createTwilioWebhookHandler(o: TwilioWebhookOptions): (req: WebhookRequest) => Promise<WebhookResponse> {
  const base = o.publicBaseUrl.replace(/\/+$/, '');
  const maxSkewMs = (o.maxSkewSeconds ?? 900) * 1000;
  return async (req) => {
    const u = new URL(req.url, 'http://local');
    const path = u.pathname;
    if (path !== STATUS_PATH && path !== GATHER_PATH) return text(404, 'not found');
    if (req.method !== 'POST') return text(405, 'method not allowed');
    if (!(header(req.headers, 'content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return text(415, 'unsupported media type');
    const params = new URLSearchParams(req.body);
    let token: string;
    try {
      token = await o.authToken();
    } catch {
      return text(503, 'unavailable');
    }
    if (!validTwilioSignature(token, `${base}${req.url}`, params, header(req.headers, 'x-twilio-signature'))) {
      o.store.logEvent({ callId: null, callSid: null, path, outcome: 'bad_signature', fields: {} });
      return text(403, 'forbidden');
    }
    if (params.get('AccountSid') !== o.accountSid) return text(403, 'forbidden');

    const callSid = params.get('CallSid') ?? '';
    const callId = u.searchParams.get('c') ?? '';
    const fields: Record<string, string> = {};
    for (const f of [...STATUS_FIELDS, 'Digits']) {
      const v = params.get(f);
      if (v !== null) fields[f] = v.slice(0, 64);
    }
    const row = o.store.call(callId);
    const isGather = path === GATHER_PATH;
    const done = (outcome: string, res: WebhookResponse) => {
      o.store.logEvent({ callId: row?.id ?? null, callSid: callSid || null, path, outcome, fields });
      return res;
    };
    if (!row || !/^CA[0-9a-f]{32}$/.test(callSid)) return done('unknown_call', xml(200, isGather ? NOT_ACK_TWIML : EMPTY_TWIML));
    if (row.providerCallId && row.providerCallId !== callSid) return done('sid_mismatch', xml(200, isGather ? NOT_ACK_TWIML : EMPTY_TWIML));

    const ts = params.get('Timestamp');
    if (ts && Number.isFinite(Date.parse(ts)) && o.clock.nowMs() - Date.parse(ts) > maxSkewMs) return done('stale', xml(200, isGather ? NOT_ACK_TWIML : EMPTY_TWIML));

    const key = sha256Hex(isGather ? `${path}|${callSid}|${params.get('Digits') ?? ''}` : `${path}|${callSid}|${params.get('CallStatus') ?? ''}|${params.get('SequenceNumber') ?? ''}|${ts ?? ''}|${params.get('AnsweredBy') ?? ''}`);
    if (!o.store.firstSeen(key, path, callSid)) {
      // Replay: same response, no state change.
      const acked = isGather && params.get('Digits') === '1' && row.acknowledged;
      return done('duplicate', xml(200, isGather ? (acked ? ACK_TWIML : NOT_ACK_TWIML) : EMPTY_TWIML));
    }
    if (!row.providerCallId) o.store.updateCall(row.id, { providerCallId: callSid });

    if (!isGather) {
      const dur = params.get('CallDuration');
      o.store.updateCall(row.id, {
        ...(params.get('CallStatus') ? { status: params.get('CallStatus')!.slice(0, 32) } : {}),
        ...(params.get('AnsweredBy') ? { answeredBy: params.get('AnsweredBy')!.slice(0, 32) } : {}),
        ...(dur && /^\d+$/.test(dur) ? { durationSeconds: Number(dur) } : {}),
      });
      // Status callbacks (answered, completed, voicemail) NEVER acknowledge.
      return done('applied', xml(200, EMPTY_TWIML));
    }
    if (params.get('Digits') === '1') {
      const changed = o.store.acknowledge(row.incidentId, row.id);
      if (changed) o.onAcknowledged?.(row.incidentId);
      return done('applied', xml(200, ACK_TWIML));
    }
    return done('applied', xml(200, NOT_ACK_TWIML));
  };
}

export const WEBHOOK_LIMITS = { maxBodyBytes: 16 * 1024, headersTimeoutMs: 10_000, requestTimeoutMs: 15_000, maxConnections: 32 } as const;

export interface TelephonyWebhookServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Starts the callback server. Binds 127.0.0.1 by default; expose it only via an HTTPS tunnel limited to /telephony/twilio/. */
export async function startTelephonyWebhookServer(o: { handler: (r: WebhookRequest) => Promise<WebhookResponse>; host?: string; port: number; extraPaths?: readonly string[] }): Promise<TelephonyWebhookServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (r: WebhookResponse) => {
      res.writeHead(r.status, { 'content-type': r.contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(r.body);
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== STATUS_PATH && path !== GATHER_PATH && !o.extraPaths?.includes(path ?? '')) {
      req.resume();
      return send(text(404, 'not found'));
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(text(405, 'method not allowed'));
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > WEBHOOK_LIMITS.maxBodyBytes) {
      req.resume();
      return send(text(413, 'too large'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > WEBHOOK_LIMITS.maxBodyBytes && !aborted) {
        aborted = true;
        send(text(413, 'too large'));
        req.destroy();
      } else if (!aborted) chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      o.handler({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }).then(send, () => send(text(500, 'error')));
    });
  });
  server.headersTimeout = WEBHOOK_LIMITS.headersTimeoutMs;
  server.requestTimeout = WEBHOOK_LIMITS.requestTimeoutMs;
  server.maxConnections = WEBHOOK_LIMITS.maxConnections;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  return { server, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
