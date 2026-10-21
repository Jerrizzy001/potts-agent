/**
 * End-to-end harness: the fully wired daemon (createDaemon) in-process against
 * a temp POTTS_HOME, a fake clock, a fake Keychain, an in-memory OAuth token
 * store and a fake "internet" (fetch router). Nothing here touches the real
 * Keychain, network, Telegram, LM Studio or telephony.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../../src/core/clock.ts';
import { nullLogger } from '../../src/core/log.ts';
import { signOwnerIngress, type OwnerIntent } from '../../src/approvals/ingress.ts';
import { createFakeOwnerChannel, type FakeOwnerChannel } from '../../src/owner/owner-channel.ts';
import { createMemoryTokenStore } from '../../src/connectors/oauth/token-store.ts';
import type { OAuthTokenSet } from '../../src/connectors/oauth/types.ts';
import { createDaemon, type Daemon, type DaemonOptions } from '../../src/daemon/index.ts';
import { siteFetch, healthyState, type SiteState } from '../monitoring/_site.ts';

export const OWNER_ID = '424242';
export const INGRESS_KEY = randomBytes(32).toString('hex');
export const OWNER_EMAIL = 'owner@example.com';

const repo = join(import.meta.dirname, '../..');
export const example = (name: string) => JSON.parse(readFileSync(join(repo, 'config', `${name}.example.json`), 'utf8')) as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Fake internet

export type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
export interface FakeNet {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  log: { method: string; url: string; body: string }[];
  route(prefix: string, h: Handler): void;
}

export function createFakeNet(): FakeNet {
  const routes: { prefix: string; h: Handler }[] = [];
  const log: FakeNet['log'] = [];
  return {
    log,
    route(prefix, h) {
      routes.unshift({ prefix, h });
    },
    async fetch(input, init) {
      const url = String(input);
      log.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : '' });
      const r = routes.find((x) => url.startsWith(x.prefix));
      if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: `no fake route for ${url}` } });
      return r.h(new URL(url), init);
    },
  };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Example App + connectivity probes (WP-5 site fake). */
export function routeSite(net: FakeNet, st: SiteState = healthyState()): SiteState {
  const f = siteFetch(st);
  for (const p of ['https://example.com', 'https://1.1.1.1/', 'https://www.apple.com/']) net.route(p, (u, i) => f(u.toString(), i));
  return st;
}

// --- Gmail ------------------------------------------------------------------------------------------------------
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export interface FakeGmail {
  inbox: Map<string, unknown>;
  sent: { id: string; messageId: string; pottsAction: string; to: string; raw: string }[];
  token: { failRefresh: boolean; refreshes: number };
  addInbox(id: string, m: { from: string; subject: string; text: string; html?: string }): void;
}

export function routeGmail(net: FakeNet, opts: { address?: string } = {}): FakeGmail {
  const address = opts.address ?? OWNER_EMAIL;
  const g: FakeGmail = {
    inbox: new Map(),
    sent: [],
    token: { failRefresh: false, refreshes: 0 },
    addInbox(id, m) {
      const parts = [{ partId: '0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64u(m.text), size: m.text.length } }];
      if (m.html) parts.push({ partId: '1', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64u(m.html), size: m.html.length } });
      g.inbox.set(id, {
        id, threadId: `t-${id}`, labelIds: ['INBOX', 'UNREAD'], snippet: m.text.slice(0, 50), internalDate: String(Date.parse('2026-10-07T13:00:00Z')),
        payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'To', value: address }, { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }], parts },
      });
    },
  };
  const api = 'https://gmail.googleapis.com/gmail/v1/users/me';
  net.route('https://openidconnect.googleapis.com/v1/userinfo', (_u, init) =>
    String(new Headers(init?.headers).get('authorization') ?? '').startsWith('Bearer ') ? json({ sub: '1', email: address, email_verified: true }) : json({ error: 'invalid_token' }, 401));
  net.route('https://oauth2.googleapis.com/token', () => {
    g.token.refreshes++;
    if (g.token.failRefresh) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    return json({ access_token: `at-${g.token.refreshes}`, expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.readonly' });
  });
  net.route(api, (u, init) => {
    const path = u.pathname.replace('/gmail/v1/users/me', '');
    if (!String(new Headers(init?.headers).get('authorization') ?? '').startsWith('Bearer ')) return json({ error: { code: 401 } }, 401);
    if (path === '/profile') return json({ emailAddress: address, historyId: '1000' });
    if (path === '/history') return json({ historyId: '1000', history: [] });
    if (path === '/messages/send' && init?.method === 'POST') {
      const raw = Buffer.from((JSON.parse(String(init.body)) as { raw: string }).raw, 'base64url').toString('utf8');
      const hdr = (n: string) => new RegExp(`^${n}: (.*)$`, 'mi').exec(raw)?.[1]?.trim() ?? '';
      const id = `sent-${g.sent.length + 1}`;
      g.sent.push({ id, messageId: hdr('Message-ID'), pottsAction: hdr('X-Potts-Action'), to: hdr('To'), raw });
      return json({ id, threadId: `t-${id}` });
    }
    if (path === '/messages') {
      const q = u.searchParams.get('q') ?? '';
      if (q.startsWith('rfc822msgid:')) return json({ messages: g.sent.filter((s) => s.messageId === q.slice(12)).map((s) => ({ id: s.id })) });
      if (q.startsWith('in:sent')) return json({ messages: g.sent.map((s) => ({ id: s.id })) });
      return json({ messages: [...g.inbox.keys()].map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: g.inbox.size });
    }
    const m = /^\/messages\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const s = g.sent.find((x) => x.id === id);
      if (s) return json({ id, labelIds: ['SENT'], payload: { headers: [{ name: 'X-Potts-Action', value: s.pottsAction }] } });
      const msg = g.inbox.get(id);
      return msg ? json(msg) : json({ error: { code: 404 } }, 404);
    }
    return json({ error: { code: 404 } }, 404);
  });
  return g;
}

