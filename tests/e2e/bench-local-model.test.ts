import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'bench', 'local-model.ts');
const MODEL = 'qwen/qwen3.5-9b';

interface RunResult { code: number; out: string; err: string }

/** Async spawn: the fake server lives in this process, so the event loop must stay free. */
function runBench(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((done) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      done({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let b = '';
    req.on('data', (c: Buffer) => { b += c.toString('utf8'); });
    req.on('end', () => ok(b));
  });
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('scripts/bench/local-model.ts', () => {
  let server: Server;
  let port = 0;
  let loaded = false;
  const seen: { path: string; body: Record<string, unknown> | null }[] = [];

  before(async () => {
    server = createServer(async (req, res) => {
      const raw = req.method === 'POST' ? await readBody(req) : '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      seen.push({ path: req.url ?? '', body });
      if (req.url === '/v1/models') return json(res, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
      if (req.url === '/api/v0/models') {
        return json(res, { object: 'list', data: [{ id: MODEL, type: 'llm', arch: 'qwen3', quantization: '4bit', state: loaded ? 'loaded' : 'not-loaded', max_context_length: 262144, loaded_context_length: loaded ? 32768 : undefined }] });
      }
      if (req.url === '/v1/chat/completions' && body) {
        loaded = true;
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '2+2 ' } }] });
          chunk({ choices: [{ index: 0, delta: { content: 'is 4.' } }] });
          chunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } });
          res.end('data: [DONE]\n\n');
          return;
        }
        const messages = Array.isArray(body.messages) ? body.messages as { role: string }[] : [];
        const hasToolResult = messages.some((m) => m.role === 'tool');
        if (Array.isArray(body.tools) && !hasToolResult) {
          return json(res, { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"timezone":"America/Toronto"}' } }] } }] });
        }
        return json(res, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'It is 09:30 in Toronto.' } }], usage: { prompt_tokens: 60, completion_tokens: 8 } });
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((ok) => server.close(() => ok())));

  test('runs against a fake LM Studio and prints PASS lines', async () => {
    const r = await runBench(['--yes', '--base-url', `http://127.0.0.1:${port}`, '--no-write', '--runs', '1']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /This will load the local model if it is not loaded/);
    assert.match(r.out, /^PASS cold simple reply/m);
    assert.match(r.out, /^PASS warm simple reply/m);
    assert.match(r.out, /^PASS short tool workflow: .*tool call produced \(get_time\)/m);
    assert.match(r.out, /context length: 32768 .*-> OK/);
    assert.doesNotMatch(r.out, /^report:/m);
    const chats = seen.filter((s) => s.path === '/v1/chat/completions');
    assert.equal(chats.length, 4, 'first + 1 warm + 2 tool rounds');
    assert.ok(chats.every((c) => c.body?.model === MODEL));
    assert.ok(chats.some((c) => (c.body?.messages as { role: string }[]).some((m) => m.role === 'tool')), 'tool result sent back');
  });

  test('writes a 0600 report under POTTS_HOME/bench (0700)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'potts-bench-'));
    try {
      const r = await runBench(['--yes', '--base-url', `http://127.0.0.1:${port}`, '--runs', '1'], { POTTS_HOME: home });
      assert.equal(r.code, 0, r.out + r.err);
      const dir = join(home, 'bench');
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      const files = readdirSync(dir);
      assert.equal(files.length, 1);
      assert.match(files[0] ?? '', /^local-model-.*\.json$/);
      assert.equal(statSync(join(dir, files[0] ?? '')).mode & 0o777, 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('requires --yes', async () => {
    const before = seen.length;
    const r = await runBench(['--base-url', `http://127.0.0.1:${port}`, '--no-write']);
    assert.equal(r.code, 2);
    assert.match(r.out, /Re-run with --yes/);
    assert.equal(seen.length, before, 'no requests without --yes');
  });

  test('refuses 27B models', async () => {
    const before = seen.length;
    for (const m of ['qwen/qwen3.5-27b', 'Qwen3.5-27B-MLX']) {
      const r = await runBench(['--yes', '--model', m, '--base-url', `http://127.0.0.1:${port}`, '--no-write']);
      assert.equal(r.code, 2);
      assert.match(r.err, /REFUSED/);
    }
    assert.equal(seen.length, before);
  });

  test('refuses non-loopback base URLs', async () => {
    for (const u of ['http://192.168.1.10:1234', 'http://localhost:1234', 'https://example.com', 'http://user:pw@127.0.0.1:1234']) {
      const r = await runBench(['--yes', '--base-url', u, '--no-write']);
      assert.equal(r.code, 2, u);
      assert.match(r.err, /REFUSED/);
    }
  });
});
