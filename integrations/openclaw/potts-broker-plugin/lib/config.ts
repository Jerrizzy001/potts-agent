/**
 * Plugin configuration (plugins.entries.potts-broker.config in openclaw.json).
 * Holds paths and secret REFERENCES only. Every owner-control path fails
 * closed when the owner id or the ingress key cannot be resolved.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PluginConfigInput {
  learningEnabled?: boolean;
  learningDirectory?: string;
  deliveryChannel?: 'telegram' | 'imessage';
  deliveryTarget?: string;
  coordinatorAgentId?: string;
  coordinatorEnabled?: boolean;
  pottsHome?: string;
  brokerSocket?: string;
  ingressSocket?: string;
  /** Read-only socket served by the Potts daemon (WP-8) for memory/drafts/briefings. Optional. */
  readSocket?: string;
  /** Owner-control socket for memory forget (WP-3/WP-8). Optional. */
  memoryControlSocket?: string;
  /** Numeric Telegram user id of the owner (not a secret) ... */
  ownerTelegramId?: string;
  /** ... or a reference to it (keychain:<service>/<account> | env:NAME). */
  ownerTelegramIdRef?: string;
  /** Reference to the ingress HMAC key (default keychain:potts/ingress-hmac-key). */
  ingressKeyRef?: string;
  /** Owner commands + approval buttons. Default true (they still fail closed without owner id/key). */
  ownerControls?: boolean;
  /** Agent tools. Default true. */
  agentTools?: boolean;
  /** Agent label appended to the broker actor ("openclaw/<label>"). */
  agentLabel?: string;
  /** OwnerChannel service for daemon → owner notifications. Default false. */
  ownerChannel?: boolean;
  ownerChannelSocket?: string;
  /** Telegram account id for multi-account setups (optional). */
  telegramAccountId?: string;
}

export interface PluginConfig {
  learningEnabled?: boolean;
  learningDirectory?: string;
  deliveryChannel?: 'telegram' | 'imessage';
  deliveryTarget?: string;
  coordinatorAgentId: string;
  coordinatorEnabled: boolean;
  pottsHome: string;
  brokerSocket: string;
  ingressSocket: string;
  readSocket: string | null;
  memoryControlSocket: string | null;
  ownerTelegramId: string | null;
  ownerTelegramIdRef: string | null;
  ingressKeyRef: string;
  ownerControls: boolean;
  agentTools: boolean;
  agentLabel: string;
  ownerChannel: boolean;
  ownerChannelSocket: string;
  telegramAccountId: string | null;
}

export const SECRET_REF_PATTERN = /^(keychain:[^/\s]+\/[^\s]+|env:[A-Z_][A-Z0-9_]*)$/;
export const TELEGRAM_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export function defaultPottsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.POTTS_HOME || join(homedir(), 'Library', 'Application Support', 'Potts');
}