/** LM Studio fake with idle unload (600 s TTL), one loaded model at a time, 32K context. */
export interface FakeLmStudio {
  requests: { model: string; at: number; body: Record<string, unknown> }[];
  loads: { model: string; at: number; contextLength: number; parallel: number; ttlSeconds: number }[];
  loaded: string | null;
}
export function routeLmStudio(net: FakeNet, clock: FakeClock): FakeLmStudio {
  const lm: FakeLmStudio = { requests: [], loads: [], loaded: null };
  let lastUse = 0;
  net.route('http://127.0.0.1:1234', (u, init) => {
    if (lm.loaded && clock.nowMs() - lastUse > 600_000) lm.loaded = null; // idle TTL unload
    if (u.pathname === '/v1/models') return json({ data: [{ id: 'qwen/qwen3.5-9b' }] });
    if (u.pathname !== '/v1/chat/completions') return json({ error: 'not found' }, 404);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const model = String(body.model);
    lm.requests.push({ model, at: clock.nowMs(), body });
    if (lm.loaded !== model) {
      lm.loaded = model; // JIT load with the persisted defaults
      lm.loads.push({ model, at: clock.nowMs(), contextLength: 32768, parallel: 1, ttlSeconds: 600 });
    }
    lastUse = clock.nowMs();
    return json({ choices: [{ message: { role: 'assistant', content: 'All quiet. Nothing needs your attention right now.' } }] });
  });
  return lm;
}

// ---------------------------------------------------------------------------------------------------------------
// Potts home + daemon

export interface HomeOptions {
  potts?: (c: Record<string, unknown>) => void;
  accounts?: Record<string, unknown>[];
  projects?: Record<string, unknown> | null;
  policy?: Record<string, unknown>;
}

export function makeHome(o: HomeOptions = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'pe2e-'));
  chmodSync(home, 0o700);
  const potts = example('potts');
  // Defaults for e2e: no LM Studio unless a test turns it on; monitoring on (fake site).
  (potts.owner as Record<string, unknown>).timezone = 'America/Toronto';
  potts.monitoring = { enabled: true, sites: [{ id: 'exampleapp', name: 'Example App', baseUrl: 'https://example.com', enabled: true, homepagePath: '/', healthPath: '/api/health', journeys: [], intervalSeconds: 60, timeoutMs: 10000, outageConfirmSeconds: 600, minConsecutiveFailures: 3, recoveryConsecutiveSuccesses: 2, maintenanceWindows: [] }] };
  (potts.notifications as Record<string, unknown>).summarizer = { enabled: false };
  potts.daemon = { tickMs: 1000 };
  o.potts?.(potts);
  const accounts = { schemaVersion: 1, accounts: o.accounts ?? [] };
  const w = (n: string, v: unknown) => writeFileSync(join(home, n), JSON.stringify(v, null, 2), { mode: 0o600 });
  w('potts.json', potts);
  w('accounts.json', accounts);
  w('policy.json', { ...example('policy'), ...(o.policy ?? {}) });
  if (o.projects !== null) w('projects.json', o.projects ?? example('projects'));
  return home;
}

