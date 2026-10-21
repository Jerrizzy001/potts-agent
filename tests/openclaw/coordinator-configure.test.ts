import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('coordinator configuration previews, validates, and applies only the selected model without touching connections', () => {
  const home = mkdtempSync(join(tmpdir(), 'potts-model-config-'));
  try {
    const file = join(home, 'config.json'); const bin = join(home, 'openclaw');
    const cfg = { agents: { defaults: { models: { 'openai/gpt-6.1-sol': { agentRuntime: { id: 'codex' } } } }, entries: {
      main: { model: { primary: 'custom/worker' } }, 'potts-coordinator': { model: { primary: 'custom/chat' }, tools: { deny: ['exec'] } },
    } }, channels: { imessage: { allowFrom: ['+14165550123'] } }, memory: { search: { provider: 'configured' } } };
    const original = JSON.stringify(cfg); writeFileSync(file, original);
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = config ] && [ "$2" = validate ] && [ -r "$OPENCLAW_CONFIG_PATH" ]\n', { mode: 0o700 });
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/coordinator/configure.ts'), ...args], {
      encoding: 'utf8', env: { ...process.env, OPENCLAW_CONFIG_PATH: file, OPENCLAW_BIN: bin },
    });
    const preview = run(); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).applied, false);
    assert.equal(readFileSync(file, 'utf8'), original);
    const applied = run('--apply'); assert.equal(applied.status, 0, applied.stderr);
    const after = JSON.parse(readFileSync(file, 'utf8')); assert.equal(after.agents.entries['potts-coordinator'].model.primary, 'openai/gpt-6.1-sol');
    assert.deepEqual(after.channels, cfg.channels); assert.deepEqual(after.memory, cfg.memory); assert.deepEqual(after.agents.entries.main, cfg.agents.entries.main);
    const backup = JSON.parse(applied.stdout).backup; assert.equal(readFileSync(backup, 'utf8'), original);
    writeFileSync(bin, '#!/bin/sh\nexit 9\n', { mode: 0o700 });
    const beforeFailure = readFileSync(file, 'utf8'); assert.notEqual(run('--apply').status, 0); assert.equal(readFileSync(file, 'utf8'), beforeFailure);
    assert.ok(readdirSync(join(home, 'potts-model-backups')).length >= 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
