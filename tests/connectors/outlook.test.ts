import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { makeEnv, tokenSet, type TestEnv } from './helpers.ts';
import { createAccessTokenProvider, createAccountStatusStore, createMemoryTokenStore } from '../../src/connectors/oauth/index.ts';
import { createOutlookReader, type GraphMessage } from '../../src/connectors/outlook/index.ts';
import { createMailStore } from '../../src/connectors/mail/index.ts';
import { ok } from '../../src/core/result.ts';

function gm(id: string, o: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id, conversationId: `c-${id}`, internetMessageId: `<${id}@outlook.example>`, subject: `Subject ${id}`, bodyPreview: 'preview',
    body: { contentType: 'html', content: `<html><body><p>Body of ${id}</p></body></html>` },
    from: { emailAddress: { address: 'sender@example.edu', name: 'Prof X' } }, toRecipients: [{ emailAddress: { address: 'student@example.edu', name: 'Me' } }],
    receivedDateTime: '2026-10-05T15:00:00Z', hasAttachments: false, ...o,
  };
}

function graphFake(s: FakeServer) {
  const state = {
    pages: [] as { value: GraphMessage[] }[], // initial delta pages
    next: [] as { value: GraphMessage[] }[], // response pages for the next deltaLink round
    deltaRound: 0,
    gone: false,
    throttle: 0,
    adminConsent: false,
    foreignNextLink: false,
  };
  const guard = () => {
    if (state.adminConsent) return { status: 403, json: { error: { code: 'Authorization_RequestDenied', message: 'AADSTS65001: The user or administrator has not consented to use the application with ID ...' } } };
    if (state.throttle > 0) {
      state.throttle--;
      return { status: 429, json: { error: { code: 'TooManyRequests' } }, headers: { 'retry-after': '3' } };
    }
    return null;
  };
  s.route('GET', '/graph/me/mailFolders/inbox/messages/delta', (r) => {
    const g = guard();
    if (g) return g;
    const token = r.url.searchParams.get('$deltatoken');
    if (token && state.gone) return { status: 410, json: { error: { code: 'SyncStateNotFound', message: 'resync' } } };
    const skip = Number(r.url.searchParams.get('$skiptoken') ?? -1);
    const pages = token || (skip >= 0 && state.deltaRound > 0) ? state.next : state.pages;
    const idx = skip >= 0 ? skip : 0;
    if (!token && skip < 0) {
      assert.match(r.url.searchParams.get('$filter') ?? '', /^receivedDateTime ge /);
      assert.match(r.url.searchParams.get('$select') ?? '', /internetMessageHeaders/);
    }
    const page = pages[idx] ?? { value: [] };
    const more = idx + 1 < pages.length;
    const nextBase = state.foreignNextLink ? 'https://evil.example' : `${s.base}/graph`;
    return {
      json: {
        value: page.value,
        ...(more
          ? { '@odata.nextLink': `${nextBase}/me/mailFolders/inbox/messages/delta?$skiptoken=${idx + 1}` }
          : { '@odata.deltaLink': `${s.base}/graph/me/mailFolders/inbox/messages/delta?$deltatoken=round${++state.deltaRound}` }),
      },
    };
  });
  s.route('GET', /^\/graph\/me\/messages\/[^/]+\/attachments$/, (r) => {
    assert.equal(r.url.searchParams.get('$select'), 'id,name,contentType,size,isInline');
    return { json: { value: [{ id: 'a1', name: 'rubric.pdf', contentType: 'application/pdf', size: 2048, isInline: false }] } };
  });
  s.route('GET', '/graph/me/messages', (r) => {
    const g = guard();
    if (g) return g;
    const skip = Number(r.url.searchParams.get('$skip') ?? 0);
    const all = [gm('l1'), gm('l2'), gm('l3')];
    return { json: { value: all.slice(skip, skip + 2), ...(skip + 2 < all.length ? { '@odata.nextLink': `${s.base}/graph/me/messages?$skip=${skip + 2}` } : {}) } };
  });
  return state;
}

async function setup(env: TestEnv, s: FakeServer) {
  const tokens = createMemoryTokenStore();
  const status = createAccountStatusStore(env.db, env.clock);
  await tokens.set('outlook-work', tokenSet('microsoft', env.clock.nowIso()));
  status.set({ accountId: 'outlook-work', provider: 'microsoft', status: 'connected', statusReason: null, consentedAddress: 'student@example.edu', scopes: 'Mail.Read' });
  const provider = createAccessTokenProvider({ accountId: 'outlook-work', provider: 'microsoft', tokenStore: tokens, statusStore: status, clock: env.clock, refresh: async (t) => ok(t) });
  const store = createMailStore(env.db, env.clock, { schoolDomains: ['example.edu'] });
  const reader = createOutlookReader({ accountId: 'outlook-work', tokens: provider, store, clock: env.clock, fetch, sleep: env.sleep, graphBase: `${s.base}/graph`, statusStore: status });
  return { reader, store, status };
}