export interface World {
  home: string;
  clock: FakeClock;
  net: FakeNet;
  keychain: Map<string, string>;
  keychainReads: string[];
  channel: FakeOwnerChannel;
  tokens: ReturnType<typeof createMemoryTokenStore>;
  d: Daemon;
  sign(intent: OwnerIntent): ReturnType<typeof signOwnerIngress>;
  /** Owner approves the live approval of an action exactly as previewed (trusted ingress path). */
  approve(actionId: string): ReturnType<NonNullable<Daemon['owner']>['handle']>;
  owner(intent: OwnerIntent): ReturnType<NonNullable<Daemon['owner']>['handle']>;
  /** Advances the fake clock in steps, running one scheduler pass per step. */
  advance(ms: number, stepMs?: number): Promise<void>;
  until(iso: string, stepMs?: number): Promise<void>;
  restart(extra?: Partial<DaemonOptions>): Promise<void>;
  close(): Promise<void>;
}

let updateSeq = 5000;

export async function startWorld(o: { home: string; start: string; clock?: FakeClock; keychain?: Record<string, string>; env?: Record<string, string>; net?: FakeNet; daemon?: Partial<DaemonOptions>; tokens?: Record<string, OAuthTokenSet> }): Promise<World> {
  const clock = o.clock ?? createFakeClock(o.start);
  const net = o.net ?? createFakeNet();
  const keychain = new Map<string, string>(Object.entries({ 'potts/ingress-hmac-key': INGRESS_KEY, 'potts/telegram-owner-id': OWNER_ID, ...(o.keychain ?? {}) }));
  const keychainReads: string[] = [];
  const channel = createFakeOwnerChannel();
  const tokens = createMemoryTokenStore();
  for (const [k, v] of Object.entries(o.tokens ?? {})) await tokens.set(k, v);
  const opts = (extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
    home: o.home, clock, fetch: net.fetch, env: { ...(o.env ?? {}) }, tokenStore: tokens, pluginOwnerChannel: channel, instanceId: 'e2e',
    keychainLookup: async (service, account) => {
      keychainReads.push(`${service}/${account}`);
      const v = keychain.get(`${service}/${account}`);
      if (v === undefined) throw new Error('not found');
      return v;
    },
    logger: nullLogger,
    ...o.daemon,
    ...extra,
  });
  const r = await createDaemon(opts());
  if (!r.ok) throw new Error(`daemon failed to start: ${r.error.message}`);
  const w: World = {
    home: o.home, clock, net, keychain, keychainReads, channel, tokens, d: r.value,
    sign: (intent) => signOwnerIngress(INGRESS_KEY, { source: 'telegram', senderId: OWNER_ID, chatId: OWNER_ID, chatType: 'private', updateId: String(++updateSeq), receivedAt: clock.nowIso(), intent }),
    owner: (intent) => w.d.owner!.handle(w.sign(intent)),
    approve(actionId) {
      const live = w.d.broker.approvals.live(actionId);
      if (!live) throw new Error(`no live approval for ${actionId}`);
      return w.owner({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash });
    },
    async advance(ms, step = 30_000) {
      const end = clock.nowMs() + ms;
      while (clock.nowMs() < end) {
        clock.advanceMs(Math.min(step, end - clock.nowMs()));
        await w.d.tick();
      }
    },
    async until(iso, step = 30_000) {
      await w.advance(Math.max(0, Date.parse(iso) - clock.nowMs()), step);
    },
    async restart(extra = {}) {
      await w.d.stop('restart');
      const r2 = await createDaemon(opts(extra));
      if (!r2.ok) throw new Error(`daemon failed to restart: ${r2.error.message}`);
      w.d = r2.value;
    },
    async close() {
      await w.d.stop('test end');
      rmSync(o.home, { recursive: true, force: true });
    },
  };
  return w;
}

export function tokenSetFor(provider: 'google' | 'microsoft', clockIso: string, over: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    provider, accessToken: 'at-0', accessTokenExpiresAt: new Date(Date.parse(clockIso) + 3600_000).toISOString(), refreshToken: 'rt-0',
    scope: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read User.Read', tokenType: 'Bearer',
    accountAddress: OWNER_EMAIL, obtainedAt: clockIso, ...over,
  };
}

/** Marks an OAuth account connected in the daemon's status table (as scripts/connect-account.ts would). */
export function markConnected(w: World, accountId: string, provider: 'google' | 'microsoft', scopes = 'https://www.googleapis.com/auth/gmail.readonly'): void {
  w.d.statusStore.set({ accountId, provider, status: 'connected', statusReason: null, consentedAddress: OWNER_EMAIL, scopes, connectedAt: w.clock.nowIso() });
}

export const gmailAccount = (mode = 'read_only', id = 'gmail-personal') => ({ id, kind: 'gmail', address: OWNER_EMAIL, mode, purpose: 'personal' });

export const sendPayload = (to = 'bob@example.com', body = 'See you at 5') => ({
  kind: 'send_message', accountId: 'gmail-personal', destination: [to], payload: { channel: 'email', to: [to], subject: 'Plan', body },
});
