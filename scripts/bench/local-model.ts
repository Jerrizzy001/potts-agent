#!/usr/bin/env node
/**
 * OWNER-RUN local model benchmark (WP-8). Potts never runs this itself.
 *
 *   npm run bench:local-model -- --yes [--runs 3] [--model qwen/qwen3.5-9b]
 *
 * Talks to LM Studio's OpenAI-compatible API on loopback only and measures:
 *   (a) first ("cold" if the model was reported not loaded) simple reply,
 *   (b) N warm simple replies (wall time, time to first streamed chunk, tokens),
 *   (c) a short 2-round tool workflow (tool call -> tool result -> final answer).
 * Targets from the plan: simple reply <= 30 s, short tool workflow <= 60 s.
 * It never changes LM Studio settings and never loads/unloads models explicitly;
 * a request to an unloaded model triggers LM Studio's on-demand load.
 * Refuses any model id containing "27b".
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SIMPLE_TARGET_MS = 30_000;
const TOOL_TARGET_MS = 60_000;
const EXPECTED_CONTEXT = 32_768;
const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_MODEL = 'qwen/qwen3.5-9b';
const SIMPLE_PROMPT = 'Reply with one short sentence: what is 2+2?';
const BANNER = 'This will load the local model if it is not loaded. Do not run while the Telegram assistant is in active use.';

const USAGE = `usage: local-model.ts --yes [options]

  --yes              required: confirm you want to run the benchmark now
  --base-url <url>   LM Studio API (loopback only: 127.0.0.1 or [::1]; default ${DEFAULT_BASE_URL})
  --model <id>       model id (default ${DEFAULT_MODEL}; ids containing "27b" are refused)
  --runs <n>         warm simple-reply runs (default 3)
  --timeout-ms <ms>  per-request timeout (default 180000)
  --no-write         do not write the JSON report
  --unload-first     print how to unload the model manually for a cold run (never unloads)
  -h, --help         show this help

Report: $POTTS_HOME/bench/local-model-<timestamp>.json (mode 0600).`;

interface ModelInfo {
  listedInV1Models: boolean | null;
  state: string | null;
  loadConfig: Record<string, unknown> | null;
  contextLength: number | null;
  contextSource: string | null;
}

interface ChatResult {
  ok: boolean;
  wallMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  text: string;
  error: string | null;
}

interface ToolResult {
  ok: boolean;
  totalMs: number;
  round1Ms: number;
  round2Ms: number | null;
  toolCallProduced: boolean;
  toolName: string | null;
  finalText: string;
  error: string | null;
}

type Verdict = 'PASS' | 'MISS';

function fail(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

function validateBaseUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { fail(`invalid --base-url: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`--base-url must be http(s): ${raw}`);
  if (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') fail(`--base-url must be loopback 127.0.0.1 or [::1], got ${u.hostname}`);
  if (u.username || u.password) fail('--base-url must not contain credentials');
  return u;
}

function validateModel(model: string): string {
  if (!model.trim()) fail('--model is empty');
  if (/27b/i.test(model)) fail(`model "${model}" looks like the 27B model; this benchmark only targets the 9B model`);
  return model;
}

function endpoint(base: URL, path: string): string {
  const b = base.href.replace(/\/+$/, '');
  return `${b}${path}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Reads model availability, load state and visible load config without changing anything. */
async function inspectModel(base: URL, model: string, timeoutMs: number): Promise<ModelInfo> {
  const info: ModelInfo = { listedInV1Models: null, state: null, loadConfig: null, contextLength: null, contextSource: null };
  try {
    const v1 = asRecord(await getJson(endpoint(base, '/v1/models'), timeoutMs));
    const data = Array.isArray(v1?.data) ? v1.data : [];
    info.listedInV1Models = data.some((m) => asRecord(m)?.id === model);
  } catch { /* not available */ }
  try {
    const v0 = asRecord(await getJson(endpoint(base, '/api/v0/models'), timeoutMs));
    const data = Array.isArray(v0?.data) ? v0.data : [];
    const entry = data.map(asRecord).find((m) => m?.id === model) ?? null;
    if (entry) {
      info.state = typeof entry.state === 'string' ? entry.state : null;
      const cfg: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (/context|quant|arch|parallel|ttl|type|compat|format/i.test(k)) cfg[k] = v;
      }
      info.loadConfig = cfg;
      const loaded = num(entry.loaded_context_length) ?? num(entry.context_length);
      const max = num(entry.max_context_length);
      if (loaded !== null) { info.contextLength = loaded; info.contextSource = 'loaded context length'; }
      else if (max !== null) { info.contextLength = max; info.contextSource = 'max_context_length (loaded context not exposed)'; }
    }
  } catch { /* not available */ }
  return info;
}

