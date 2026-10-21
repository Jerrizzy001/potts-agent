import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assertLoopbackUrl,
  buildContext,
  buildContextSemantic,
  createLmStudioEmbeddings,
  detectSensitive,
  disabledEmbeddings,
  embeddingsFromConfig,
  estimateTokens,
  HARD_MAX_FACTS,
  OWNER_SOURCE_ID,
  scrubPii,
} from './_imports.ts';
import { memEnv } from './helpers.ts';

test('embeddings adapter refuses every non-loopback URL and has no cloud fallback', () => {
  for (const bad of [
    'https://api.openai.com/v1/embeddings',
    'http://localhost:1234/v1/embeddings',
    'http://10.0.0.5:1234/v1/embeddings',
    'http://192.168.1.2:1234/v1/embeddings',
    'http://0.0.0.0:1234/v1/embeddings',
    'http://[::ffff:8.8.8.8]:1234/',
    'http://user:pw@127.0.0.1:1234/v1/embeddings',
    'ftp://127.0.0.1/x',
    'http://127.0.0.1.evil.test/v1',
    'not a url',
  ]) {
    assert.equal(assertLoopbackUrl(bad).ok, false, bad);
    assert.equal(createLmStudioEmbeddings({ url: bad, model: 'm' }).ok, false, bad);
  }
  for (const good of ['http://127.0.0.1:1234/v1/embeddings', 'http://127.1:1234/v1/embeddings', 'http://[::1]:1234/v1/embeddings']) {
    assert.equal(assertLoopbackUrl(good).ok, true, good);
  }
  // Default is disabled; config without provider is disabled.
  const d = embeddingsFromConfig(undefined);
  assert.ok(d.ok && d.value === disabledEmbeddings && !d.value.enabled);
  assert.equal(embeddingsFromConfig({ provider: 'lmstudio', url: 'https://example.com/v1/embeddings', model: 'x' }).ok, false);
  assert.equal(embeddingsFromConfig({ provider: 'lmstudio' }).ok, false, 'model id required');
});

test('LM Studio adapter posts to loopback with redirects refused, and semantic search merges with FTS', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const vec = (t: string) => (t.includes('coffee') || t.includes('espresso') ? [1, 0, 0] : t.includes('tea') ? [0, 1, 0] : [0, 0, 1]);
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const body = JSON.parse(String(init!.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: vec(t) })) }), { status: 200 });
  }) as typeof fetch;
  const p = createLmStudioEmbeddings({ model: 'nomic-embed', fetchImpl: fakeFetch });
  assert.ok(p.ok);
  const env = memEnv({ embeddings: p.value });
  try {
    const a = env.memory.remember({ text: 'Owner drinks espresso every morning', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    env.memory.remember({ text: 'Owner dislikes green tea', sourceId: OWNER_SOURCE_ID, status: 'verified', confidence: 1 });
    assert.ok(a.ok);
    assert.equal(await env.memory.embedPending(), 2);
    assert.equal(await env.memory.embedPending(), 0);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:1234/v1/embeddings');
    assert.equal(calls[0]!.init.redirect, 'error');
    const hits = await env.memory.semanticSearch('coffee');
    assert.equal(hits[0]!.fact.id, a.value.id, 'semantic match without lexical overlap');
    const ctx = await buildContextSemantic(env.memory, 'coffee', { tokenBudget: 200 });
    assert.equal(ctx.facts[0]!.id, a.value.id);
    // Forget removes embeddings too.
    env.memory.forget(a.value.id);
    assert.equal((env.db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as { n: number }).n, 1);
  } finally {
    env.cleanup();
  }
  // Server error surfaces as an error (no fallback to anything else).
  const failing = createLmStudioEmbeddings({ model: 'm', fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch });
  assert.ok(failing.ok);
  await assert.rejects(failing.value.embed(['x']));
});

