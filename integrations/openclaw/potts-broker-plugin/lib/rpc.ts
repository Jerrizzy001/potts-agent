/**
 * Minimal JSON-lines RPC client for the broker's Unix sockets
 * (wire format of src/broker/server.ts). One connection per call keeps the
 * plugin stateless across gateway reloads; calls are infrequent.
 */
import { createConnection } from 'node:net';
import { ingressAuthResponse } from './ingress.ts';

export interface RpcError {
  code: string;
  message: string;
}
export type RpcResult<T = unknown> = { ok: true; result: T } | { ok: false; error: RpcError };

export interface RpcCallOptions {
  timeoutMs?: number;
  /** Ingress socket: answer the server's {challenge} with this key before calling. */
  ingressKey?: string | Uint8Array;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Opens the socket, (optionally) authenticates, performs the calls in order
 * and closes. Never throws: transport failures become {ok:false}.
 */
export function rpcCalls(socketPath: string, calls: { method: string; params?: Record<string, unknown> }[], opts: RpcCallOptions = {}): Promise<RpcResult[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    const results: RpcResult[] = [];
    let settled = false;
    let buf = '';
    let nextId = 1;
    let pending: { id: number; done: (r: RpcResult) => void } | null = null;
    const sock = createConnection(socketPath);
    const finish = (extra?: RpcError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (extra) while (results.length < calls.length) results.push({ ok: false, error: extra });
      resolve(results);
    };
    const timer = setTimeout(() => finish({ code: 'unavailable', message: 'broker socket timed out' }), timeoutMs);
    let greeted = opts.ingressKey === undefined;
    let challenge: ((c: unknown) => void) | null = null;

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<RpcResult>((done) => {
        const id = nextId++;
        pending = { id, done };
        sock.write(JSON.stringify({ id, method, params }) + '\n');
      });

    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_RESPONSE_BYTES) return finish({ code: 'invalid_input', message: 'response too large' });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: RpcError; challenge?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return finish({ code: 'invalid_input', message: 'malformed response' });
        }
        if (!greeted) {
          greeted = true;
          challenge?.(msg.challenge);
          continue;
        }
        if (pending && msg.id === pending.id) {
          const p = pending;
          pending = null;
          p.done(msg.ok === true ? { ok: true, result: msg.result } : { ok: false, error: msg.error ?? { code: 'internal', message: 'unknown error' } });
        }
      }
    });
    sock.on('error', (e: NodeJS.ErrnoException) => finish({ code: 'unavailable', message: `broker socket unavailable (${e.code ?? 'error'})` }));
    sock.on('close', () => finish({ code: 'unavailable', message: 'broker socket closed' }));
    sock.on('connect', async () => {
      if (opts.ingressKey !== undefined) {
        const c = await new Promise<unknown>((r) => (challenge = r));
        if (typeof c !== 'string' || !/^[0-9a-f]{64}$/.test(c)) return finish({ code: 'ingress_invalid', message: 'no ingress challenge' });
        const auth = await call('auth', { mac: ingressAuthResponse(opts.ingressKey, c) });
        if (!auth.ok) return finish(auth.error);
      }
      for (const c of calls) results.push(await call(c.method, c.params ?? {}));
      finish();
    });
  });
}

export async function rpcCall<T = unknown>(socketPath: string, method: string, params: Record<string, unknown> = {}, opts: RpcCallOptions = {}): Promise<RpcResult<T>> {
  const [r] = await rpcCalls(socketPath, [{ method, params }], opts);
  return (r ?? { ok: false, error: { code: 'unavailable', message: 'no response' } }) as RpcResult<T>;
}
