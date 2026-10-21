/** The plugin entry against a fake OpenClaw API: what it registers, and what it never registers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../../integrations/openclaw/potts-broker-plugin/index.ts';
import manifest from '../../integrations/openclaw/potts-broker-plugin/openclaw.plugin.json' with { type: 'json' };

function fakeApi(pluginConfig: Record<string, unknown>) {
  const reg = { tools: [] as { name: string }[], commands: [] as { name: string; channels?: readonly string[]; requireAuth?: boolean }[], interactive: [] as { channel: string; namespace: string }[], services: [] as { id: string }[], errors: [] as string[] };
  const api = {
    pluginConfig,
    logger: { info() {}, warn() {}, error: (m: string) => reg.errors.push(m) },
    registerTool: (t: unknown, opts?: {names?:string[]}) => { if(typeof t==='function')reg.tools.push(...(opts?.names??[]).map(name=>({name}))); else reg.tools.push(t as {name:string}); },
    registerCommand: (c: unknown) => reg.commands.push(c as { name: string }),
    registerInteractiveHandler: (r: unknown) => reg.interactive.push(r as { channel: string; namespace: string }),
    registerService: (s: unknown) => reg.services.push(s as { id: string }),
  };
  return { api, reg };
}

test('registers typed tools, LLM-free owner commands (telegram only, auth required) and the potts button namespace', () => {
  const { api, reg } = fakeApi({ ownerTelegramId: '424242' });
  plugin.register(api as never);
  assert.deepEqual(reg.tools.map((t) => t.name), ['potts_release_request', 'potts_release_status', 'potts_propose_action', 'potts_action_status', 'potts_list_actions', 'potts_environment_status', 'potts_send_screenshot', 'potts_send_voice', 'potts_send_file', 'potts_reminder', 'potts_claude', 'potts_claude_status', 'potts_delegate', 'potts_worker_status', 'potts_worker_control']);
  assert.deepEqual(reg.commands.map((c) => c.name).sort(), ['approvals', 'cancel', 'claude', 'deny', 'forget', 'papprove', 'pause', 'potts', 'pstatus', 'resume', 'revoke']);
  for (const c of reg.commands) {
    assert.deepEqual(c.channels, ['telegram']);
    assert.equal(c.requireAuth, true);
    assert.ok(!['status', 'approve'].includes(c.name), 'reserved/core names are not shadowed');
  }
  assert.deepEqual(reg.interactive, [{ channel: 'telegram', namespace: 'potts', handler: (reg.interactive[0] as unknown as { handler: unknown }).handler }]);
  assert.equal(reg.services.length, 0, 'owner channel is off by default');
  for (const t of manifest.contracts.tools) assert.match(t, /^potts_/);
});

test('owner channel service only when enabled; invalid config registers nothing', () => {
  const on = fakeApi({ ownerTelegramId: '424242', ownerChannel: true });
  plugin.register(on.api as never);
  assert.deepEqual(on.reg.services.map((s) => s.id), ['potts-owner-channel']);
  const bad = fakeApi({ ownerTelegramId: 'not-a-number' });
  plugin.register(bad.api as never);
  assert.equal(bad.reg.tools.length + bad.reg.commands.length, 0);
  assert.equal(bad.reg.errors.length, 1);
  const readOnly = fakeApi({ ownerTelegramId: '424242', readSocket: '/tmp/x.sock', ownerControls: false });
  plugin.register(readOnly.api as never);
  assert.equal(readOnly.reg.commands.length, 0);
  assert.deepEqual(readOnly.reg.tools.map((t) => t.name).slice(5), ['potts_save_file', 'potts_search_imessage', 'potts_delegation_report', 'potts_read_content', 'potts_capability_status', 'potts_memory_explain', 'potts_memory_search', 'potts_drafts_list', 'potts_briefing_status', 'potts_environment_status']);
});

test('native worker tools require the equivalent Codex exclusions before removing the finite tool override', () => {
  const required = ['message', 'cron', 'automations', 'sessions_spawn', 'subagents', 'potts_delegate', 'potts_claude', 'potts_send_file', 'potts_send_voice', 'potts_send_screenshot', 'potts_reminder', 'potts_worker_control', 'potts_learning', 'potts_react'];
  for (const complete of [false, true]) {
    const { api } = fakeApi({ coordinatorEnabled: true });
    let hook: (event: unknown, context: { agentId: string; sessionKey: string }) => { toolsAllow?: string[] };
    const host = { ...api,
      config: {
        agents: { defaults: { models: { 'openai/gpt-6.1-sol': { agentRuntime: { id: 'codex' } } } } },
        plugins: { entries: { codex: { config: { codexDynamicToolsExclude: complete ? required : required.slice(1) } } } },
      },
      on(_name: string, handler: typeof hook) { hook = handler; },
    };
    plugin.register(host as never);
    const result = hook!({}, { agentId: 'main', sessionKey: 'agent:main:potts-worker-sol_20261020210000_abcd1234' });
    assert.equal(result.toolsAllow === undefined, complete);
    if (!complete) assert.ok(result.toolsAllow!.includes('read'));
  }
});