test('retrieval respects the token budget and fact cap, with provenance, never the whole archive', () => {
  const env = memEnv();
  try {
    env.memory.registerSource({ id: 'src_mail', kind: 'gmail' });
    for (let i = 0; i < 60; i++) {
      env.memory.remember({
        text: `Project Orion note number ${i}: ${'details about the orion milestone and its owners '.repeat(1 + (i % 4))}`,
        sourceId: i % 2 ? 'src_mail' : OWNER_SOURCE_ID,
        sourceRef: i % 2 ? `gmail:msg:${i}` : undefined,
        status: i % 3 === 0 ? 'verified' : 'draft',
        confidence: 0.5 + (i % 5) / 10,
      });
    }
    for (const budget of [40, 120, 400, 2000]) {
      const c = buildContext(env.memory, 'orion milestone', { tokenBudget: budget, maxFacts: 50 });
      assert.ok(c.tokensUsed <= budget, `used ${c.tokensUsed} > ${budget}`);
      assert.ok(estimateTokens(c.text) <= budget);
      assert.ok(c.facts.length <= HARD_MAX_FACTS);
      assert.ok(c.facts.length < 60);
      assert.ok(c.omitted > 0);
      for (const f of c.facts) {
        assert.ok(f.source.id && f.source.kind && f.recordedAt);
        assert.ok(c.text.includes(`id=${f.id}`));
      }
    }
    const small = buildContext(env.memory, 'orion milestone', { tokenBudget: 120 });
    assert.ok(small.facts.length >= 1);
    const tiny = buildContext(env.memory, 'orion', { tokenBudget: 5 });
    assert.equal(tiny.facts.length, 0);
    assert.equal(tiny.text, '');
    const none = buildContext(env.memory, 'nonexistentterm', { tokenBudget: 500 });
    assert.equal(none.facts.length, 0);
    const verifiedOnly = buildContext(env.memory, 'orion', { tokenBudget: 2000, statuses: ['verified'] });
    assert.ok(verifiedOnly.facts.every((f) => f.status === 'verified'));
    assert.match(verifiedOnly.text, /\[verified \d\.\d\d; (owner_stated|gmail):/);
  } finally {
    env.cleanup();
  }
});

test('sensitive-content detection excludes credentials, codes, cards, ids, token links and addresses', () => {
  const sensitive: [string, string][] = [
    ['Your verification code is 482913', 'otp_code'],
    ['G-482913 is your Google verification code', 'otp_code'],
    ['482913', 'otp_code'],
    ['code: 4829', 'otp_code'],
    ['the wifi password is hunter22', 'credential'],
    ['my pw: Tr0ub4dor&3', 'credential'],
    ['pin is 4455', 'credential'],
    ['here are my backup codes', 'credential'],
    ['use sk-abcdefghijklmnopqrstuvwx1234', 'secret_token'],
    ['key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP', 'secret_token'],
    ['token 9fK2mQ7xL4pR8vT1wZ6yB3nH5', 'secret_token'],
    ['reset here https://example.com/reset?token=abc123def', 'token_url'],
    ['https://zoom.us/j/123?pwd=AbCdEf123', 'token_url'],
    ['card 4111 1111 1111 1111 exp 04/29', 'card_number'],
    ['sin 123-456-789', 'government_id'],
    ['passport number GA123456', 'government_id'],
    ['transit number 12345 account number 1234567', 'bank_account'],
    ['IBAN GB82 WEST 1234 5698 7654 32', 'bank_account'],
    ['come to 123 Main Street', 'street_address'],
    ['im at 45B King St W', 'street_address'],
    ['unit 1203 buzz me', 'street_address'],
    ['postal code M5V 2T6', 'street_address'],
  ];
  for (const [text, reason] of sensitive) {
    const v = detectSensitive(text);
    assert.ok(v.sensitive, `should flag: ${text}`);
    assert.ok(v.reasons.includes(reason as never), `${text} -> ${v.reasons.join(',')} (expected ${reason})`);
  }
  for (const ok of ['yo you coming tonight?', 'lol thats wild', 'Thanks for the update, I will review it tomorrow.', 'meet at 7?', 'see https://example.com/blog/post-title', 'I have 2 dogs and 3 cats', 'call me at 5']) {
    assert.equal(detectSensitive(ok).sensitive, false, `false positive: ${ok}`);
  }
  const s = scrubPii('email me at jane.doe@example.com or 416-555-0199, see https://x.test/a, @janedoe, order 1234567');
  assert.equal(s.text, 'email me at [email] or [phone], see [link], [handle], order [number]');
  assert.equal(s.replacements, 5);
  assert.equal(scrubPii('call +44 20 7946 0958 now').text, 'call [phone] now');
});
