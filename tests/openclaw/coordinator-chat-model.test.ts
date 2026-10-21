import test from 'node:test';
import assert from 'node:assert/strict';
import { COORDINATOR_MODEL, switchCoordinatorModel } from '../../scripts/coordinator/chat-model.ts';

test('Sol switch preserves worker models, native worker routing, owner route and coordinator tool boundaries', () => {
  const cfg = { agents: { defaults: { models: { 'openai/gpt-6.1-sol': {agentRuntime:{id:'codex'}} }, modelPolicy: { allow: ['openai/gpt-6.1-sol'] } }, entries: {
    main: { model: { primary: 'openai/gpt-6.1-sol' }, tools: { fs: { workspaceOnly: false } } },
    'potts-coordinator': { models: {} as Record<string, any>, model: { primary: 'anthropic/claude-haiku-5-5', fallbacks: ['openai/gpt-6.1-sol'] }, modelPolicy: { allow: ['openai/gpt-6-luna', 'openai/gpt-6.1-sol'] }, tools: { deny: ['write', 'edit', 'exec'] } },
  } }, bindings: [{ agentId: 'potts-coordinator', match: { channel: 'imessage' } }] };
  const before = structuredClone(cfg);
  switchCoordinatorModel(cfg);
  assert.deepEqual(cfg.agents.entries.main, before.agents.entries.main);
  assert.deepEqual(cfg.bindings, before.bindings);
  for (const model of before.agents.entries['potts-coordinator'].modelPolicy.allow) assert.ok(cfg.agents.entries['potts-coordinator'].modelPolicy.allow.includes(model));
  assert.deepEqual(cfg.agents.entries['potts-coordinator'].tools, before.agents.entries['potts-coordinator'].tools);
  assert.equal(cfg.agents.entries['potts-coordinator'].model.primary, COORDINATOR_MODEL);
  assert.deepEqual(cfg.agents.entries['potts-coordinator'].model.fallbacks, []);
  assert.deepEqual((cfg.agents.defaults.models as any)[COORDINATOR_MODEL].agentRuntime, { id: 'codex' });
  assert.deepEqual(cfg.agents.entries['potts-coordinator'].models[COORDINATOR_MODEL].agentRuntime, { id: 'openclaw' });
  const once = structuredClone(cfg); switchCoordinatorModel(cfg); assert.deepEqual(cfg, once);
});

test('missing coordinator fails before changing configuration', () => {
  const cfg = { agents: { defaults: { models: {} }, entries: {} } };
  const before = structuredClone(cfg);
  assert.throws(() => switchCoordinatorModel(cfg), /Existing Potts coordinator/);
  assert.deepEqual(cfg, before);
});
