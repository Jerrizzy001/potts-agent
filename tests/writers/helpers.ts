/**
 * Test environment for WP-7: a real broker (temp DB, fake clock) whose
 * executor registry contains ONLY the executors under test, plus fake
 * providers. No network, no osascript, no real chat.db.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../../src/core/clock.ts';
import { createAccountRegistry, type AccountEntry, type AccountRegistry } from '../../src/core/config.ts';
import { openDatabase, type Db } from '../../src/store/db.ts';
import { migrate } from '../../src/store/migrate.ts';
import { buildPolicy, DEFAULT_POLICY, type LoadedPolicy, type PolicyDocument } from '../../src/policy/document.ts';
import type { PolicyHooks } from '../../src/policy/decide.ts';
import { createIngressVerifier, signOwnerIngress, type OwnerIngressFields, type OwnerIntent } from '../../src/approvals/ingress.ts';
import { createExecutorRegistry, type Executor } from '../../src/broker/executor.ts';
import { createBroker, type Broker, type BrokerOptions } from '../../src/broker/broker.ts';
import { createOwnerControls, type OwnerControls } from '../../src/broker/owner.ts';
import { TEST_ACCOUNTS, TEST_OWNER_ID } from '../../src/broker/testing.ts';

export const ACCOUNTS: AccountEntry[] = [
  ...TEST_ACCOUNTS,
  { id: 'outlook-personal', kind: 'outlook', address: 'alex@outlook.example', mode: 'approval_required', purpose: 'personal' },
  { id: 'imessage-owner', kind: 'imessage', address: 'owner@icloud.example', mode: 'approval_required', purpose: 'personal' },
];

export interface Env {
  dir: string;
  db: Db;
  clock: FakeClock;
  accounts: AccountRegistry;
  broker: Broker;
  owner: OwnerControls;
  policy: { current: LoadedPolicy };
  setPolicy(doc: Partial<PolicyDocument>): void;
  sign(intent: OwnerIntent, ov?: Partial<OwnerIngressFields>): ReturnType<typeof signOwnerIngress>;
  approve(actionId: string): ReturnType<OwnerControls['handle']>;
  reopen(o?: { testHooks?: BrokerOptions['testHooks'] }): Env;
  close(): void;
}

export interface EnvOptions {
  executors: (ctx: { db: Db; clock: FakeClock; accounts: AccountRegistry }) => Executor[];
  accounts?: AccountEntry[];
  policy?: Partial<PolicyDocument>;
  hooks?: PolicyHooks | ((ctx: { db: Db; clock: FakeClock }) => PolicyHooks);
  testHooks?: BrokerOptions['testHooks'];
  executorTimeoutMs?: number;
  reuse?: { dir: string; clock: FakeClock; key: Buffer; policy: { current: LoadedPolicy }; seq: { n: number } };
}

export function createEnv(o: EnvOptions): Env {
  const dir = o.reuse?.dir ?? mkdtempSync(join(tmpdir(), 'potts-wp7-'));
  const clock = o.reuse?.clock ?? createFakeClock('2026-10-06T14:00:00.000Z');
  const key = o.reuse?.key ?? randomBytes(32);
  const seq = o.reuse?.seq ?? { n: 5000 };
  const mk = (doc: Partial<PolicyDocument>) => {
    const r = buildPolicy({ ...DEFAULT_POLICY, ...doc });
    if (!r.ok) throw r.error;
    return r.value;
  };
  const policy = o.reuse?.policy ?? { current: mk(o.policy ?? {}) };
  const db = openDatabase(join(dir, 'potts.db'));
  migrate(db, { clock });
  const accounts = createAccountRegistry(o.accounts ?? ACCOUNTS);
  const registry = createExecutorRegistry();
  for (const e of o.executors({ db, clock, accounts })) registry.register(e);
  const hooks = typeof o.hooks === 'function' ? o.hooks({ db, clock }) : o.hooks;
  const broker = createBroker({
    db, clock, accounts, executors: registry, policy: () => policy.current,
    ...(hooks ? { hooks } : {}),
    ...(o.testHooks ? { testHooks: o.testHooks } : {}),
    ...(o.executorTimeoutMs ? { executorTimeoutMs: o.executorTimeoutMs } : {}),
  });
  const owner = createOwnerControls(broker, createIngressVerifier({ key, ownerSenderId: TEST_OWNER_ID, clock }), accounts);
  const sign = (intent: OwnerIntent, ov: Partial<OwnerIngressFields> = {}) =>
    signOwnerIngress(key, { source: 'telegram', senderId: TEST_OWNER_ID, chatId: TEST_OWNER_ID, chatType: 'private', updateId: String(++seq.n), receivedAt: clock.nowIso(), intent, ...ov });
  const env: Env = {
    dir, db, clock, accounts, broker, owner, policy,
    setPolicy(doc) {
      policy.current = mk({ ...policy.current.doc, ...doc });
    },
    sign,
    approve(actionId) {
      const live = broker.approvals.live(actionId);
      if (!live) throw new Error(`no live approval for ${actionId}`);
      return owner.handle(sign({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash }));
    },
    reopen(x = {}) {
      try {
        db.close();
      } catch {
        /* closed */
      }
      const { testHooks: _t, ...rest } = o;
      return createEnv({ ...rest, ...(x.testHooks ? { testHooks: x.testHooks } : {}), reuse: { dir, clock, key, policy, seq } });
    },
    close() {
      try {
        db.close();
      } catch {
        /* closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return env;
}

export const fakeTokens = (overrides: Record<string, string> = {}) => ({
  requests: [] as { accountId: string; purpose: string; scopes: readonly string[] }[],
  async getAccessToken(req: { accountId: string; purpose: 'send' | 'lookup'; scopes: readonly string[] }) {
    this.requests.push(req);
    if (overrides[req.accountId] === 'FAIL') throw new Error('token store: no credential');
    return overrides[req.accountId] ?? `test-access-${req.accountId}-${req.purpose}`;
  },
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type SendMode = 'ok' | 'reject400' | 'http500_after_accept' | 'network_after_accept' | 'network_before_accept';

/** Fake Gmail REST API (users/me). Records every accepted raw message. */
export function createFakeGmail(mailbox: string) {
  const sent: { id: string; threadId: string; raw: string; mime: string; labelIds: string[]; requestThreadId?: string }[] = [];
  const state = { mode: 'ok' as SendMode, profileAddress: mailbox, sendCalls: 0, rewriteMessageId: false };
  let n = 0;
  const header = (mime: string, name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(mime.split('\r\n\r\n')[0]!)?.[1]?.trim();
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace('/gmail/v1/users/me', '');
    const method = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    if (!auth?.startsWith('Bearer ')) return json(401, { error: { message: 'no auth' } });
    if (method === 'GET' && path === '/profile') return json(200, { emailAddress: state.profileAddress });
    if (method === 'GET' && u.host === 'openidconnect.googleapis.com' && u.pathname === '/v1/userinfo') return json(200, { email: state.profileAddress, email_verified: true });
    if (method === 'POST' && path === '/messages/send') {
      state.sendCalls++;
      if (state.mode === 'reject400') return json(400, { error: { message: 'Invalid To header' } });
      if (state.mode === 'network_before_accept') throw new TypeError('fetch failed');
      const body = JSON.parse(String(init.body)) as { raw: string; threadId?: string };
      let mime = Buffer.from(body.raw, 'base64url').toString('utf8');
      if (state.rewriteMessageId) mime = mime.replace(/^Message-ID: .*$/m, `Message-ID: <rewritten-${n}@mail.gmail.com>`);
      const id = `gm${++n}`;
      sent.push({ id, threadId: body.threadId ?? `th${n}`, raw: body.raw, mime, labelIds: ['SENT'], ...(body.threadId ? { requestThreadId: body.threadId } : {}) });
      if (state.mode === 'http500_after_accept') return json(500, { error: { message: 'backend error' } });
      if (state.mode === 'network_after_accept') throw new TypeError('fetch failed: socket hang up');
      return json(200, { id, threadId: body.threadId ?? `th${n}`, labelIds: ['SENT'] });
    }
    if (method === 'GET' && path === '/messages') {
      const q = u.searchParams.get('q') ?? '';
      let hits = sent;
      const m = /^rfc822msgid:(.+)$/.exec(q);
      if (m) hits = sent.filter((s) => header(s.mime, 'Message-ID') === m[1]);
      return json(200, hits.length ? { messages: hits.map((s) => ({ id: s.id, threadId: s.threadId })) } : { resultSizeEstimate: 0 });
    }
    const g = /^\/messages\/([^/]+)$/.exec(path);
    if (method === 'GET' && g) {
      const s = sent.find((x) => x.id === g[1]);
      if (!s) return json(404, { error: { message: 'not found' } });
      return json(200, { id: s.id, labelIds: s.labelIds, payload: { headers: [{ name: 'X-Potts-Action', value: header(s.mime, 'X-Potts-Action') ?? '' }] } });
    }
    return json(404, { error: { message: `unhandled ${method} ${path}` } });
  };
  return { fetch, sent, state };
}

/** Fake Microsoft Graph mail endpoints with immutable ids. */
export function createFakeGraph(mailbox: string) {
  const messages = new Map<string, Record<string, unknown> & { isDraft: boolean; attachments: unknown[] }>();
  const state = { sendMode: 'ok' as SendMode, sendCalls: 0, tamperDraft: false, meAddress: mailbox };
  let n = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const method = init.method ?? 'GET';
    const hdrs = (init.headers ?? {}) as Record<string, string>;
    if (!hdrs.authorization?.startsWith('Bearer ')) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    if (method === 'GET' && path === '/me') return json(200, { mail: state.meAddress, userPrincipalName: state.meAddress });
    if (method === 'POST' && path === '/me/messages') {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `AAMkImm${++n}`;
      messages.set(id, { ...b, id, isDraft: true, attachments: [] });
      if (state.tamperDraft) (messages.get(id)!.toRecipients as unknown[]).push({ emailAddress: { address: 'extra@evil.example' } });
      return json(201, { id });
    }
    let m = /^\/me\/messages\/([^/]+)\/createReply$/.exec(path);
    if (method === 'POST' && m) {
      const id = `AAMkReply${++n}`;
      messages.set(id, { id, isDraft: true, subject: 'RE: original', body: { contentType: 'html', content: '<p>quoted</p>' }, toRecipients: [{ emailAddress: { address: 'orig@example.com' } }], ccRecipients: [], bccRecipients: [], attachments: [], replyTo: m[1] });
      return json(201, { id });
    }
    m = /^\/me\/messages\/([^/]+)\/attachments$/.exec(path);
    if (method === 'POST' && m) {
      messages.get(m[1]!)!.attachments.push(JSON.parse(String(init.body)));
      return json(201, {});
    }
    m = /^\/me\/messages\/([^/]+)\/send$/.exec(path);
    if (method === 'POST' && m) {
      state.sendCalls++;
      if (state.sendMode === 'reject400') return json(400, { error: { code: 'ErrorInvalidRecipients' } });
      if (state.sendMode === 'network_before_accept') throw new TypeError('fetch failed');
      messages.get(m[1]!)!.isDraft = false;
      if (state.sendMode === 'network_after_accept') throw new TypeError('fetch failed: socket hang up');
      if (state.sendMode === 'http500_after_accept') return json(503, { error: { code: 'ServiceUnavailable' } });
      return new Response(null, { status: 202 });
    }
    m = /^\/me\/messages\/([^/]+)$/.exec(path);
    if (m && method === 'PATCH') {
      const msg = messages.get(m[1]!);
      if (!msg) return json(404, {});
      Object.assign(msg, JSON.parse(String(init.body)));
      return json(200, msg);
    }
    if (m && method === 'GET') {
      const msg = messages.get(m[1]!);
      if (!msg) return json(404, { error: { code: 'ErrorItemNotFound' } });
      return json(200, msg);
    }
    if (method === 'GET' && path === '/me/mailFolders/sentitems/messages') {
      const f = u.searchParams.get('$filter') ?? '';
      const imid = /internetMessageId eq '(.+)'/.exec(f)?.[1];
      return json(200, { value: [...messages.values()].filter((x) => !x.isDraft && x.internetMessageId === imid).map((x) => ({ id: x.id })) });
    }
    return json(404, { error: { code: `unhandled ${method} ${path}` } });
  };
  const sentMessages = () => [...messages.values()].filter((x) => !x.isDraft);
  return { fetch, messages, state, sentMessages };
}
