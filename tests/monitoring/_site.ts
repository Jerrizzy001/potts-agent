import { createFakeOwnerChannel } from '../../src/notifications/channel.ts';
import { createOutbox } from '../../src/notifications/outbox.ts';
import { DEFAULT_QUIET_HOURS } from '../../src/notifications/quiet-hours.ts';
import { createUrgentEventStore } from '../../src/notifications/urgent.ts';
import { bindUrgentEventsToOutbox } from '../../src/notifications/bind.ts';
import { normalizeMonitoringConfig, type SiteConfig } from '../../src/monitoring/config.ts';
import { createSiteMonitor } from '../../src/monitoring/monitor.ts';
import { createTokenReadinessProbe } from '../../src/monitoring/probe.ts';
import { ok, perr } from '../../src/core/result.ts';
import { makeEnv } from '../jobs/_helpers.ts';
import { createLogger } from '../../src/core/log.ts';

export type Behaviour = number | 'dns' | 'timeout' | 'tls' | 'refused' | { status: number; body?: string; headers?: Record<string, string> };

export interface SiteState {
  internet: boolean;
  home: Behaviour;
  health: Behaviour;
  readiness: Behaviour;
  journey: Behaviour;
  tokenAvailable: boolean;
}

const sysErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code, message: code } });

export const TOKEN = 'monitor-test-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export function siteFetch(st: SiteState, calls: { url: string; auth: string | null; method: string }[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get('authorization'), method: init?.method ?? 'GET' });
    if (!st.internet) throw sysErr(url.includes('1.1.1.1') ? 'ENETUNREACH' : 'ENOTFOUND');
    if (url.startsWith('https://1.1.1.1/') || url.startsWith('https://www.apple.com/')) return new Response('ok', { status: 200 });
    const path = new URL(url).pathname;
    let b: Behaviour;
    if (path === '/') b = st.home;
    else if (path === '/api/health') b = st.health;
    else if (path === '/api/monitor') {
      if (h.get('authorization') !== `Bearer ${TOKEN}`) b = 401;
      else b = st.readiness;
    } else if (path === '/jobs') b = st.journey;
    else b = 404;
    if (b === 'dns') throw sysErr('ENOTFOUND');
    if (b === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (b === 'tls') throw sysErr('CERT_HAS_EXPIRED');
    if (b === 'refused') throw sysErr('ECONNREFUSED');
    const spec = typeof b === 'number' ? { status: b } : b;
    let body = spec.body;
    if (body === undefined) {
      if (path === '/api/health') body = spec.status === 200 ? JSON.stringify({ ok: true, kind: 'liveness' }) : 'error';
      else if (path === '/api/monitor') body = JSON.stringify({ status: spec.status === 200 ? 'ok' : 'degraded', subsystems: { database: spec.status === 200 ? 'ok' : 'down' } });
      else body = '<html>Example App</html>';
    }
    return new Response(body, { status: spec.status, headers: spec.headers ?? {} });
  };
}

export function healthyState(): SiteState {
  return { internet: true, home: 200, health: 200, readiness: 200, journey: 200, tokenAvailable: true };
}

export function setupMonitor(start: string, opts: { readiness?: boolean; journeys?: boolean; site?: Partial<SiteConfig>; logSink?: string[] } = {}) {
  const env = makeEnv(start);
  const st = healthyState();
  const calls: { url: string; auth: string | null; method: string }[] = [];
  const fetch = siteFetch(st, calls);
  const channel = createFakeOwnerChannel(() => env.clock.nowMs());
  const outbox = createOutbox({ db: env.db, clock: env.clock, quiet: DEFAULT_QUIET_HOURS, channel, random: () => 0 });
  const urgent = createUrgentEventStore(env.db, env.clock);
  bindUrgentEventsToOutbox(urgent, outbox);
  const config = normalizeMonitoringConfig({
    sites: [
      {
        id: 'exampleapp',
        name: 'Example App',
        baseUrl: 'https://example.com',
        ...(opts.readiness ? { readiness: { path: '/api/monitor', tokenRef: 'env:POTTS_TEST_MONITOR_TOKEN' } } : {}),
        ...(opts.journeys ? { journeys: [{ name: 'jobs-list', path: '/jobs', mustContain: 'Example App' }] } : {}),
        ...(opts.site ?? {}),
      },
    ],
  });
  const readiness = createTokenReadinessProbe({
    fetch,
    clock: env.clock,
    resolveSecret: async (ref) => (st.tokenAvailable && ref === 'env:POTTS_TEST_MONITOR_TOKEN' ? ok(TOKEN) : perr('secret_unresolved', 'missing')),
  });
  const sink = opts.logSink;
  const logger = sink ? createLogger({ clock: env.clock, level: 'debug', sink: (l) => sink.push(l) }) : undefined;
  const monitor = createSiteMonitor({ db: env.db, clock: env.clock, config, fetch, urgent, outbox, readiness, ...(logger ? { logger } : {}) });
  return { env, st, calls, fetch, channel, outbox, urgent, monitor, config };
}


/** Runs the monitor every 60s (as the scheduler would) until `untilIso`, dispatching the outbox too. */
export async function runFor(s: ReturnType<typeof setupMonitor>, minutes: number, stepMs = 60_000) {
  const reports = [];
  for (let i = 0; i < minutes; i++) {
    reports.push(await s.monitor.runOnce());
    await s.outbox.dispatchDue();
    s.env.clock.advanceMs(stepMs);
  }
  return reports;
}
