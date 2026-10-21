import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const session = 'agent:main:telegram:direct:123';
const safeTools = ['read', 'session_status', 'potts_propose_action', 'potts_action_status', 'potts_list_actions'];
function run(options: { sessions?: string[]; tools?: string[]; profile?: string; error?: boolean; args?: string[]; hasMore?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'potts-effective-'));
  try {
    mkdirSync(join(home, '.openclaw'));
    writeFileSync(join(home, '.openclaw/openclaw.json'), '{}');
    const mock = join(home, 'openclaw');
    writeFileSync(mock, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[2] === 'sessions.list') {
 console.log(JSON.stringify({sessions:${JSON.stringify((options.sessions ?? [session]).map(key => ({ key })))},hasMore:${options.hasMore ?? false}}));
} else {
 const params=JSON.parse(args[args.indexOf('--params')+1]);
 if(params.sessionKey!==${JSON.stringify(session)} || ${options.error ?? false}) {
  console.log(JSON.stringify({ok:false,error:{code:'INVALID_REQUEST',message:'unknown session key'}})); process.exit(1);
 }
 console.log(JSON.stringify({profile:${JSON.stringify(options.profile ?? 'minimal')},groups:[],toolAccess:{tools:${JSON.stringify((options.tools ?? safeTools).map(id => ({ id, status: 'available' })))}}}));
}
`, { mode: 0o700 });
    return spawnSync('bash', [resolve('integrations/openclaw/config-patches/effective-tools.sh'), '--live', '--check', ...(options.args ?? [])], {
      env: { ...process.env, HOME: home, OPENCLAW_BIN: mock }, encoding: 'utf8',
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('discovers actual Telegram session instead of assuming agent:main:main', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).dangerousAvailable, []);
});
test('ambiguous or truncated discovery refuses to guess; explicit session works', () => {
  const sessions = [session, 'agent:main:telegram:direct:456'];
  assert.notEqual(run({ sessions }).status, 0);
  assert.notEqual(run({ hasMore: true }).status, 0);
  assert.equal(run({ sessions, args: ['--session', session] }).status, 0);
});
test('fails closed for stale profile, dangerous or unexpected tools, and missing broker tools', () => {
  for (const options of [
    { profile: 'coding' }, { tools: [...safeTools, 'exec'] },
    { tools: [...safeTools, 'future_write_tool'] }, { tools: ['read'] },
  ]) assert.notEqual(run(options).status, 0);
  assert.notEqual(run({ tools: [...safeTools, 'exec'], args: ['--raw'] }).status, 0);
});
test('RPC failures preserve the error instead of exiting silently', () => {
  const result = run({ error: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_REQUEST/);
  assert.match(result.stdout, /tools.effective failed/);
});
