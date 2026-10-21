/**
 * Minimal fake HTTP provider for connector tests (Google, Graph, LMS feed).
 * Binds 127.0.0.1 on a random port; records every request.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: string;
  form: URLSearchParams;
}

export interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type Handler = (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeServer {
  base: string;
  requests: RecordedRequest[];
  route(method: string, path: string | RegExp, h: Handler): void;
  close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const routes: { method: string; path: string | RegExp; h: Handler }[] = [];
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rec: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, url, headers: req.headers, body, form: new URLSearchParams(body) };
      requests.push(rec);
      // Later registrations win, so tests can override defaults.
      const r = [...routes].reverse().find((x) => x.method === rec.method && (typeof x.path === 'string' ? x.path === url.pathname : x.path.test(url.pathname)));
      if (!r) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 404, message: 'no route' } }));
        return;
      }
      try {
        const out = await r.h(rec);
        const headers: Record<string, string> = { ...(out.json !== undefined ? { 'content-type': 'application/json' } : {}), ...out.headers };
        res.writeHead(out.status ?? 200, headers).end(out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? ''));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    route(method, path, h) {
      routes.push({ method, path, h });
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
