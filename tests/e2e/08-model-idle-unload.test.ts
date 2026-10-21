/**
 * Evidence: "Model unloads after idle time" → the next allowed request reloads
 * the 9B model with 32K context, one request and the 600-second TTL; 27B stays
 * unloaded. Potts cannot set LM Studio's load settings (those are the owner's
 * persisted defaults); what Potts controls — and what is verified here — is
 * that every request it makes names exactly qwen/qwen3.5-9b, carries no load
 * overrides (context length, TTL, parallelism) and goes only to loopback.
 * The fake LM Studio models JIT load + 600 s idle unload with those defaults.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeNet, gmailAccount, makeHome, markConnected, routeGmail, routeLmStudio, startWorld, tokenSetFor } from './_harness.ts';
import { createFakeClock } from '../../src/core/clock.ts';

test('E2E-08 every model request is qwen/qwen3.5-9b on loopback; idle unload → JIT reload of the 9B only', async () => {
  const start = '2026-10-07T12:50:00Z'; // 08:50 EDT
  const home = makeHome({
    accounts: [gmailAccount('read_only')],
    potts: (c) => {
      (c.monitoring as Record<string, unknown>).enabled = false;
      (c.notifications as Record<string, unknown>).summarizer = { enabled: true, baseUrl: 'http://127.0.0.1:1234', model: 'qwen/qwen3.5-9b', timeoutMs: 90000 };
      ((c.connectors as Record<string, unknown>).mail as Record<string, unknown>).localClassifier = { enabled: true, baseUrl: 'http://127.0.0.1:1234', model: 'qwen/qwen3.5-9b' };
    },
  });
  const clock = createFakeClock(start);
  const net = createFakeNet();
  const gmail = routeGmail(net);
  const lm = routeLmStudio(net, clock);
  gmail.addInbox('m1', { from: 'Recruiter <talent@acme.example>', subject: 'Interview availability next week', text: 'We would like to schedule an interview. Please share your availability for a 30 minute call.' });
  const w = await startWorld({ home, start, clock, net, keychain: { 'potts/google-oauth-client-secret': 'cs' }, tokens: { 'gmail-personal': tokenSetFor('google', start, { accessTokenExpiresAt: '2026-10-09T00:00:00Z' }) } });
  try {
    markConnected(w, 'gmail-personal', 'google');
    // Something new for each briefing so the summariser is used.
    w.d.broker.propose({ kind: 'deploy', destination: ['cloudflare:example.com'], payload: { sha: 'abc' } }, 'openclaw/potts');
    await w.until('2026-10-07T13:05:00Z'); // 09:05: mail sync (classifier) + morning briefing (summariser)
    w.d.broker.propose({ kind: 'merge', destination: ['github:demo#main'], payload: { sha: 'def' } }, 'openclaw/potts');
    await w.until('2026-10-07T22:05:00Z', 5 * 60_000); // through 18:00, idle gaps > 600 s, then 21:00 reload
    assert.ok(lm.requests.length >= 2, `model was used (${lm.requests.length} requests)`);
    for (const r of lm.requests) {
      assert.equal(r.model, 'qwen/qwen3.5-9b');
      for (const k of ['ttl', 'context_length', 'contextLength', 'num_ctx', 'n_parallel', 'parallel', 'draft_model']) assert.ok(!(k in r.body), `request must not override ${k}`);
    }
    assert.ok(lm.loads.length >= 2, 'idle unload happened and the next request reloaded');
    for (const l of lm.loads) assert.deepEqual({ model: l.model, ctx: l.contextLength, parallel: l.parallel, ttl: l.ttlSeconds }, { model: 'qwen/qwen3.5-9b', ctx: 32768, parallel: 1, ttl: 600 });
    assert.ok(!lm.loads.some((l) => /27b/i.test(l.model)), '27B never loaded');
    // Only loopback was used for model traffic.
    for (const r of w.net.log.filter((x) => /chat\/completions|\/v1\/models/.test(x.url))) assert.ok(r.url.startsWith('http://127.0.0.1:1234/'));
  } finally {
    await w.close();
  }
});

test('E2E-08b no source file or example config names a 27B model id', () => {
  const root = join(import.meta.dirname, '../..');
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|json)$/.test(p) && /qwen[^"'\s]*27b/i.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  for (const d of ['src', 'config', 'integrations/openclaw/potts-broker-plugin']) walk(join(root, d));
  assert.deepEqual(hits, []);
});
