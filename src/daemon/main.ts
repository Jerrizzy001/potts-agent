#!/usr/bin/env node
/**
 * Potts daemon entry.
 *
 *   node --disable-warning=ExperimentalWarning src/daemon/main.ts            run in the foreground (launchd)
 *   node --disable-warning=ExperimentalWarning src/daemon/main.ts --check    readiness table; starts nothing, writes nothing
 *   options: --home <dir> (default $POTTS_HOME or ~/Library/Application Support/Potts)
 *   env: POTTS_KEYCHAIN=off never touches the Keychain (keychain: references then read as missing)
 *
 * SIGTERM / SIGINT: stop accepting work, finish the running scheduler pass,
 * release leases, close sockets, export the audit head, exit 0.
 * SIGHUP: re-read policy.json (an invalid file is rejected, the current policy
 * stays and the owner is alerted; a change invalidates outstanding approvals).
 */
import { parseArgs } from 'node:util';
import { systemClock } from '../core/clock.ts';
import { resolvePottsHome } from '../store/home.ts';
import { createDaemon } from './daemon.ts';
import { runCheck } from './check.ts';

const USAGE = 'usage: main.ts [--check] [--home <dir>]';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, home: { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const home = values.home ?? resolvePottsHome();
  // POTTS_KEYCHAIN=off: never touch the Keychain (CI, dry runs on another machine); keychain: refs read as missing.
  const noKeychain = process.env.POTTS_KEYCHAIN === 'off';
  const keychainLookup = noKeychain ? async () => { throw new Error('keychain disabled (POTTS_KEYCHAIN=off)'); } : undefined;
  if (values.check) {
    const r = await runCheck({ home, clock: systemClock, ...(keychainLookup ? { secrets: { keychainLookup } } : {}) });
    console.log(r.text);
    return r.ok ? 0 : 1;
  }
  const d = await createDaemon({ home, ...(keychainLookup ? { keychainLookup } : {}) });
  if (!d.ok) {
    process.stderr.write(`potts daemon: refusing to start: ${d.error.message}\n`);
    return 2;
  }
  const daemon = d.value;
  return new Promise<number>((resolveExit) => {
    // Handlers are installed BEFORE start(), so a SIGTERM that arrives while sockets are opening still drains.
    let started = false;
    let pending: { reason: string; code: number } | null = null;
    let stopping = false;
    const shutdown = (reason: string, code: number) => {
      if (!started) {
        pending ??= { reason, code };
        return;
      }
      if (stopping) return;
      stopping = true;
      const hard = setTimeout(() => resolveExit(code || 1), 25_000);
      hard.unref();
      daemon.stop(reason).then(
        () => resolveExit(code),
        () => resolveExit(code || 1),
      );
    };
    process.on('SIGTERM', () => shutdown('SIGTERM', 0));
    process.on('SIGINT', () => shutdown('SIGINT', 0));
    process.on('SIGHUP', () => {
      if (!started || stopping) return;
      try {
        const r = daemon.reloadPolicy('sighup');
        daemon.log.info('SIGHUP policy reload', { outcome: r.outcome, ...(r.outcome === 'rejected' ? { reason: r.reason } : {}) });
      } catch (e) {
        daemon.log.error('SIGHUP policy reload failed', { error: (e as Error).message });
      }
    });
    process.on('uncaughtException', (e) => {
      daemon.log.error('uncaught exception; shutting down', { error: e.message });
      shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (e) => {
      daemon.log.error('unhandled rejection; shutting down', { error: (e as Error)?.message ?? String(e) });
      shutdown('unhandledRejection', 1);
    });
    daemon.start().then(
      () => {
        started = true;
        try {
          daemon.rotateLogs();
        } catch (e) {
          daemon.log.warn('log rotation failed', { error: (e as Error).message });
        }
        if (pending) shutdown(pending.reason, pending.code);
      },
      (e: Error) => {
        daemon.log.error('start failed', { error: e.message });
        started = true;
        shutdown('start failed', 1);
      },
    );
  });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`potts daemon: fatal: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
