/**
 * Support identity / channel registry (config key `support`). Every channel
 * is registered explicitly, names the app it serves and the exact account it
 * replies from, and is DISABLED and in SHADOW mode unless the owner changes
 * it. New apps or channels are never implied by "support everything".
 */
import type { AccountRegistry } from '../core/config.ts';
import { validateSchema, type JsonSchema } from '../core/schema.ts';
import { ok, perr, type Result } from '../core/result.ts';

export const SUPPORT_CHANNEL_KINDS = ['in_app', 'support_email', 'website_chat'] as const;
export type SupportChannelKind = (typeof SUPPORT_CHANNEL_KINDS)[number];
export type SupportMode = 'shadow' | 'automatic';

export interface SupportChannel {
  id: string;
  kind: SupportChannelKind;
  /** App slug served by this channel (e.g. "example-app"). */
  app: string;
  /** Registry account the replies are sent from (purpose "support"). Required for support_email. */
  accountId?: string;
  enabled: boolean;
  mode: SupportMode;
  /** Sign-off used by the verbatim composer. */
  signature?: string;
}

export interface SupportApp {
  id: string;
  name: string;
}

export interface SupportConfig {
  enabled: boolean;
  /** Owner-curated knowledge directory (relative paths resolve against POTTS_HOME). */
  knowledgeDir: string;
  /** Minimum classifier confidence for an automatic reply (0.5–0.99). */
  confidenceThreshold: number;
  /** Status knowledge older than this is not used for automatic replies. */
  maxStatusAgeHours?: number;
  apps: SupportApp[];
  channels: SupportChannel[];
}

/** Schema for the `support` config section (mirrored in config/potts.schema.json). */
export const SUPPORT_CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'WP-7 customer support. Disabled and shadow-only by default; automatic replies also need the owner policy (support.mode=active, registeredChannels, approvedKnowledgeIds).',
  required: ['enabled', 'knowledgeDir', 'confidenceThreshold', 'apps', 'channels'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    knowledgeDir: { type: 'string', minLength: 1 },
    confidenceThreshold: { type: 'number', minimum: 0.5, maximum: 0.99 },
    maxStatusAgeHours: { type: 'integer', minimum: 1, maximum: 720 },
    apps: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['id', 'name'],
        additionalProperties: false,
        properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }, name: { type: 'string', minLength: 1, maxLength: 80 } },
      },
    },
    channels: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['id', 'kind', 'app', 'enabled', 'mode'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
          kind: { enum: ['in_app', 'support_email', 'website_chat'] },
          app: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
          accountId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
          enabled: { type: 'boolean' },
          mode: { enum: ['shadow', 'automatic'] },
          signature: { type: 'string', maxLength: 120 },
        },
      },
    },
  },
};

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = { enabled: false, knowledgeDir: 'support-knowledge', confidenceThreshold: 0.8, apps: [], channels: [] };

export interface SupportRegistry {
  readonly config: Readonly<SupportConfig>;
  channel(id: string): SupportChannel | undefined;
  app(id: string): SupportApp | undefined;
  channels(): readonly SupportChannel[];
}

/** Validates the section (schema + cross-references against the account registry). */
export function createSupportRegistry(raw: unknown, accounts: AccountRegistry): Result<SupportRegistry> {
  const cfg = (raw ?? DEFAULT_SUPPORT_CONFIG) as SupportConfig;
  const issues = validateSchema(cfg, SUPPORT_CONFIG_SCHEMA);
  if (issues.length) return perr('config_invalid', `support config invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const apps = new Map(cfg.apps.map((a) => [a.id, a]));
  if (apps.size !== cfg.apps.length) return perr('config_invalid', 'support: duplicate app id');
  const chans = new Map<string, SupportChannel>();
  for (const c of cfg.channels) {
    if (chans.has(c.id)) return perr('config_invalid', `support: duplicate channel ${c.id}`);
    if (!apps.has(c.app)) return perr('config_invalid', `support channel ${c.id}: app ${c.app} is not registered`);
    if (c.kind === 'support_email' && !c.accountId) return perr('config_invalid', `support channel ${c.id}: support_email needs accountId`);
    if (c.accountId) {
      const a = accounts.get(c.accountId);
      if (!a) return perr('config_invalid', `support channel ${c.id}: account ${c.accountId} is not registered`);
      if (a.purpose !== 'support') return perr('config_invalid', `support channel ${c.id}: account ${c.accountId} is not a support-purpose account`);
      if (c.kind === 'support_email' && a.kind !== 'gmail' && a.kind !== 'outlook') return perr('config_invalid', `support channel ${c.id}: support_email needs a gmail/outlook account`);
    }
    // No transport exists for in-app / website chat yet: they may only run in shadow mode.
    if (c.mode === 'automatic' && c.kind !== 'support_email') return perr('config_invalid', `support channel ${c.id}: automatic mode is only available for support_email (no ${c.kind} sender exists)`);
    chans.set(c.id, Object.freeze({ ...c }));
  }
  const frozen = Object.freeze(structuredClone(cfg));
  return ok({
    config: frozen,
    channel: (id) => chans.get(id),
    app: (id) => apps.get(id),
    channels: () => [...chans.values()],
  });
}
