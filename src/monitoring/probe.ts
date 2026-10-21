import type { Clock } from '../core/clock.ts';
import { resolveSecretRef, type SecretResolverOptions } from '../core/secrets.ts';
import type { Result } from '../core/result.ts';
import type { JourneyCheck, SiteConfig } from './config.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FailureCause =
  | 'http_5xx'
  | 'http_4xx'
  | 'http_unexpected'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'bad_health'
  | 'content_mismatch'
  | 'slow'
  | 'readiness_degraded'
  | 'readiness_down'
  | 'probe_error';

export interface CheckResult {
  check: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  cause: FailureCause | null;
  retryAfterMs?: number;
}

export const TRANSPORT_CAUSES: ReadonlySet<FailureCause> = new Set(['timeout', 'dns', 'tls', 'network']);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

/** Maps a fetch() rejection to a failure cause (undici puts the system error in `cause`). */
export function classifyFetchError(e: unknown): FailureCause {
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; name?: string; message?: string } };
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError') return 'timeout';
  const code = err?.cause?.code ?? err?.code ?? '';
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (DNS_CODES.has(code) || /getaddrinfo/i.test(msg)) return 'dns';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (/CERT|TLS|SSL/i.test(code) || /certificate|tls|ssl/i.test(msg)) return 'tls';
  return 'network';
}

export function parseRetryAfterMs(h: string | null, nowMs: number): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 3600) * 1000;
  const t = Date.parse(h);
  if (!Number.isNaN(t)) return Math.max(0, Math.min(t - nowMs, 3600_000));
  return undefined;
}

/** Reads at most `max` bytes of a body as text, then cancels the stream. */
export async function readCapped(res: Response, max = 16 * 1024): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, max);
  return buf.toString('utf8');
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

interface GetOptions {
  fetch: FetchLike;
  clock: Clock;
  timeoutMs: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function timedGet(url: string, o: GetOptions): Promise<{ res: Response; latencyMs: number } | { error: FailureCause; latencyMs: number }> {
  const start = o.clock.nowMs();
  const signals = [AbortSignal.timeout(o.timeoutMs)];
  if (o.signal) signals.push(o.signal);
  try {
    const res = await o.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'potts-monitor/1 (+owner local monitor)', accept: '*/*', ...(o.headers ?? {}) },
      signal: AbortSignal.any(signals),
      cache: 'no-store',
    });
    return { res, latencyMs: o.clock.nowMs() - start };
  } catch (e) {
    return { error: classifyFetchError(e), latencyMs: o.clock.nowMs() - start };
  }
}

function statusCause(status: number): FailureCause {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'http_unexpected';
}

export interface ProbeDeps {
  fetch: FetchLike;
  clock: Clock;
  signal?: AbortSignal;
}

export async function checkHomepage(site: SiteConfig, d: ProbeDeps): Promise<CheckResult> {
  const r = await timedGet(site.baseUrl + site.homepagePath, { ...d, timeoutMs: site.timeoutMs });
  if ('error' in r) return { check: 'homepage', ok: false, statusCode: null, latencyMs: r.latencyMs, cause: r.error };
  await discard(r.res);
  const s = r.res.status;
  const ok = s >= 200 && s < 400;
  const out: CheckResult = { check: 'homepage', ok, statusCode: s, latencyMs: r.latencyMs, cause: ok ? null : statusCause(s) };
  if (s === 429) out.retryAfterMs = parseRetryAfterMs(r.res.headers.get('retry-after'), d.clock.nowMs());
  return out;
}

