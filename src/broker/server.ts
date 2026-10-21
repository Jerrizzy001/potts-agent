import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { ensurePrivateDir } from '../store/home.ts';
import { hexEqual, hmacSha256Hex } from '../core/hash.ts';
import { PottsError, type Result } from '../core/result.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import type { ActionStatus, Broker } from './broker.ts';
import type { OwnerControls } from './owner.ts';

/**
 * Local JSON-lines RPC over Unix domain sockets.
 *
 * Wire format: one JSON object per line.
 *   request  {"id": <string|number>, "method": "<name>", "params": {...}}
 *   response {"id": ..., "ok": true, "result": ...} | {"id": ..., "ok": false, "error": {"code", "message"}}
 *
 * Two separate servers:
 *  - Broker socket (OpenClaw plugin, WP-2): propose / status / list ONLY.
 *    There is no approve, pause or owner method on this socket at all.
 *  - Ingress socket (trusted ingress only): challenge-response HMAC auth with
 *    the ingress key on connect, then owner_intent (each carrying its own
 *    signed, single-use OwnerIngressProof) and owner read views.
 */
export const SOCKET_LIMITS = {
  /** Max bytes in a single request line. */
  maxLineBytes: 512 * 1024,
  /** Max concurrent connections per server. */
  maxConnections: 16,
  /** Connection closed after this long without a request. */
  idleTimeoutMs: 30_000,
  /** Max requests served on one connection. */
  maxRequestsPerConnection: 1000,
  /** macOS sun_path limit is 104 bytes. */
  maxSocketPathBytes: 103,
} as const;

type Handler = (params: Record<string, unknown>, conn: ConnState) => unknown | Promise<unknown>;
interface ConnState {
  authenticated: boolean;
  challenge: string;
}

export interface RunningServer {
  readonly path: string;
  close(): Promise<void>;
}

function prepareSocketPath(path: string): void {
  if (Buffer.byteLength(path) > SOCKET_LIMITS.maxSocketPathBytes) throw new Error(`socket path too long (${path})`);
  ensurePrivateDir(dirname(path));
  try {
    const st = lstatSync(path);
    if (!st.isSocket()) throw new Error(`refusing to replace non-socket file at ${path}`);
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function serve(path: string, methods: Record<string, Handler>, opts: { log: Logger; onConnect?: (s: Socket, c: ConnState) => void; requireAuth?: (method: string, c: ConnState) => boolean }): Promise<RunningServer> {
  prepareSocketPath(path);
  const server: Server = createServer({ allowHalfOpen: false });
  server.maxConnections = SOCKET_LIMITS.maxConnections;
  server.on('connection', (sock) => {
    const conn: ConnState = { authenticated: false, challenge: randomBytes(32).toString('hex') };
    let buf = '';
    let served = 0;
    let chain = Promise.resolve();
    sock.setEncoding('utf8');
    sock.setTimeout(SOCKET_LIMITS.idleTimeoutMs, () => sock.destroy());
    const send = (obj: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n');
    };
    opts.onConnect?.(sock, conn);
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > SOCKET_LIMITS.maxLineBytes && !buf.includes('\n')) {
        send({ id: null, ok: false, error: { code: 'invalid_input', message: 'request too large' } });
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (++served > SOCKET_LIMITS.maxRequestsPerConnection) {
          sock.destroy();
          return;
        }
        chain = chain.then(async () => {
          let req: { id?: unknown; method?: unknown; params?: unknown };
          try {
            req = JSON.parse(line) as typeof req;
          } catch {
            send({ id: null, ok: false, error: { code: 'invalid_input', message: 'invalid JSON' } });
            return;
          }
          const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
          const m = typeof req.method === 'string' && Object.prototype.hasOwnProperty.call(methods, req.method) ? methods[req.method] : undefined;
          if (!m) return send({ id, ok: false, error: { code: 'invalid_input', message: 'unknown method' } });
          if (opts.requireAuth && !opts.requireAuth(req.method as string, conn)) return send({ id, ok: false, error: { code: 'ingress_invalid', message: 'not authenticated' } });
          const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};
          try {
            const out = await m(params, conn);
            const r = out as Result<unknown> | undefined;
            if (r && typeof r === 'object' && 'ok' in r && typeof r.ok === 'boolean') {
              send(r.ok ? { id, ok: true, result: r.value } : { id, ok: false, error: { code: r.error.code, message: r.error.message } });
            } else send({ id, ok: true, result: out });
          } catch (e) {
            opts.log.error('rpc handler failed', { method: req.method, error: (e as Error).message });
            send({ id, ok: false, error: { code: e instanceof PottsError ? e.code : 'internal', message: e instanceof PottsError ? e.message : 'internal error' } });
          }
        });
      }
    });
    sock.on('error', () => sock.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve({
        path,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              try {
                unlinkSync(path);
              } catch {
                /* already gone */
              }
              res();
            });
          }),
      });
    });
  });
}

/**
 * Proposer socket for the OpenClaw plugin. `actor` is stamped by the server
 * (e.g. "openclaw"); a client-supplied agent label is appended for traceability
 * but grants nothing.
 */