/** Streaming chat completion; TTFT = first SSE `data:` chunk that is not [DONE]. */
async function streamChat(base: URL, model: string, timeoutMs: number): Promise<ChatResult> {
  const start = performance.now();
  const result: ChatResult = { ok: false, wallMs: 0, ttftMs: null, promptTokens: null, completionTokens: null, text: '', error: null };
  try {
    const res = await fetch(endpoint(base, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 128,
        temperature: 0,
        messages: [{ role: 'user', content: SIMPLE_PROMPT }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        if (result.ttftMs === null) result.ttftMs = performance.now() - start;
        let evt: Record<string, unknown> | null = null;
        try { evt = asRecord(JSON.parse(payload)); } catch { continue; }
        const choices = Array.isArray(evt?.choices) ? evt.choices : [];
        const delta = asRecord(asRecord(choices[0])?.delta);
        if (typeof delta?.content === 'string') result.text += delta.content;
        const usage = asRecord(evt?.usage);
        if (usage) {
          result.promptTokens = num(usage.prompt_tokens);
          result.completionTokens = num(usage.completion_tokens);
        }
      }
    }
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  result.wallMs = performance.now() - start;
  return result;
}

const GET_TIME_TOOL = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Returns the current local time for a timezone.',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. America/Toronto' } },
      required: ['timezone'],
    },
  },
} as const;