/** `/api/health` liveness: HTTP 200 with JSON `{ ok: true }`. Body is parsed, never stored. */
export async function checkHealth(site: SiteConfig, d: ProbeDeps): Promise<CheckResult> {
  const r = await timedGet(site.baseUrl + site.healthPath, { ...d, timeoutMs: site.timeoutMs, headers: { accept: 'application/json' } });
  if ('error' in r) return { check: 'health', ok: false, statusCode: null, latencyMs: r.latencyMs, cause: r.error };
  const s = r.res.status;
  if (s !== 200) {
    await discard(r.res);
    const out: CheckResult = { check: 'health', ok: false, statusCode: s, latencyMs: r.latencyMs, cause: statusCause(s) };
    if (s === 429) out.retryAfterMs = parseRetryAfterMs(r.res.headers.get('retry-after'), d.clock.nowMs());
    return out;
  }
  let healthy = false;
  try {
    const body = JSON.parse(await readCapped(r.res, 8 * 1024)) as { ok?: unknown };
    healthy = body?.ok === true;
  } catch {
    healthy = false;
  }
  return { check: 'health', ok: healthy, statusCode: s, latencyMs: r.latencyMs, cause: healthy ? null : 'bad_health' };
}

/** GET-only critical read journey. Never sends a body, cookies or credentials. */
export async function checkJourney(site: SiteConfig, j: JourneyCheck, d: ProbeDeps): Promise<CheckResult> {
  const name = `journey:${j.name}`;
  const r = await timedGet(site.baseUrl + j.path, { ...d, timeoutMs: site.timeoutMs });
  if ('error' in r) return { check: name, ok: false, statusCode: null, latencyMs: r.latencyMs, cause: r.error };
  const s = r.res.status;
  const expect = j.expectStatus ?? [200];
  if (!expect.includes(s)) {
    await discard(r.res);
    return { check: name, ok: false, statusCode: s, latencyMs: r.latencyMs, cause: statusCause(s) };
  }
  if (j.mustContain) {
    const body = await readCapped(r.res, 512 * 1024);
    if (!body.includes(j.mustContain)) return { check: name, ok: false, statusCode: s, latencyMs: r.latencyMs, cause: 'content_mismatch' };
  } else {
    await discard(r.res);
  }
  if (j.maxLatencyMs !== undefined && r.latencyMs > j.maxLatencyMs) return { check: name, ok: false, statusCode: s, latencyMs: r.latencyMs, cause: 'slow' };
  return { check: name, ok: true, statusCode: s, latencyMs: r.latencyMs, cause: null };
}

// ---------------------------------------------------------------------------
// Connectivity (Mac offline vs site down)

export interface ConnectivityChecker {
  /** 'online' if ANY independent endpoint answered with any HTTP status. */
  check(signal?: AbortSignal): Promise<{ state: 'online' | 'offline'; results: CheckResult[] }>;
}

export function createConnectivityChecker(o: { fetch: FetchLike; clock: Clock; endpoints: string[]; timeoutMs?: number }): ConnectivityChecker {
  return {
    async check(signal) {
      const results = await Promise.all(
        o.endpoints.map(async (url, i): Promise<CheckResult> => {
          const r = await timedGet(url, { fetch: o.fetch, clock: o.clock, timeoutMs: o.timeoutMs ?? 5000, ...(signal ? { signal } : {}) });
          if ('error' in r) return { check: `connectivity:${i}`, ok: false, statusCode: null, latencyMs: r.latencyMs, cause: r.error };
          await discard(r.res);
          return { check: `connectivity:${i}`, ok: true, statusCode: r.res.status, latencyMs: r.latencyMs, cause: null };
        }),
      );
      return { state: results.some((r) => r.ok) ? 'online' : 'offline', results };
    },
  };
}

// ---------------------------------------------------------------------------
// Authorized readiness

export type SubsystemStatus = 'ok' | 'degraded' | 'down';

export interface ReadinessResult {
  status: 'ok' | 'degraded' | 'down' | 'auth_failed' | 'rate_limited' | 'error';
  statusCode: number | null;
  latencyMs: number;
  /** Coarse per-subsystem summary only; never the full admin readiness payload. */
  subsystems?: Record<string, SubsystemStatus>;
  cause?: FailureCause;
  retryAfterMs?: number;
}

/** Injected readiness probe. Implementations must never log or return response bodies. */
export interface ReadinessProbe {
  probe(site: SiteConfig, signal?: AbortSignal): Promise<ReadinessResult>;
}

