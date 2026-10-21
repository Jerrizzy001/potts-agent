/**
 * The broker allows one executor per action kind, but personal sends go out
 * through several accounts and providers. The router is that one executor:
 * it selects the writer bound to the intent's exact accountId and refuses
 * anything else. It adds no capability of its own.
 *
 * Registration is explicit and DISABLED by default: only accounts listed in
 * config `writers.accounts` with `enabled: true` get a writer, and only
 * trusted broker startup code may call registerMessageWriters().
 */
import type { AccountRegistry } from '../../core/config.ts';
import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../store/db.ts';
import { ExecutorRejectedError, type DispatchIntent, type Executor, type ExecutorRegistry, type LookupResult } from '../../broker/executor.ts';
import { createApprovalBindingCheck, type AttachmentStore, type MessageKind } from './writer-guard.ts';
import { createProviderRefStore, type FetchLike, type TokenProvider } from './writer-support.ts';
import { createGmailWriter, type WriterExecutor } from '../gmail/writer.ts';
import { createOutlookWriter } from '../outlook/writer.ts';
import { createImessageWriter, type OsascriptRunner } from '../imessage/writer.ts';

export const MESSAGE_ROUTER_INTEGRATION = 'messaging';

export function createMessageRouter(writers: readonly WriterExecutor[]): Executor {
  const byAccount = new Map<string, WriterExecutor>();
  for (const w of writers) {
    if (byAccount.has(w.accountId)) throw new Error(`two writers for account ${w.accountId}`);
    byAccount.set(w.accountId, w);
  }
  const kinds = [...new Set(writers.flatMap((w) => w.kinds))];
  if (!kinds.length) throw new Error('message router needs at least one writer');
  const pick = (intent: Readonly<DispatchIntent>): WriterExecutor => {
    const w = intent.accountId ? byAccount.get(intent.accountId) : undefined;
    if (!w) throw new ExecutorRejectedError(`no enabled writer for account ${intent.accountId ?? '(none)'}`);
    if (!w.kinds.includes(intent.kind)) throw new ExecutorRejectedError(`writer for ${w.accountId} does not handle ${intent.kind}`);
    return w;
  };
  return {
    name: 'message-router',
    integration: MESSAGE_ROUTER_INTEGRATION,
    kinds,
    timeoutMs: Math.max(30_000, ...writers.map((w) => w.timeoutMs ?? 0)),
    async execute(intent, signal) {
      return pick(intent).execute(intent, signal);
    },
    async lookup(intent): Promise<LookupResult> {
      const w = intent.accountId ? byAccount.get(intent.accountId) : undefined;
      if (!w) return { status: 'unknown', reason: `no writer for account ${intent.accountId ?? '(none)'} to look up` };
      return w.lookup(intent);
    },
  };
}

/** Schema for the `writers` config section (mirrored in config/potts.schema.json). */
export const WRITERS_CONFIG_SCHEMA = {
  type: 'object',
  description: 'WP-7 broker-owned message writers. Nothing sends unless an account is listed here with enabled=true; every send still needs an exact owner approval.',
  required: ['accounts'],
  additionalProperties: false,
  properties: {
    lookupSettleSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    accounts: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['accountId', 'enabled'],
        additionalProperties: false,
        properties: {
          accountId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
          enabled: { type: 'boolean' },
          kinds: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['send_message', 'support_reply'] } },
          messagesAccountId: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' },
        },
      },
    },
  },
} as const;

export interface WriterAccountConfig {
  accountId: string;
  enabled: boolean;
  kinds?: MessageKind[];
  /** iMessage only. */
  messagesAccountId?: string;
}
export interface WritersConfig {
  lookupSettleSeconds?: number;
  accounts: WriterAccountConfig[];
}

export interface WriterDeps {
  db: Db;
  clock: Clock;
  accounts: AccountRegistry;
  tokens: TokenProvider;
  attachments?: AttachmentStore;
  fetch?: FetchLike;
  runOsascript?: OsascriptRunner;
  chatDbPath?: string;
}

/**
 * Builds writers for enabled accounts and registers ONE router executor for
 * send_message/support_reply. Returns the writer names (empty when nothing is
 * enabled — the default — in which case nothing is registered and the broker
 * answers no_executor for sends).
 */
export function registerMessageWriters(registry: ExecutorRegistry, cfg: WritersConfig | undefined, deps: WriterDeps): string[] {
  const enabled = (cfg?.accounts ?? []).filter((a) => a.enabled === true);
  if (!enabled.length) return [];
  const approvalCheck = createApprovalBindingCheck(deps.db);
  const refs = createProviderRefStore(deps.db, deps.clock);
  const writers: WriterExecutor[] = [];
  for (const a of enabled) {
    const acct = deps.accounts.get(a.accountId);
    if (!acct) throw new Error(`writers: account ${a.accountId} is not registered`);
    if (acct.mode !== 'approval_required' && acct.mode !== 'automatic') throw new Error(`writers: account ${a.accountId} mode ${acct.mode} cannot send`);
    const kinds: MessageKind[] = a.kinds ?? ['send_message'];
    if (kinds.includes('support_reply') && acct.purpose !== 'support') throw new Error(`writers: support_reply requires a support-purpose account (${a.accountId})`);
    const base = { accountId: acct.id, accountAddress: acct.address, approvalCheck, clock: deps.clock, ...(cfg?.lookupSettleSeconds ? { lookupSettleSeconds: cfg.lookupSettleSeconds } : {}) };
    switch (acct.kind) {
      case 'gmail':
        writers.push(createGmailWriter({ ...base, kinds, tokens: deps.tokens, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.attachments ? { attachments: deps.attachments } : {}) }));
        break;
      case 'outlook':
        writers.push(createOutlookWriter({ ...base, kinds, refs, tokens: deps.tokens, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.attachments ? { attachments: deps.attachments } : {}) }));
        break;
      case 'imessage':
        if (kinds.some((k) => k !== 'send_message')) throw new Error('writers: iMessage handles send_message only');
        writers.push(createImessageWriter({
          accountId: acct.id, accountAddress: acct.address, approvalCheck,
          ...(a.messagesAccountId ? { messagesAccountId: a.messagesAccountId } : {}),
          ...(deps.runOsascript ? { runOsascript: deps.runOsascript } : {}),
          ...(deps.chatDbPath ? { chatDbPath: deps.chatDbPath } : {}),
        }));
        break;
      default:
        throw new Error(`writers: no writer for account kind ${acct.kind}`);
    }
  }
  registry.register(createMessageRouter(writers));
  return writers.map((w) => w.name);
}
