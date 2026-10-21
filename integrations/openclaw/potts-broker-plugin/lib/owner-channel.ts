/**
 * OwnerChannel server (plugin side): lets the Potts daemon send owner
 * notifications through the gateway's EXISTING Telegram bot, so Potts never
 * polls or calls the bot itself (single consumer of the bot's updates).
 *
 * Transport: a Unix socket ($POTTS_HOME/run/owner-channel.sock, 0600 in the
 * 0700 run dir) served by a plugin background service. On connect the server
 * sends {challenge}; the client answers `auth {mac}` with
 * HMAC(ingressKey, "potts-owner-channel:v1:" + challenge). Then:
 *   notify {text, silent?}           plain notification to the owner
 *   notify_approval {approvalId}     the plugin itself fetches the preview from
 *                                    the ingress socket and renders the exact
 *                                    content + bound Approve/Deny buttons
 * The recipient is ALWAYS the configured owner id; the caller cannot choose
 * it. Content never appears in process argv (unlike `openclaw message send`).
 *
 * Disabled by default (`ownerChannel: true` in plugin config enables it).
 */
import { createServer, type Server } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nativeDeliveryReceipt } from './delivery-receipt.ts';
import { hexEqual, hmacSha256Hex } from './crypto.ts';
import type { SecretsProvider } from './config.ts';
import type { OwnerReply } from './owner.ts';
import { isQuietAt, quietEndAfter, normalizeQuietHours, type QuietHoursConfig } from '../../../../src/notifications/quiet-hours.ts';

export class QuietHoursDeferred extends Error {
  readonly notBeforeMs:number;
  constructor(notBeforeMs:number) { super('Quiet hours: no provider call was made'); this.notBeforeMs=notBeforeMs; }
}
export class DestinationChanged extends Error {}

export function ownerChannelAuthResponse(key: string | Uint8Array, challenge: string): string {
  return hmacSha256Hex(key, `potts-owner-channel:v1:${challenge}`);
}

export interface OwnerDelivery {
  to: string;
  text: string;
  presentation?: OwnerReply['presentation'];
  silent?: boolean;
  quietHours?: QuietHoursConfig;
  expectedDestination?: {channel:string;target:string};
}
export type DeliverFn = (d: OwnerDelivery) => Promise<{ messageId: string | null; accepted?: true }>;