export function startBrokerServer(o: { broker: Broker; socketPath: string; actor: string; logger?: Logger; releaseRequests?: { request(p: Record<string, unknown>): unknown; status(p: Record<string, unknown>): unknown } }): Promise<RunningServer> {
  const label = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? `/${v}` : '');
  const statuses: ActionStatus[] = ['held', 'denied', 'awaiting_approval', 'ready', 'dispatching', 'succeeded', 'failed', 'uncertain', 'cancelled'];
  return serve(
    o.socketPath,
    {
      'release.request': (p) => o.releaseRequests?.request(p) ?? { ok: false, error: new PottsError('held', 'Release preparation not configured') },
      'release.status': (p) => o.releaseRequests?.status(p) ?? { ok: false, error: new PottsError('held', 'Release preparation not configured') },
      propose: (p) => o.broker.propose(p.action, `${o.actor}${label(p.agent)}`),
      status: (p) => {
        const s = typeof p.actionId === 'string' ? o.broker.status(p.actionId) : undefined;
        return s ? { ok: true, value: s } : { ok: false, error: new PottsError('not_found', 'action not found') };
      },
      list: (p) =>
        o.broker.list({
          ...(typeof p.status === 'string' && (statuses as string[]).includes(p.status) ? { status: p.status as ActionStatus } : {}),
          ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
        }),
    },
    { log: o.logger ?? nullLogger },
  );
}

/**
 * Generic unauthenticated JSON-lines RPC server with the same limits and file
 * modes as the broker sockets. Used by the daemon (WP-8) for the read-only
 * socket and the memory-control socket, whose methods verify their own
 * per-request owner proofs. Never put a state-changing method here that does
 * not verify an owner proof itself.
 */
export function startRpcServer(o: { socketPath: string; methods: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>; logger?: Logger }): Promise<RunningServer> {
  const methods: Record<string, Handler> = {};
  for (const [k, fn] of Object.entries(o.methods)) methods[k] = (p) => fn(p);
  return serve(o.socketPath, methods, { log: o.logger ?? nullLogger });
}

/** Response to the ingress socket challenge: HMAC(key, "potts-ingress-auth:v1:" + challenge). */
export function ingressAuthResponse(key: string | Uint8Array, challenge: string): string {
  return hmacSha256Hex(key, `potts-ingress-auth:v1:${challenge}`);
}

/**
 * Trusted-ingress socket. On connect the server sends {"challenge": hex};
 * the client must call auth {mac} first. Then: owner_intent {proof},
 * list_pending, preview {approvalId}, recent {limit}, controls.
 */
export function startIngressServer(o: { owner: OwnerControls; socketPath: string; key: string | Uint8Array; logger?: Logger }): Promise<RunningServer> {
  return serve(
    o.socketPath,
    {
      auth: (p, c) => {
        if (typeof p.mac === 'string' && hexEqual(p.mac, ingressAuthResponse(o.key, c.challenge))) {
          c.authenticated = true;
          return { authenticated: true };
        }
        return { ok: false, error: new PottsError('ingress_invalid', 'authentication failed') };
      },
      owner_intent: (p) => o.owner.handle(p.proof),
      list_pending: () => o.owner.listPendingApprovals(),
      preview: (p) => (typeof p.approvalId === 'string' ? (o.owner.preview(p.approvalId) ?? null) : null),
      recent: (p) => o.owner.recentActions(typeof p.limit === 'number' ? Math.min(Math.max(p.limit, 1), 200) : 20),
      controls: () => o.owner.controls(),
    },
    {
      log: o.logger ?? nullLogger,
      onConnect: (s, c) => s.write(JSON.stringify({ challenge: c.challenge }) + '\n'),
      requireAuth: (method, c) => method === 'auth' || c.authenticated,
    },
  );
}

/** Minimal client: one connection, sequential calls. Used by tests and WP-2. */
export interface SocketClient {
  /** First line pushed by the server on connect (ingress challenge), if any. */
  readonly greeting: Promise<unknown>;
  call(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
  close(): void;
}

export function connectSocket(path: string, opts: { expectGreeting?: boolean } = {}): Promise<SocketClient> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    let nextId = 1;
    const waiting = new Map<number, (v: never) => void>();
    let greetResolve: (v: unknown) => void = () => {};
    const greeting = new Promise<unknown>((r) => (greetResolve = r));
    let greeted = !opts.expectGreeting;
    if (greeted) greetResolve(null);
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: number };
        buf = buf.slice(nl + 1);
        if (!greeted) {
          greeted = true;
          greetResolve(msg);
          continue;
        }
        const w = typeof msg.id === 'number' ? waiting.get(msg.id) : undefined;
        if (w) {
          waiting.delete(msg.id!);
          w(msg as never);
        }
      }
    });
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        greeting,
        call: (method, params = {}) =>
          new Promise((res) => {
            const id = nextId++;
            waiting.set(id, res as (v: never) => void);
            sock.write(JSON.stringify({ id, method, params }) + '\n');
          }),
        close: () => sock.end(),
      }),
    );
  });
}
