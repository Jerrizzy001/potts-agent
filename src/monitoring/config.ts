import { isSecretRef } from '../core/secrets.ts';

/**
 * Monitoring configuration (config key `monitoring`). Initially one site:
 * User-configured sites only.
 */
export interface JourneyCheck {
  /** Slug used in evidence ("journey:<name>"). */
  name: string;
  /** Path relative to the site's baseUrl. Requests are always GET. */
  path: string;
  /** Acceptable final status codes. Default [200]. */
  expectStatus?: number[];
  /** Optional plain substring that must appear in the response body (body is never stored). */
  mustContain?: string;
  /** Optional latency budget; slower responses count as degraded. */
  maxLatencyMs?: number;
}

export interface ReadinessConfig {
  /** Path of the token-protected monitor endpoint, e.g. "/api/monitor" (configured by the site owner). */
  path: string;
  /** Secret reference for the monitor token (keychain:<service>/<account> or env:NAME). */
  tokenRef: string;
}

export interface MaintenanceWindow {
  start: string; // UTC ISO
  end: string; // UTC ISO
  reason?: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  homepagePath: string;
  healthPath: string;
  readiness?: ReadinessConfig;
  journeys: JourneyCheck[];
  intervalSeconds: number;
  timeoutMs: number;
  outageConfirmSeconds: number;
  minConsecutiveFailures: number;
  recoveryConsecutiveSuccesses: number;
  maintenanceWindows: MaintenanceWindow[];
}

export interface MonitoringConfig {
  enabled: boolean;
  sites: SiteConfig[];
  /** Independent well-known endpoints used to tell "Mac offline" from "site down". */
  connectivityProbes: string[];
}

export const DEFAULT_CONNECTIVITY_PROBES = ['https://1.1.1.1/cdn-cgi/trace', 'https://www.apple.com/library/test/success.html'];

export const EXAMPLE_SITE: SiteConfig = Object.freeze({
  id: 'example',
  name: 'Example site',
  baseUrl: 'https://example.com',
  enabled: true,
  homepagePath: '/',
  healthPath: '/api/health',
  journeys: [],
  intervalSeconds: 60,
  timeoutMs: 10_000,
  outageConfirmSeconds: 600,
  minConsecutiveFailures: 3,
  recoveryConsecutiveSuccesses: 2,
  maintenanceWindows: [],
}) as SiteConfig;

export const DEFAULT_MONITORING: MonitoringConfig = {
  enabled: false,
  sites: [],
  connectivityProbes: DEFAULT_CONNECTIVITY_PROBES,
};

function assertPath(p: string, what: string): void {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || /[\s\\]/.test(p) || p.includes('..'))
    throw new Error(`${what}: must be an absolute path on the site (got ${JSON.stringify(p)})`);
}

/** Validates and fills defaults. Throws with a clear message on invalid config. */
export function normalizeMonitoringConfig(raw: unknown): MonitoringConfig {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_MONITORING);
  const r = raw as Partial<MonitoringConfig> & { sites?: Partial<SiteConfig>[] };
  const sites = (r.sites ?? []).map((s, i) => {
    const site: SiteConfig = { ...EXAMPLE_SITE, ...s } as SiteConfig;
    site.journeys = [...(s.journeys ?? [])];
    site.maintenanceWindows = [...(s.maintenanceWindows ?? [])];
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(site.id)) throw new Error(`monitoring.sites[${i}].id invalid`);
    const u = new URL(site.baseUrl);
    if (u.protocol !== 'https:') throw new Error(`monitoring.sites[${i}].baseUrl must be https`);
    site.baseUrl = u.origin;
    assertPath(site.homepagePath, `monitoring.sites[${i}].homepagePath`);
    assertPath(site.healthPath, `monitoring.sites[${i}].healthPath`);
    if (site.readiness) {
      assertPath(site.readiness.path, `monitoring.sites[${i}].readiness.path`);
      if (!isSecretRef(site.readiness.tokenRef)) throw new Error(`monitoring.sites[${i}].readiness.tokenRef must be a keychain:/env: reference`);
    }
    for (const j of site.journeys) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(j.name)) throw new Error(`journey name invalid: ${j.name}`);
      assertPath(j.path, `journey ${j.name}`);
      if ('method' in (j as unknown as Record<string, unknown>)) throw new Error(`journey ${j.name}: journeys are GET-only; "method" is not allowed`);
    }
    if (site.intervalSeconds < 30) throw new Error('intervalSeconds must be >= 30');
    if (site.minConsecutiveFailures < 2) throw new Error('minConsecutiveFailures must be >= 2');
    if (site.recoveryConsecutiveSuccesses < 1) throw new Error('recoveryConsecutiveSuccesses must be >= 1');
    if (site.outageConfirmSeconds < 60) throw new Error('outageConfirmSeconds must be >= 60');
    for (const w of site.maintenanceWindows) if (Number.isNaN(Date.parse(w.start)) || Number.isNaN(Date.parse(w.end))) throw new Error('maintenance window needs ISO start/end');
    return site;
  });
  const ids = new Set<string>();
  for (const s of sites) {
    if (ids.has(s.id)) throw new Error(`duplicate monitoring site id ${s.id}`);
    ids.add(s.id);
  }
  const probes = r.connectivityProbes ?? DEFAULT_CONNECTIVITY_PROBES;
  if (probes.length < 2) throw new Error('monitoring.connectivityProbes needs at least 2 independent endpoints');
  for (const p of probes) if (new URL(p).protocol !== 'https:') throw new Error('connectivity probes must be https');
  return { enabled: r.enabled !== false, sites, connectivityProbes: [...probes] };
}

export function activeMaintenance(site: SiteConfig, nowMs: number): MaintenanceWindow | null {
  return site.maintenanceWindows.find((w) => Date.parse(w.start) <= nowMs && nowMs < Date.parse(w.end)) ?? null;
}
