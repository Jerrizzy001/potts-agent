/**
 * Config section `telephony` and trusted startup wiring. DISABLED by default:
 * with `enabled: false` (or no section) nothing is registered, so the broker
 * holds/denies call_owner_alert (no executor) and no webhook server starts.
 */
import type { AccountRegistry } from '../core/config.ts';
import type { Clock } from '../core/clock.ts';
import type { JsonSchema } from '../core/schema.ts';
import { validateSchema } from '../core/schema.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import type { ExecutorRegistry } from '../broker/executor.ts';
import type { IncidentValidator, OwnerAlertDecider, TelephonyProvider } from './types.ts';
import type { TelephonyStore } from './store.ts';
import { createOwnerAlertExecutor } from './owner-alert.ts';

export interface TelephonyConfig {
  enabled: boolean;
  conversation?: import("./voice.ts").VoiceConfig;
  provider: 'twilio';
  /** Registry account (kind telephony, purpose owner_alert) whose address is the caller number. */
  accountId: string;
  /** Public HTTPS origin that forwards ONLY /telephony/twilio/* to the webhook port. */
  publicBaseUrl: string;
  webhook: { host: string; port: number };
  machineDetection: boolean;
  ringTimeoutSeconds: number;
  twilio: { accountSidRef: string; authTokenRef: string; apiKeySidRef?: string; apiKeySecretRef?: string; voice?: string };
}

/** Mirrored in config/potts.schema.json (properties.telephony). */
export const TELEPHONY_CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'WP-7 owner alert calls. Disabled by default. Not an emergency service. The owner number is owner.alertPhoneRef.',
  required: ['enabled', 'provider', 'accountId', 'publicBaseUrl', 'webhook', 'machineDetection', 'ringTimeoutSeconds', 'twilio'],
  additionalProperties: false,
  properties: {
    conversation: {
      type: 'object', additionalProperties: false, required: ['enabled', 'model', 'baseUrl', 'maxSeconds'],
      properties: { enabled: { type: 'boolean' }, model: { type: 'string', minLength: 1, maxLength: 200 }, baseUrl: { type: 'string', pattern: '^http://(127\\.0\\.0\\.1|localhost):[0-9]+$' }, maxSeconds: { type: 'integer', minimum: 30, maximum: 600 } },
    },
    enabled: { type: 'boolean' },
    provider: { enum: ['twilio'] },
    accountId: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
    publicBaseUrl: { type: 'string', pattern: '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' },
    webhook: {
      type: 'object',
      required: ['host', 'port'],
      additionalProperties: false,
      properties: { host: { enum: ['127.0.0.1', '::1'] }, port: { type: 'integer', minimum: 1024, maximum: 65535 } },
    },
    machineDetection: { type: 'boolean' },
    ringTimeoutSeconds: { type: 'integer', minimum: 10, maximum: 60 },
    twilio: {
      type: 'object',
      required: ['accountSidRef', 'authTokenRef'],
      additionalProperties: false,
      properties: {
        accountSidRef: { $ref: '#/$defs/secretRef' },
        authTokenRef: { $ref: '#/$defs/secretRef' },
        apiKeySidRef: { $ref: '#/$defs/secretRef' },
        apiKeySecretRef: { $ref: '#/$defs/secretRef' },
        voice: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
      },
    },
  },
};

export function validateTelephonyConfig(raw: unknown, accounts: AccountRegistry, schemaRoot: JsonSchema): Result<TelephonyConfig | null> {
  if (raw === undefined || raw === null) return ok(null);
  const issues = validateSchema(raw, TELEPHONY_CONFIG_SCHEMA, schemaRoot);
  if (issues.length) return perr('config_invalid', `telephony config invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const c = raw as TelephonyConfig;
  const acct = accounts.get(c.accountId);
  if (!acct || acct.kind !== 'telephony') return perr('config_invalid', `telephony.accountId ${c.accountId} must be a registered telephony account`);
  if (acct.purpose !== 'owner_alert') return perr('config_invalid', 'telephony account purpose must be owner_alert');
  if (!/^\+[1-9][0-9]{6,14}$/.test(acct.address)) return perr('config_invalid', 'telephony account address must be the E.164 caller number');
  return ok(c);
}

export interface OwnerAlertWiring {
  store: TelephonyStore;
  clock: Clock;
  provider: TelephonyProvider;
  decider: OwnerAlertDecider;
  incidents: IncidentValidator;
  policy: () => LoadedPolicy;
  accounts: AccountRegistry;
  /** Resolves owner.alertPhoneRef (broker-side). */
  ownerNumber: () => Promise<string>;
}

/** Registers the owner-alert executor only when telephony is enabled. Returns the executor name or null. */
export function registerOwnerAlertCalls(registry: ExecutorRegistry, cfg: TelephonyConfig | null, w: OwnerAlertWiring): string | null {
  if (!cfg?.enabled) return null;
  const acct = w.accounts.get(cfg.accountId);
  if (!acct) throw new Error(`telephony account ${cfg.accountId} not registered`);
  const ex = createOwnerAlertExecutor({
    store: w.store, clock: w.clock, decider: w.decider, incidents: w.incidents, provider: w.provider, policy: w.policy,
    accountId: acct.id, fromNumber: acct.address, ownerNumber: w.ownerNumber, publicBaseUrl: cfg.publicBaseUrl,
    machineDetection: cfg.machineDetection, ringTimeoutSeconds: cfg.ringTimeoutSeconds,
  });
  registry.register(ex);
  return ex.name;
}
