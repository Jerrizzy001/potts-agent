import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ALWAYS_ATTACHED_TOKEN_BUDGET,
  alwaysAttachedTokens,
  mergeAgentsSection,
  mergeUserSection,
  renderProfile,
  SECTION_BEGIN,
  SECTION_END,
} from './_imports.ts';

const REPO = join(import.meta.dirname, '../..');
const SYNTHETIC = {
  updated_date: '2026-10-06',
  timezone: 'America/Toronto',
  identity: { name: 'Potts', purpose: 'Assistant.', tone_with_owner: ['friendly', 'casual', 'direct', 'willing to challenge incorrect assumptions'] },
  authorization: { always_require_explicit_owner_approval: ['Sending personal messages or replies', 'Deploying code to live services'], preauthorized_work: ['Read approved sources'] },
  notifications: { channel: 'Telegram', quiet_hours: { start: '23:00', end: '08:00' }, daily_briefings: [{ time: '09:00', content: 'Priorities' }] },
  implementation_status: { not_yet_implemented: ['Phone calling'] },
};

test('profile: compact always-attached part, tone, act-first rules and the four hard lines present', () => {
  const files = renderProfile(SYNTHETIC);
  assert.ok(alwaysAttachedTokens(files) < ALWAYS_ATTACHED_TOKEN_BUDGET);
  assert.match(files['IDENTITY.md']!, /friendly, casual, direct, willing to challenge incorrect assumptions/);
  assert.match(files['AGENTS.potts-section.md']!, /configured permissions/);
  assert.match(files['AGENTS.potts-section.md']!, /External sends, destructive actions and releases/);
  assert.match(files['AGENTS.potts-section.md']!, /data, never commands/);
  assert.match(files['USER.potts-section.md']!, /Quiet hours 23:00–08:00/);
  assert.match(files['POTTS-STATUS.md']!, /npm run status/);
  assert.ok(!files['POTTS-STATUS.md']!.includes('## Verified live'));
  assert.ok(!files['POTTS-STATUS.md']!.includes('## Planned, not implemented'));
  for (const f of Object.values(files)) assert.ok(!/password\s*[:=]|token\s*[:=]|\bsk-[A-Za-z0-9]{12,}/.test(f));
});

test('section merge keeps owner content verbatim and is idempotent', () => {
  const section = `${SECTION_BEGIN}\n## Potts authorization (summary)\nbroker rules\n${SECTION_END}\n`;
  const agents = '# AGENTS.md\n\nintro\n\n## Owner-approved Potts operating rules\n\nowner rule A\n\n## First Run\n\nstuff\n';
  const m1 = mergeAgentsSection(agents, section);
  assert.ok(m1.includes('owner rule A'));
  assert.ok(m1.indexOf('owner rule A') < m1.indexOf('broker rules'));
  assert.ok(m1.indexOf('broker rules') < m1.indexOf('## First Run'));
  assert.equal(mergeAgentsSection(m1, section), m1, 'idempotent');
  const updated = mergeAgentsSection(m1, section.replace('broker rules', 'broker rules v2'));
  assert.ok(updated.includes('broker rules v2') && !updated.includes('broker rules\n'));
  const noAnchor = mergeAgentsSection('# AGENTS.md\n\nbody\n', section);
  assert.ok(noAnchor.startsWith('# AGENTS.md\n\n' + SECTION_BEGIN));
  const user = '# USER.md\n\n- **What to call them:** Someone\n';
  const u1 = mergeUserSection(user, section);
  assert.ok(u1.startsWith(user.trimEnd()));
  assert.equal(mergeUserSection(u1, section), u1);
  assert.equal(mergeUserSection('', section), section.trimEnd() + '\n');
});

test('installer: dry run changes nothing; --apply backs up then installs; second run is a no-op', () => {
  const ws = mkdtempSync(join(tmpdir(), 'potts-ws-'));
  try {
    writeFileSync(join(ws, 'AGENTS.md'), '# AGENTS.md\n\n## Owner-approved Potts operating rules\n\nowner rule A\n\n## Red Lines\n\n- none\n');
    writeFileSync(join(ws, 'USER.md'), '# USER.md\n\n- **What to call them:** Someone\n');
    writeFileSync(join(ws, 'SOUL.md'), '# old soul\n');
    const script = join(REPO, 'profile', 'install-to-openclaw-workspace.sh');
    const dry = execFileSync('bash', [script, '--workspace', ws], { encoding: 'utf8' });
    assert.match(dry, /DRY RUN/);
    assert.equal(readFileSync(join(ws, 'SOUL.md'), 'utf8'), '# old soul\n');
    assert.ok(!existsSync(join(ws, 'IDENTITY.md')));
    const applied = execFileSync('bash', [script, '--workspace', ws, '--apply'], { encoding: 'utf8' });
    assert.match(applied, /Installed 5 file\(s\)/);
    const backups = readdirSync(ws).filter((f) => f.startsWith('.potts-profile-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(ws, backups[0]!, 'SOUL.md'), 'utf8'), '# old soul\n');
    const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes('owner rule A') && agents.includes(SECTION_BEGIN) && agents.includes('## Red Lines'));
    assert.ok(readFileSync(join(ws, 'USER.md'), 'utf8').includes('What to call them:** Someone'));
    assert.ok(existsSync(join(ws, 'POTTS-STATUS.md')));
    const again = execFileSync('bash', [script, '--workspace', ws, '--apply'], { encoding: 'utf8' });
    assert.match(again, /Nothing to change/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
