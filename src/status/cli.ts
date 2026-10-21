#!/usr/bin/env node
/**
 * `npm run status`: capability status table. Uses the running daemon's view
 * (run/read.sock) when available, otherwise computes an offline view from the
 * config and a read-only open of the database. Never writes anything.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../core/clock.ts';
import { resolvePottsHome } from '../store/home.ts';
import { connectSocket } from '../broker/server.ts';
import { runCheck } from '../daemon/check.ts';
import { renderStatusTable } from './render.ts';
import type { Capability } from './model.ts';
import type { ControlSnapshot } from '../broker/broker.ts';

async function live(home: string): Promise<{ controls: ControlSnapshot; capabilities: Capability[] } | null> {
  const sock = join(home, 'run', 'read.sock');
  if (!existsSync(sock)) return null;
  try {
    const c = await connectSocket(sock);
    try {
      const r = await c.call('capabilities.status');
      return r.ok ? (r.result as { controls: ControlSnapshot; capabilities: Capability[] }) : null;
    } finally {
      c.close();
    }
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { home: { type: 'string' }, json: { type: 'boolean', default: false } } });
  const home = values.home ?? resolvePottsHome();
  const l = await live(home);
  if (l) {
    if (values.json) console.log(JSON.stringify(l, null, 2));
    else console.log(`Potts capability status (live, from the running daemon)\n\n${renderStatusTable(l.capabilities, l.controls)}`);
    return 0;
  }
  const r = await runCheck({ home, clock: systemClock, ...(process.env.POTTS_KEYCHAIN === 'off' ? { secrets: { keychainLookup: async () => { throw new Error('keychain disabled'); } } } : {}) });
  console.log(r.text);
  return 0;
}

main().then((c) => process.exit(c), (e) => {
  process.stderr.write(`status: ${(e as Error).message}\n`);
  process.exit(1);
});
