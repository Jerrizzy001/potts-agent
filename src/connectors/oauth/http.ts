import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from './errors.ts';

/**
 * Shared HTTP plumbing for WP-4 connectors. Uses global fetch (injectable for
 * tests). Readers only ever use `readerGet` / `readerGetJson`, which can only
 * issue GET requests: a reader module has no code path that writes.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

/** Parses Retry-After (delta seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, clock: Clock): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - clock.nowMs());
}

function tryJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** POST application/x-www-form-urlencoded (OAuth token/device/revoke endpoints only). */
export async function postForm(fetchFn: FetchLike, url: string, params: Record<string, string>): Promise<Result<HttpResult, ConnectorError>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
    });
  } catch (e) {
    return cerr('network', `request to ${new URL(url).host} failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  return ok({ status: res.status, headers: res.headers, body: tryJson(text), text });
}

export interface RetryOptions {
  clock: Clock;
  sleep: Sleep;
  /** Attempts after the first (default 5). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra rate-limit detection (e.g. Gmail 403 rateLimitExceeded). */
  isRateLimited?: (status: number, body: unknown) => boolean;
}

export interface ReaderGetOptions extends RetryOptions {
  fetch: FetchLike;
  headers?: Record<string, string>;
  /** Follow redirects (default) or return 3xx to the caller ('manual'). */
  redirect?: 'follow' | 'manual';
}

/**
 * GET with retry/backoff for 429, 5xx (except 501) and provider-specific
 * rate-limit signals; honours Retry-After. Returns the final response for any
 * other status so the caller can interpret 401/404/410 etc. Returns
 * `rate_limited` if throttling persists after maxRetries.
 */
export async function readerGet(url: string, o: ReaderGetOptions): Promise<Result<HttpResult, ConnectorError>> {
  const maxRetries = o.maxRetries ?? 5;
  const base = o.baseDelayMs ?? 1000;
  const maxDelay = o.maxDelayMs ?? 64_000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await o.fetch(url, { method: 'GET', headers: { accept: 'application/json', ...o.headers }, redirect: o.redirect ?? 'follow' });
    } catch (e) {
      if (attempt >= maxRetries) return cerr('network', `GET ${safeHost(url)} failed: ${(e as Error).message}`);
      await o.sleep(Math.min(maxDelay, base * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    const body = tryJson(text);
    const throttled = res.status === 429 || (o.isRateLimited?.(res.status, body) ?? false);
    const transient = res.status >= 500 && res.status !== 501;
    if (throttled || transient) {
      const ra = parseRetryAfter(res.headers.get('retry-after'), o.clock);
      if (attempt >= maxRetries) {
        if (throttled) return cerr('rate_limited', `provider throttled after ${attempt + 1} attempts`, { status: res.status, ...(ra !== undefined ? { retryAfterMs: ra } : {}) });
        return cerr('http_error', `provider error ${res.status} after ${attempt + 1} attempts`, { status: res.status });
      }
      const backoff = Math.min(maxDelay, base * 2 ** attempt);
      await o.sleep(ra !== undefined ? Math.min(Math.max(ra, 0), 15 * 60_000) : backoff);
      continue;
    }
    return ok({ status: res.status, headers: res.headers, body, text });
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}
