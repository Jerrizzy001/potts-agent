import { err, ok, perr, PottsError, type Result } from '../core/index.ts';

/**
 * Embeddings are optional and local-only. The default provider is disabled;
 * the LM Studio adapter is off unless the owner enables it in config, and it
 * refuses any URL that is not a loopback IP literal. There is no cloud
 * fallback anywhere in this module: if the local server is down, embedding
 * fails and search stays on SQLite FTS5.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly enabled: boolean;
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export const disabledEmbeddings: EmbeddingProvider = Object.freeze({
  name: 'disabled',
  enabled: false,
  model: 'none',
  async embed(): Promise<Float32Array[]> {
    throw new PottsError('invalid_input', 'embeddings are disabled');
  },
});

export const LMSTUDIO_DEFAULT_URL = 'http://127.0.0.1:1234/v1/embeddings';

/**
 * Accepts only http(s) URLs whose host is an IPv4 loopback literal
 * (127.0.0.0/8) or [::1]. "localhost" is rejected on purpose: name resolution
 * can be redirected (hosts file, resolver), an IP literal cannot.
 */
export function assertLoopbackUrl(raw: string): Result<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return perr('invalid_input', 'embeddings url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return perr('invalid_input', `embeddings url must be http(s), got ${u.protocol}`);
  if (u.username || u.password) return perr('invalid_input', 'embeddings url must not carry credentials');
  const host = u.hostname;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const isV4Loopback = v4 !== null && v4.slice(1).every((o) => Number(o) <= 255);
  const isV6Loopback = host === '[::1]';
  if (!isV4Loopback && !isV6Loopback) {
    return perr('invalid_input', `embeddings url must be a loopback IP literal (127.0.0.1 or [::1]); refusing host "${host}"`);
  }
  return ok(u);
}

export interface LmStudioOptions {
  url?: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBatch?: number;
}

export function createLmStudioEmbeddings(opts: LmStudioOptions): Result<EmbeddingProvider> {
  const checked = assertLoopbackUrl(opts.url ?? LMSTUDIO_DEFAULT_URL);
  if (!checked.ok) return checked;
  if (!opts.model || !/^[\w./:@-]{1,200}$/.test(opts.model)) return perr('invalid_input', 'embeddings model id is required');
  const url = checked.value.toString();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBatch = opts.maxBatch ?? 32;
  const provider: EmbeddingProvider = {
    name: 'lmstudio',
    enabled: true,
    model: opts.model,
    async embed(texts, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += maxBatch) {
        const batch = texts.slice(i, i + maxBatch);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: opts.model, input: batch }),
            redirect: 'error',
            signal: ctrl.signal,
          });
          if (!res.ok) throw new PottsError('internal', `local embeddings server returned HTTP ${res.status}`);
          const body = (await res.json()) as { data?: { index?: number; embedding?: unknown }[] };
          const data = Array.isArray(body.data) ? [...body.data] : [];
          if (data.length !== batch.length) throw new PottsError('internal', 'local embeddings response size mismatch');
          data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          for (const d of data) {
            if (!Array.isArray(d.embedding) || d.embedding.length === 0 || !d.embedding.every((x) => typeof x === 'number' && Number.isFinite(x))) {
              throw new PottsError('internal', 'local embeddings response is malformed');
            }
            out.push(Float32Array.from(d.embedding as number[]));
          }
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      }
      return out;
    },
  };
  return ok(provider);
}

/** Builds the provider described by the `memory.embeddings` config section. Default: disabled. */
export function embeddingsFromConfig(cfg: { provider: 'disabled' | 'lmstudio'; url?: string; model?: string } | undefined, fetchImpl?: typeof fetch): Result<EmbeddingProvider> {
  if (!cfg || cfg.provider === 'disabled') return ok(disabledEmbeddings);
  if (cfg.provider !== 'lmstudio') return err(new PottsError('config_invalid', `unknown embeddings provider ${String((cfg as { provider: unknown }).provider)}`));
  const o: LmStudioOptions = { model: cfg.model ?? '' };
  if (cfg.url !== undefined) o.url = cfg.url;
  if (fetchImpl) o.fetchImpl = fetchImpl;
  return createLmStudioEmbeddings(o);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToVector(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