const SUBSYSTEM_RE = /^[a-z][a-z0-9_]{0,40}$/;
const STATUS_SET = new Set(['ok', 'degraded', 'down']);

/** Extracts only the coarse summary from a monitor response; everything else is discarded. */
export function summarizeReadinessBody(text: string): { status: SubsystemStatus | null; subsystems: Record<string, SubsystemStatus> } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: null, subsystems: {} };
  }
  const b = body as { status?: unknown; subsystems?: unknown };
  const status = typeof b?.status === 'string' && STATUS_SET.has(b.status) ? (b.status as SubsystemStatus) : null;
  const subsystems: Record<string, SubsystemStatus> = {};
  if (b?.subsystems && typeof b.subsystems === 'object' && !Array.isArray(b.subsystems)) {
    for (const [k, v] of Object.entries(b.subsystems as Record<string, unknown>).slice(0, 20)) {
      if (SUBSYSTEM_RE.test(k) && typeof v === 'string' && STATUS_SET.has(v)) subsystems[k] = v as SubsystemStatus;
    }
  }
  return { status, subsystems };
}

export interface TokenReadinessProbeOptions {
  fetch: FetchLike;
  clock: Clock;
  /** Resolves the site's readiness.tokenRef. Default: core resolveSecretRef. */
  resolveSecret?: (ref: string) => Promise<Result<string>>;
  secretOptions?: SecretResolverOptions;
}

/**
 * Calls the token-protected monitor endpoint (proposal: GET /api/monitor with
 * `Authorization: Bearer <token>`). 401/403 → auth_failed (monitor credential
 * stale — NOT an outage). The token is read per probe and never logged.
 */
export function createTokenReadinessProbe(o: TokenReadinessProbeOptions): ReadinessProbe {
  const resolve = o.resolveSecret ?? ((ref: string) => resolveSecretRef(ref, o.secretOptions ?? {}));
  return {
    async probe(site, signal) {
      if (!site.readiness) return { status: 'error', statusCode: null, latencyMs: 0, cause: 'probe_error' };
      const tok = await resolve(site.readiness.tokenRef);
      if (!tok.ok) return { status: 'auth_failed', statusCode: null, latencyMs: 0, cause: 'auth' };
      const r = await timedGet(site.baseUrl + site.readiness.path, {
        fetch: o.fetch,
        clock: o.clock,
        timeoutMs: site.timeoutMs,
        headers: { authorization: `Bearer ${tok.value}`, accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
      if ('error' in r) return { status: 'error', statusCode: null, latencyMs: r.latencyMs, cause: r.error };
      const s = r.res.status;
      if (s === 401 || s === 403) {
        await discard(r.res);
        return { status: 'auth_failed', statusCode: s, latencyMs: r.latencyMs, cause: 'auth' };
      }
      if (s === 429) {
        await discard(r.res);
        const ra = parseRetryAfterMs(r.res.headers.get('retry-after'), o.clock.nowMs());
        return { status: 'rate_limited', statusCode: s, latencyMs: r.latencyMs, cause: 'rate_limited', ...(ra !== undefined ? { retryAfterMs: ra } : {}) };
      }
      if (s !== 200 && s !== 503) {
        await discard(r.res);
        return { status: 'error', statusCode: s, latencyMs: r.latencyMs, cause: statusCause(s) };
      }
      const sum = summarizeReadinessBody(await readCapped(r.res, 8 * 1024));
      const status: ReadinessResult['status'] = sum.status ?? (s === 200 ? 'error' : 'degraded');
      const out: ReadinessResult = { status, statusCode: s, latencyMs: r.latencyMs, subsystems: sum.subsystems };
      if (status === 'degraded') out.cause = 'readiness_degraded';
      else if (status === 'down') out.cause = 'readiness_down';
      else if (status === 'error') out.cause = 'probe_error';
      return out;
    },
  };
}