export interface OwnerChannelServerOptions {
  socketPath: string;
  secrets: SecretsProvider;
  deliver: DeliverFn;
  /** Builds the approval prompt (uses the ingress socket). */
  approvalPrompt: (approvalId: string) => Promise<{ ok: true; reply: OwnerReply } | { ok: false; error: string }>;
  maxPerMinute?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export const OWNER_TEXT_LIMIT = 3500;
const MAX_LINE = 64 * 1024;

export async function startOwnerChannelServer(o: OwnerChannelServerOptions): Promise<{ close(): Promise<void> }> {
  // The plugin is installed before the daemon on a fresh Mac. Do not depend on
  // daemon startup to create run/, and never bind inside a shared/symlink dir.
  const dir = dirname(o.socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`owner channel directory must be owner-only (0700): ${dir}`);
  }
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => {});
  const maxPerMinute = o.maxPerMinute ?? 30;
  const sent: number[] = [];
  try {
    if (!lstatSync(o.socketPath).isSocket()) throw new Error(`refusing to replace non-socket file at ${o.socketPath}`);
    unlinkSync(o.socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const server: Server = createServer((sock) => {
    const challenge = randomBytes(32).toString('hex');
    let authed = false;
    let buf = '';
    let chain = Promise.resolve();
    sock.setEncoding('utf8');
    sock.setTimeout(30_000, () => sock.destroy());
    const send = (obj: unknown): void => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n');
    };
    send({ challenge });
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) return sock.destroy();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        chain = chain.then(async () => {
          let req: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
          try {
            req = JSON.parse(line) as typeof req;
          } catch {
            return send({ id: null, ok: false, error: { code: 'invalid_input', message: 'invalid JSON' } });
          }
          const id = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
          const fail = (code: string, message: string) => send({ id, ok: false, error: { code, message } });
          const secrets = await o.secrets.get();
          if (!secrets) return fail('unavailable', 'owner channel not configured');
          const p = req.params && typeof req.params === 'object' ? req.params : {};
          if (req.method === 'auth') {
            if (typeof p.mac === 'string' && hexEqual(p.mac, ownerChannelAuthResponse(secrets.key, challenge))) {
              authed = true;
              return send({ id, ok: true, result: { authenticated: true } });
            }
            log('owner_channel_auth_failed', {});
            return fail('ingress_invalid', 'authentication failed');
          }
          if (!authed) return fail('ingress_invalid', 'not authenticated');
          const t = now();
          while (sent.length && t - sent[0]! > 60_000) sent.shift();
          if (sent.length >= maxPerMinute) return fail('rate_limited', 'too many owner notifications');
          let delivery: OwnerDelivery;
          if (req.method === 'notify') {
            if (typeof p.text !== 'string' || !p.text.trim()) return fail('invalid_input', 'text required');
            if (p.text.length > OWNER_TEXT_LIMIT) return fail('invalid_input', `text longer than ${OWNER_TEXT_LIMIT} characters`);
            let quietHours: QuietHoursConfig | undefined;
            if (p.quietHours !== undefined) {
              if (!p.quietHours || typeof p.quietHours !== 'object') return fail('invalid_input','Invalid quiet-hours policy');
              try {
                quietHours = normalizeQuietHours(p.quietHours as Partial<QuietHoursConfig>);
                isQuietAt(now(), quietHours);
              } catch { return fail('invalid_input','Invalid quiet-hours policy'); }
            }
            const expected=p.expectedDestination as {channel?:unknown;target?:unknown}|undefined;
            if(expected&&(typeof expected.channel!=='string'||typeof expected.target!=='string'))return fail('invalid_input','Invalid reminder destination');
            delivery = { to: secrets.ownerId, text: p.text, silent: p.silent === true, ...(quietHours?{quietHours}:{}),...(expected?{expectedDestination:{channel:expected.channel as string,target:expected.target as string}}:{}) };
          } else if (req.method === 'notify_approval') {
            if (typeof p.approvalId !== 'string') return fail('invalid_input', 'approvalId required');
            const pr = await o.approvalPrompt(p.approvalId);
            if (!pr.ok) return fail('unavailable', pr.error);
            delivery = { to: secrets.ownerId, text: pr.reply.text, ...(pr.reply.presentation ? { presentation: pr.reply.presentation } : {}) };
          } else {
            return fail('invalid_input', 'unknown method');
          }
          try {
            sent.push(t);
            const r = await o.deliver(delivery);
            return send({ id, ok: true, result: r });
          } catch (e) {
            if(e instanceof DestinationChanged)return fail('invalid_input','Reminder destination changed; nothing sent');
            if(e instanceof QuietHoursDeferred) return send({id,ok:false,error:{code:'quiet_deferred',message:'Held until morning',details:{notBeforeMs:e.notBeforeMs}}});
            log('owner_channel_delivery_failed', { error: (e as Error).message });
            return fail('delivery_failed', 'delivery to the owner chat failed');
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, () => {
      chmodSync(o.socketPath, 0o600);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((res) =>
        server.close(() => {
          try {
            unlinkSync(o.socketPath);
          } catch {
            /* gone */
          }
          res();
        }),
      ),
  };
}

/**
 * Real delivery through the gateway's Telegram outbound adapter
 * (api.runtime.channel.outbound.loadAdapter, OpenClaw 2026.9.8). Not
 * exercised in tests: the isolated test profile has no Telegram channel.
 */
export function createGatewayTelegramDeliver(runtime: unknown, currentConfig: () => unknown, accountId?: string, channel = 'telegram', target?: string, now:()=>number=Date.now): DeliverFn {
  return async (d) => {
    const rt = runtime as { channel?: { outbound?: { loadAdapter?: (id: string) => Promise<Record<string, unknown> | undefined> } } };
    const load = rt.channel?.outbound?.loadAdapter;
    if (typeof load !== 'function') throw new Error('outbound adapter API unavailable');
    const adapter = await load(channel);
    if (!adapter) throw new Error(`${channel} outbound adapter not loaded`);
    const cfg = currentConfig();
    const base = { cfg, to: target ?? d.to, text: d.text, accountId: accountId ?? null, silent: d.silent === true };
    const sendPayload = adapter.sendPayload as ((ctx: unknown) => Promise<{ messageId?: string }>) | undefined;
    const sendText = adapter.sendText as ((ctx: unknown) => Promise<{ messageId?: string }>) | undefined;
    // Last synchronous boundary after adapter/config loading, directly before
    // calling the provider. Delivery after provider acceptance is beyond our control.
    if(d.expectedDestination&&(d.expectedDestination.channel!==channel||d.expectedDestination.target!==(target??d.to)))throw new DestinationChanged('Reminder destination changed');
    if(d.quietHours && isQuietAt(now(),d.quietHours)) throw new QuietHoursDeferred(quietEndAfter(now(),d.quietHours));
    if (channel === 'telegram' && d.presentation && typeof sendPayload === 'function') {
      const r = await sendPayload({ ...base, payload: { text: d.text, presentation: d.presentation } });
      const receipt = nativeDeliveryReceipt(r);
      if (!receipt) throw new Error('Messaging service acceptance was not confirmed');
      return receipt;
    }
    if (typeof sendText !== 'function') throw new Error(`${channel} adapter has no sendText`);
    const r = await sendText(base);
    const receipt = nativeDeliveryReceipt(r);
      if (!receipt) throw new Error('Messaging service acceptance was not confirmed');
      return receipt;
  };
}
