import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../../src/core/clock.ts';
import { EXAMPLE_SITE } from '../../src/monitoring/config.ts';
import { checkHealth, checkHomepage } from '../../src/monitoring/probe.ts';

/**
 * Opt-in: POTTS_LIVE_SMOKE=1 npm run test:wp5:smoke
 * Set POTTS_SMOKE_URL to a site you own. Two GETs against that site (homepage and /api/health). No auth, no writes.
 */
const live = process.env.POTTS_LIVE_SMOKE === '1';

test('live smoke: Example App homepage and /api/health', { skip: !live && 'set POTTS_LIVE_SMOKE=1 to run' }, async () => {
  const url = process.env.POTTS_SMOKE_URL;
  assert.ok(url, 'POTTS_SMOKE_URL must explicitly identify a site you own');
  assert.equal(new URL(url).protocol, 'https:');
  const site = { ...EXAMPLE_SITE, baseUrl: url };
  const deps = { fetch: globalThis.fetch.bind(globalThis), clock: systemClock };
  const home = await checkHomepage(site, deps);
  const health = await checkHealth(site, deps);
  console.log(JSON.stringify({ home, health }));
  assert.equal(home.ok, true, `homepage: ${home.statusCode ?? home.cause}`);
  assert.equal(health.ok, true, `health: ${health.statusCode ?? health.cause}`);
});
