/** Opt-in model switch for an existing extended coordinator; preview by default. */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COORDINATOR_MODEL, switchCoordinatorModel } from './chat-model.ts';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--help'].includes(arg))) throw new Error('Supported options: --apply, --help');
if (args.includes('--help')) {
  console.log('Preview the GPT-6.1 Sol switch for an existing potts-coordinator. Use --apply to write after validation. OPENCLAW_CONFIG_PATH selects the config; OPENCLAW_BIN selects the CLI. No gateway restart or session reset is performed.');
} else {
  const file = resolve(process.env.OPENCLAW_CONFIG_PATH ?? join(homedir(), '.openclaw', 'openclaw.json'));
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  switchCoordinatorModel(cfg);
  const folder = join(dirname(file), 'potts-model-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const candidate = join(folder, 'candidate.json');
  writeFileSync(candidate, JSON.stringify(cfg, null, 2)+'\n', { mode: 0o600 });
  // Validation only: no authentication, model requests, sends or service changes.
  execFileSync(process.env.OPENCLAW_BIN ?? 'openclaw', ['config', 'validate', '--json'], {
    env: { ...process.env, OPENCLAW_CONFIG_PATH: candidate }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  const apply = args.includes('--apply');
  if (apply) {
    copyFileSync(file, join(folder, 'before.json'));
    // A rename on the same filesystem preserves atomic replacement and 0600 mode.
    const next = join(folder, 'next.json');
    writeFileSync(next, JSON.stringify(cfg, null, 2)+'\n', { mode: 0o600 });
    renameSync(next, file);
  }
  console.log(JSON.stringify({ validated: true, applied: apply, model: COORDINATOR_MODEL, candidate, backup: apply ? join(folder, 'before.json') : null }));
}
