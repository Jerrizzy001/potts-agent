import { readFileSync } from 'node:fs';
/** Static checks on the effective-tool constraint patch (the live effect is verified in the test profile, see docs/phase1/boundary-report.md). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import patch from '../../integrations/openclaw/config-patches/potts-agent-tools.patch.json' with { type: 'json' };
import manifest from '../../integrations/openclaw/potts-broker-plugin/openclaw.plugin.json' with { type: 'json' };

const t = patch.agents.entries.main.tools;

test('allow surface is broker tools + read + memory read only', () => {
  assert.equal(t.profile, 'minimal');
  assert.deepEqual([...t.alsoAllow].sort(), ['memory_get', 'memory_search', 'potts_action_status', 'potts_briefing_status', 'potts_capability_status', 'potts_delegation_report', 'potts_drafts_list', 'potts_list_actions', 'potts_memory_explain', 'potts_memory_search', 'potts_propose_action', 'potts_read_content', 'potts_save_file', 'potts_search_imessage', 'read']);
  for (const name of t.alsoAllow.filter((n) => n.startsWith('potts_'))) assert.ok(manifest.contracts.tools.includes(name));
  assert.equal(t.fs.workspaceOnly, true);
  assert.equal(t.elevated.enabled, false);
  assert.equal('allow' in t, false, 'allow and alsoAllow cannot be combined in one scope');
});

test('every code, network, UI, messaging, delegation and write route is denied (deny wins over allow)', () => {
  for (const d of ['group:runtime', 'group:web', 'group:ui', 'group:automation', 'group:nodes', 'group:messaging', 'exec', 'process', 'code_execution', 'write', 'edit', 'apply_patch',
    'browser', 'computer', 'nodes', 'gateway', 'openclaw', 'plugins', 'cron', 'message', 'sessions_send', 'sessions_spawn', 'subagents', 'conversations_send', 'conversations_turn', 'secrets']) {
    assert.ok(t.deny.includes(d), d);
  }
  for (const a of t.alsoAllow) assert.ok(!t.deny.includes(a), `${a} is both allowed and denied`);
});

test('owner-requested auto profile: reviewed exec, files, web, browser and Mac control allowed; messaging/config/sessions still denied', () => {
  const p = JSON.parse(readFileSync(new URL('../../integrations/openclaw/config-patches/potts-agent-auto.patch.json', import.meta.url), 'utf8'));
  const tools = p.agents.entries.main.tools;
  assert.equal(tools.profile, 'minimal');
  for (const name of ['exec', 'process', 'read', 'write', 'edit', 'apply_patch', 'web_fetch', 'web_search', 'browser', 'computer', 'nodes', ...manifest.contracts.tools]) assert.ok(tools.alsoAllow.includes(name), name);
  assert.equal(tools.exec.mode, 'auto');
  assert.equal(tools.exec.strictInlineEval, true);
  assert.equal(tools.exec.host, 'gateway');
  assert.equal(tools.exec.reviewer.model, 'openai/gpt-6.1-sol', 'advanced profile reviewer model matches its declared preset');
  assert.ok(tools.exec.pathPrepend.some((d: string) => d.endsWith('/Potts/bin/guard')), 'deletion guard dir on PATH');
  assert.ok(tools.alsoAllow.includes('message'), 'message tool (locked to the current chat by tools.message.crossContext)');
  for (const name of ['conversations_send', 'gateway', 'openclaw', 'plugins', 'secrets', 'sessions_send', 'code_execution']) assert.ok(tools.deny.includes(name), name);
  for (const name of ['sessions_spawn', 'subagents', 'agents_wait']) assert.ok(tools.alsoAllow.includes(name), `${name} (orchestrator)`);
  assert.equal(tools.fs.workspaceOnly, false, 'owner permits task-relevant files outside the workspace');
  for (const a of tools.alsoAllow) assert.ok(!tools.deny.includes(a), `${a} is both allowed and denied`);
  assert.equal(tools.elevated.enabled, false);
});

test('owner-requested terminal profile adds exec/process behind native approvals, preserving protected tool exclusions', () => {
  const p = JSON.parse(readFileSync(new URL('../../integrations/openclaw/config-patches/potts-agent-owner-terminal.patch.json', import.meta.url), 'utf8'));
  const tools = p.agents.entries.main.tools;
  assert.ok(tools.alsoAllow.includes('exec') && tools.alsoAllow.includes('process'));
  assert.equal(tools.exec.mode,'ask'); assert.equal(tools.exec.strictInlineEval,true);
  for (const name of ['message','browser','computer','write','secrets','gateway','sessions_send','code_execution']) assert.ok(tools.deny.includes(name));
  assert.equal(tools.elevated.enabled,false);
});