export function parsePluginConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; value: PluginConfig } | { ok: false; error: string } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as PluginConfigInput;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const home = str(c.pottsHome) ?? defaultPottsHome(env);
  if (c.deliveryChannel && !['telegram', 'imessage'].includes(c.deliveryChannel)) return { ok: false, error: 'invalid deliveryChannel' };
  if (c.deliveryChannel === 'imessage' && !/^\+[1-9]\d{7,14}$/.test(c.deliveryTarget ?? '')) return { ok: false, error: 'iMessage deliveryTarget must be an international owner number' };
  const ownerId = str(c.ownerTelegramId) ?? null;
  if (ownerId !== null && !TELEGRAM_ID_PATTERN.test(ownerId)) return { ok: false, error: 'ownerTelegramId must be a numeric Telegram user id' };
  const ownerRef = str(c.ownerTelegramIdRef) ?? (ownerId ? null : 'keychain:potts/telegram-owner-id');
  if (ownerRef !== null && !SECRET_REF_PATTERN.test(ownerRef)) return { ok: false, error: 'ownerTelegramIdRef must be keychain:<service>/<account> or env:NAME' };
  const keyRef = str(c.ingressKeyRef) ?? 'keychain:potts/ingress-hmac-key';
  if (!SECRET_REF_PATTERN.test(keyRef)) return { ok: false, error: 'ingressKeyRef must be keychain:<service>/<account> or env:NAME' };
  const label = str(c.agentLabel) ?? 'potts';
  const coordinatorAgentId = str(c.coordinatorAgentId) ?? 'main';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(coordinatorAgentId)) return { ok: false, error: 'invalid coordinatorAgentId' };
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(label)) return { ok: false, error: 'agentLabel must match [A-Za-z0-9_.:-]{1,64}' };
  return {
    ok: true,
    value: {
      learningEnabled: c.learningEnabled === true,
      learningDirectory: str(c.learningDirectory) ?? join(home, 'memory', 'learning'),
      deliveryChannel: c.deliveryChannel ?? 'telegram',
      ...(c.deliveryTarget ? { deliveryTarget: c.deliveryTarget } : {}),
      coordinatorAgentId, coordinatorEnabled: c.coordinatorEnabled === true,
      pottsHome: home,
      brokerSocket: str(c.brokerSocket) ?? join(home, 'run', 'broker.sock'),
      ingressSocket: str(c.ingressSocket) ?? join(home, 'run', 'ingress.sock'),
      readSocket: str(c.readSocket) ?? null,
      memoryControlSocket: str(c.memoryControlSocket) ?? null,
      ownerTelegramId: ownerId,
      ownerTelegramIdRef: ownerRef,
      ingressKeyRef: keyRef,
      ownerControls: c.ownerControls !== false,
      agentTools: c.agentTools !== false,
      agentLabel: label,
      ownerChannel: c.ownerChannel === true,
      ownerChannelSocket: str(c.ownerChannelSocket) ?? join(home, 'run', 'owner-channel.sock'),
      telegramAccountId: str(c.telegramAccountId) ?? null,
    },
  };
}

export type KeychainLookup = (service: string, account: string) => Promise<string>;

export function defaultKeychainLookup(service: string, account: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(new Error('keychain lookup failed'));
      else resolve(String(stdout).replace(/\n$/, ''));
    });
  });
}

/** Resolves a secret reference. The value is never logged or returned to the model. */
export async function resolveRef(ref: string, deps: { env?: NodeJS.ProcessEnv; keychain?: KeychainLookup } = {}): Promise<string | null> {
  if (!SECRET_REF_PATTERN.test(ref)) return null;
  if (ref.startsWith('env:')) return (deps.env ?? process.env)[ref.slice(4)] || null;
  const rest = ref.slice('keychain:'.length);
  const slash = rest.indexOf('/');
  try {
    const v = await (deps.keychain ?? defaultKeychainLookup)(rest.slice(0, slash), rest.slice(slash + 1));
    return v || null;
  } catch {
    return null;
  }
}

/** Owner id + ingress key, resolved lazily and cached for the plugin's lifetime. */
export interface OwnerSecrets {
  ownerId: string;
  key: Buffer;
}

export function createSecretsProvider(cfg: PluginConfig, deps: { env?: NodeJS.ProcessEnv; keychain?: KeychainLookup } = {}) {
  let cached: Promise<OwnerSecrets | null> | null = null;
  const load = async (): Promise<OwnerSecrets | null> => {
    const ownerId = cfg.deliveryChannel === 'imessage' ? cfg.deliveryTarget
      : cfg.ownerTelegramId ?? (cfg.ownerTelegramIdRef ? await resolveRef(cfg.ownerTelegramIdRef, deps) : null);
    if (!ownerId || !(cfg.deliveryChannel === 'imessage' ? /^\+[1-9]\d{7,14}$/ : TELEGRAM_ID_PATTERN).test(ownerId)) return null;
    const key = await resolveRef(cfg.ingressKeyRef, deps);
    if (!key || Buffer.byteLength(key, 'utf8') < 32) return null;
    return { ownerId, key: Buffer.from(key, 'utf8') };
  };
  return {
    /** Returns null (fail closed) when either secret is missing or malformed. Failures are retried on the next call. */
    async get(): Promise<OwnerSecrets | null> {
      cached ??= load();
      const v = await cached;
      if (!v) cached = null;
      return v;
    },
  };
}
export type SecretsProvider = ReturnType<typeof createSecretsProvider>;