test('Outlook delta: nextLink pagination, deltaLink persisted, attachment metadata, no duplicates', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const g = graphFake(s);
    g.pages = [{ value: [gm('o1'), gm('o2', { hasAttachments: true })] }, { value: [gm('o3')] }];
    const { reader, store } = await setup(env, s);
    const r = await reader.sync();
    assert.equal(r.status, 'ok');
    assert.equal(r.mode, 'full');
    assert.equal(r.inserted, 3);
    assert.match(store.getSyncState('outlook-work')!.cursor!, /deltatoken=round1$/);
    const o2 = store.get('outlook-work', 'o2')!;
    assert.deepEqual(o2.attachments, [{ name: 'rubric.pdf', mimeType: 'application/pdf', size: 2048, providerAttachmentId: 'a1', inline: false }]);
    assert.equal(o2.bodyText, 'Body of o2');
    assert.equal(o2.category, 'school');
    // Next round: one new, one changed (same content → unchanged), one removed.
    g.next = [{ value: [gm('o4'), gm('o1'), { id: 'o3', '@removed': { reason: 'deleted' } } as GraphMessage] }];
    const r2 = await reader.sync();
    assert.equal(r2.mode, 'incremental');
    assert.deepEqual([r2.inserted, r2.unchanged, r2.deleted], [1, 1, 1]);
    assert.match(store.getSyncState('outlook-work')!.cursor!, /round2$/);
    assert.equal(store.count('outlook-work'), 4);
    assert.ok(s.requests.every((q) => q.method === 'GET'));
    assert.ok(s.requests.every((q) => q.headers.authorization === 'Bearer at-1'));
  } finally {
    await s.close();
    env.close();
  }
});

test('Outlook delta token expired (410) → full resync', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const g = graphFake(s);
    g.pages = [{ value: [gm('o1')] }];
    const { reader } = await setup(env, s);
    await reader.sync();
    g.gone = true;
    g.pages = [{ value: [gm('o1'), gm('o9')] }];
    const r = await reader.sync();
    assert.equal(r.mode, 'full_after_expiry');
    assert.equal(r.status, 'ok');
    assert.deepEqual([r.inserted, r.unchanged], [1, 1]);
  } finally {
    await s.close();
    env.close();
  }
});

test('Outlook throttling honours Retry-After', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const g = graphFake(s);
    g.pages = [{ value: [gm('o1')] }];
    g.throttle = 2;
    const { reader } = await setup(env, s);
    const r = await reader.sync();
    assert.equal(r.status, 'ok');
    assert.deepEqual(env.sleeps, [3000, 3000]);
  } finally {
    await s.close();
    env.close();
  }
});

test('Outlook admin-consent error is a blocker status, not retried', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const g = graphFake(s);
    g.adminConsent = true;
    const { reader, store, status } = await setup(env, s);
    const r = await reader.sync();
    assert.equal(r.status, 'admin_consent_required');
    assert.equal(store.getSyncState('outlook-work')!.status, 'admin_consent_required');
    assert.equal(status.get('outlook-work')!.status, 'admin_consent_required');
    assert.equal(s.requests.length, 1, 'no retries');
    assert.equal(env.sleeps.length, 0);
  } finally {
    await s.close();
    env.close();
  }
});

test('Outlook refuses to send the bearer token to a nextLink on another host', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    const g = graphFake(s);
    g.pages = [{ value: [gm('o1')] }, { value: [gm('o2')] }];
    g.foreignNextLink = true;
    const { reader } = await setup(env, s);
    const r = await reader.sync();
    assert.equal(r.status, 'error');
    assert.match(r.error!.message, /outside Microsoft Graph/);
  } finally {
    await s.close();
    env.close();
  }
});

test('Outlook /me/messages listing follows @odata.nextLink', async () => {
  const s = await startFakeServer();
  const env = makeEnv();
  try {
    graphFake(s);
    const { reader } = await setup(env, s);
    const p1 = await reader.listMessages({ top: 2 });
    assert.ok(p1.ok);
    assert.equal(p1.value.messages.length, 2);
    const p2 = await reader.listMessages({ nextLink: p1.value.nextLink! });
    assert.ok(p2.ok);
    assert.deepEqual(p2.value.messages.map((m) => m.providerMessageId), ['l3']);
    assert.equal(p2.value.nextLink, null);
  } finally {
    await s.close();
    env.close();
  }
});