async function postChat(base: URL, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint(base, '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return asRecord(await res.json()) ?? {};
}

async function toolWorkflow(base: URL, model: string, timeoutMs: number): Promise<ToolResult> {
  const start = performance.now();
  const r: ToolResult = { ok: false, totalMs: 0, round1Ms: 0, round2Ms: null, toolCallProduced: false, toolName: null, finalText: '', error: null };
  try {
    const messages: unknown[] = [{ role: 'user', content: 'What time is it in Toronto right now? Use the get_time tool, then answer in one sentence.' }];
    const first = await postChat(base, { model, messages, tools: [GET_TIME_TOOL], tool_choice: 'auto', temperature: 0, max_tokens: 256 }, timeoutMs);
    r.round1Ms = performance.now() - start;
    const choices = Array.isArray(first.choices) ? first.choices : [];
    const msg = asRecord(asRecord(choices[0])?.message) ?? {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(asRecord).filter((c) => c !== null) : [];
    if (calls.length === 0) {
      r.finalText = typeof msg.content === 'string' ? msg.content : '';
      r.ok = true;
    } else {
      r.toolCallProduced = true;
      const call = calls[0] ?? {};
      const fn = asRecord(call.function);
      r.toolName = typeof fn?.name === 'string' ? fn.name : null;
      messages.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '', tool_calls: calls });
      // Synthetic, fixed tool output: the benchmark measures latency, not clock accuracy.
      messages.push({ role: 'tool', tool_call_id: typeof call.id === 'string' ? call.id : 'call_0', content: JSON.stringify({ timezone: 'America/Toronto', time: '09:30' }) });
      const t2 = performance.now();
      const second = await postChat(base, { model, messages, tools: [GET_TIME_TOOL], temperature: 0, max_tokens: 256 }, timeoutMs);
      r.round2Ms = performance.now() - t2;
      const c2 = Array.isArray(second.choices) ? second.choices : [];
      const m2 = asRecord(asRecord(c2[0])?.message);
      r.finalText = typeof m2?.content === 'string' ? m2.content : '';
      r.ok = true;
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
  }
  r.totalMs = performance.now() - start;
  return r;
}

function verdict(ok: boolean, ms: number, target: number): Verdict {
  return ok && ms <= target ? 'PASS' : 'MISS';
}

const s = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(2)} s`);

function resolveHome(): string {
  const o = process.env.POTTS_HOME;
  if (o && o.trim()) return isAbsolute(o) ? o : resolve(o);
  return join(homedir(), 'Library', 'Application Support', 'Potts');
}

function writeReport(report: unknown, stamp: string): string {
  const dir = join(resolveHome(), 'bench');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  const file = join(dir, `local-model-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return file;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      yes: { type: 'boolean', default: false },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      model: { type: 'string', default: DEFAULT_MODEL },
      runs: { type: 'string', default: '3' },
      'timeout-ms': { type: 'string', default: '180000' },
      'no-write': { type: 'boolean', default: false },
      'unload-first': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) { console.log(USAGE); return 0; }

  const base = validateBaseUrl(values['base-url']);
  const model = validateModel(values.model);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) fail('--runs must be an integer 1..20');
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) fail('--timeout-ms must be an integer >= 1000');

  console.log(`WARNING: ${BANNER}`);
  if (values['unload-first']) {
    console.log('--unload-first: this benchmark never unloads models or changes LM Studio settings.');
    console.log(`For a cold measurement, unload it yourself first (e.g. \`lms unload ${model}\` or the LM Studio UI), or wait for the idle TTL, then re-run.`);
  }
  if (!values.yes) {
    console.log('Re-run with --yes to proceed.');
    return 2;
  }

  const startedAt = new Date();
  console.log(`\nBenchmarking ${model} at ${base.origin}  (runs=${runs}, timeout=${timeoutMs} ms)\n`);

  const before = await inspectModel(base, model, Math.min(timeoutMs, 10_000));
  console.log(`listed in /v1/models: ${before.listedInV1Models === null ? 'unknown' : before.listedInV1Models}`);
  console.log(`state before first request: ${before.state ?? 'not exposed'}`);
  if (before.loadConfig) console.log(`load config (/api/v0/models): ${JSON.stringify(before.loadConfig)}`);
  const firstIsCold = before.state === 'not-loaded';

  const first = await streamChat(base, model, timeoutMs);
  const warm: ChatResult[] = [];
  for (let i = 0; i < runs; i++) warm.push(await streamChat(base, model, timeoutMs));
  const tool = await toolWorkflow(base, model, timeoutMs);
  const after = await inspectModel(base, model, Math.min(timeoutMs, 10_000));

  const ctx = after.contextLength ?? before.contextLength;
  const ctxSource = after.contextLength !== null ? after.contextSource : before.contextSource;
  const ctxCheck = ctx === null ? 'not exposed' : ctx === EXPECTED_CONTEXT ? 'OK' : `MISMATCH (expected ${EXPECTED_CONTEXT})`;

  const firstLabel = firstIsCold ? 'cold simple reply' : before.state === 'loaded' ? 'first simple reply (model already loaded)' : 'first simple reply (load state unknown)';
  const warmMax = Math.max(...warm.map((w) => w.wallMs));
  const warmAllOk = warm.every((w) => w.ok);
  const rows: { name: string; wall: string; ttft: string; tokens: string; target: string; result: Verdict }[] = [];
  rows.push({ name: firstLabel, wall: s(first.wallMs), ttft: s(first.ttftMs), tokens: first.completionTokens === null ? '-' : String(first.completionTokens), target: '<= 30 s', result: verdict(first.ok, first.wallMs, SIMPLE_TARGET_MS) });
  warm.forEach((w, i) => rows.push({ name: `warm simple reply #${i + 1}`, wall: s(w.wallMs), ttft: s(w.ttftMs), tokens: w.completionTokens === null ? '-' : String(w.completionTokens), target: '<= 30 s', result: verdict(w.ok, w.wallMs, SIMPLE_TARGET_MS) }));
  rows.push({ name: `tool workflow (${tool.toolCallProduced ? '2 rounds' : 'no tool call'})`, wall: s(tool.totalMs), ttft: '-', tokens: '-', target: '<= 60 s', result: verdict(tool.ok && tool.toolCallProduced, tool.totalMs, TOOL_TARGET_MS) });

  const header = ['measurement', 'wall', 'ttft', 'tokens', 'target', 'result'];
  const table = rows.map((r) => [r.name, r.wall, r.ttft, r.tokens, r.target, r.result]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => (r[i] ?? '').length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log('\n' + fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of table) console.log(fmt(r));

  const simpleVerdict: Verdict = verdict(warmAllOk, warmMax, SIMPLE_TARGET_MS);
  const firstVerdict = verdict(first.ok, first.wallMs, SIMPLE_TARGET_MS);
  const toolVerdict = verdict(tool.ok && tool.toolCallProduced, tool.totalMs, TOOL_TARGET_MS);
  console.log('');
  console.log(`${firstVerdict} ${firstLabel}: ${s(first.wallMs)} (target <= 30 s)${first.error ? ` error: ${first.error}` : ''}`);
  console.log(`${simpleVerdict} warm simple reply (max of ${runs}): ${s(warmMax)} (target <= 30 s)`);
  console.log(`${toolVerdict} short tool workflow: ${s(tool.totalMs)}, tool call ${tool.toolCallProduced ? `produced (${tool.toolName ?? '?'})` : 'NOT produced'} (target <= 60 s)${tool.error ? ` error: ${tool.error}` : ''}`);
  console.log(`context length: ${ctx ?? '-'} [${ctxSource ?? 'n/a'}] -> ${ctxCheck}`);
  console.log(`state after run: ${after.state ?? 'not exposed'}`);

  const report = {
    kind: 'potts.bench.local-model',
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: base.origin,
    model,
    runs,
    timeoutMs,
    targets: { simpleReplyMs: SIMPLE_TARGET_MS, toolWorkflowMs: TOOL_TARGET_MS, contextLength: EXPECTED_CONTEXT },
    modelBefore: before,
    modelAfter: after,
    first: { cold: firstIsCold, ...first, verdict: firstVerdict },
    warm: warm.map((w) => ({ ...w })),
    warmVerdict: simpleVerdict,
    toolWorkflow: { ...tool, verdict: toolVerdict },
    context: { value: ctx, source: ctxSource, check: ctxCheck },
  };
  if (!values['no-write']) {
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    console.log(`report: ${writeReport(report, stamp)}`);
  }
  return firstVerdict === 'PASS' && simpleVerdict === 'PASS' && toolVerdict === 'PASS' ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
