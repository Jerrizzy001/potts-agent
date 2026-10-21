/** Shared fixture: real broker + proposer/ingress sockets + the plugin's owner handlers and tools. */
import { join } from 'node:path';
import { createTestHarness, TEST_OWNER_ID, type TestHarness } from '../../src/broker/testing.ts';
import { startBrokerServer, startIngressServer, type RunningServer } from '../../src/broker/server.ts';
import { parsePluginConfig, type PluginConfig, type SecretsProvider } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { createOwnerHandlers, type OwnerHandlers } from '../../integrations/openclaw/potts-broker-plugin/lib/owner.ts';
import { createReplayCache } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import type { CallbackContextLike, CommandContextLike } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import { createAgentTools, type AgentToolDef } from '../../integrations/openclaw/potts-broker-plugin/lib/tools.ts';

export { TEST_OWNER_ID };
export const STRANGER_ID = '777000111';

export interface Fixture {
  h: TestHarness;
  cfg: PluginConfig;
  secrets: SecretsProvider;
  owner: OwnerHandlers;
  tools: AgentToolDef[];
  servers: RunningServer[];
  logs: { event: string; data: Record<string, unknown> }[];
  /** New handler instance on the same broker (simulates a gateway restart: empty in-memory replay cache). */
  freshOwner(): OwnerHandlers;
  close(): Promise<void>;
}

export async function createFixture(opts: { secretsNull?: boolean } = {}): Promise<Fixture> {
  const h = createTestHarness();
  const brokerSocket = join(h.dir, 'broker.sock');
  const ingressSocket = join(h.dir, 'ingress.sock');
  const servers = [
    await startBrokerServer({ broker: h.broker, socketPath: brokerSocket, actor: 'openclaw' }),
    await startIngressServer({ owner: h.owner, socketPath: ingressSocket, key: h.key }),
  ];
  const parsed = parsePluginConfig({ pottsHome: h.dir, brokerSocket, ingressSocket, ownerTelegramId: TEST_OWNER_ID });
  if (!parsed.ok) throw new Error(parsed.error);
  const cfg = parsed.value;
  const secrets: SecretsProvider = { get: async () => (opts.secretsNull ? null : { ownerId: TEST_OWNER_ID, key: h.key }) };
  const logs: Fixture['logs'] = [];
  const mk = () => createOwnerHandlers({ cfg, secrets, now: () => new Date(h.clock.nowMs()), replay: createReplayCache(), log: (event, data) => logs.push({ event, data }) });
  return {
    h, cfg, secrets, owner: mk(), tools: createAgentTools(cfg), servers, logs, freshOwner: mk,
    async close() {
      for (const s of servers) await s.close();
      h.close();
    },
  };
}

export function ownerCmd(args = '', over: Partial<CommandContextLike> = {}): CommandContextLike {
  return { channel: 'telegram', senderId: TEST_OWNER_ID, isAuthorizedSender: true, commandBody: `/x ${args}`.trim(), args, from: `telegram:${TEST_OWNER_ID}`, to: `telegram:${TEST_OWNER_ID}`, ...over };
}

let cbSeq = 1;
export function ownerCallback(payload: string, over: Partial<CallbackContextLike> = {}): CallbackContextLike {
  return {
    channel: 'telegram',
    callbackId: `cbq-${Date.now()}-${cbSeq++}`,
    conversationId: TEST_OWNER_ID,
    senderId: TEST_OWNER_ID,
    isGroup: false,
    isForum: false,
    auth: { isAuthorizedSender: true },
    callback: { data: `potts:${payload}`, namespace: 'potts', payload, messageId: 10, chatId: TEST_OWNER_ID },
    ...over,
  };
}

export const SEND = { kind: 'send_message', accountId: 'gmail-personal', destination: ['bob@example.com'], payload: { channel: 'email', to: ['bob@example.com'], subject: 'Hi', body: 'See you at 5' } };

export function tool(f: Fixture, name: string): AgentToolDef {
  const t = f.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
