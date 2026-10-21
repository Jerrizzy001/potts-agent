import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, type JsonSchema, type SchemaIssue } from './schema.ts';
import { isSecretRef } from './secrets.ts';
import { ok, perr, type Result } from './result.ts';

export const ACCOUNT_KINDS = ['gmail', 'outlook', 'imessage', 'telegram', 'telephony'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_MODES = ['not_connected', 'read_only', 'draft_only', 'approval_required', 'automatic'] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export interface AccountEntry {
  id: string;
  kind: AccountKind;
  /** Exact account identity, e.g. an email address. */
  address: string;
  mode: AccountMode;
  label?: string;
  purpose?: 'personal' | 'support' | 'owner_alert' | 'owner_channel';
  secretRefs?: Record<string, string>;
}

export interface PottsConfig {
  schemaVersion: 1;
  owner: { displayName?: string; channel?: 'telegram' | 'imessage'; imessageOwnerId?: string; telegramOwnerIdRef: string; timezone: string; alertPhoneRef?: string };
  quietHours: { start: string; end: string; messagesToOwner: boolean; callsToOwner: boolean; overnightEmergencyOverride?: boolean };
  briefings: { id: string; time: string; content: string; enabled?: boolean }[];
  accountsFile?: string;
  accounts?: AccountEntry[];
  integrations: { pauseAll: boolean; paused?: Record<string, boolean> };
  policy: { version: string; file: string };
  broker?: { socketPath?: string; ingressSocketPath?: string; ingressKeyRef?: string; executorTimeoutMs?: number };
  [section: string]: unknown;
}

/** Config after loading: accounts are always resolved into one list. */
export interface LoadedConfig extends PottsConfig {
  accounts: AccountEntry[];
  /** Absolute path of the config file it was loaded from (if any). */
  sourcePath?: string;
}

export const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/potts.schema.json');
let cachedSchema: JsonSchema | undefined;
export function loadSchema(): JsonSchema {
  cachedSchema ??= JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as JsonSchema;
  return cachedSchema;
}

const SECRETISH_KEY = /token|secret|passw(or)?d|api[-_]?key|cookie|credential|private[-_]?key/i;

/** Rejects raw secret values anywhere in the document: secret-ish keys must hold references. */
function findRawSecrets(v: unknown, path: string, out: SchemaIssue[]): void {
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`;
      if (typeof val === 'string' && SECRETISH_KEY.test(k) && !/Ref$/.test(k) && !isSecretRef(val)) {
        out.push({ path: p, message: 'looks like a raw secret; use a keychain:/env: reference' });
      }
      findRawSecrets(val, p, out);
    }
  }
}

function semanticChecks(cfg: LoadedConfig): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  cfg.accounts.forEach((a, i) => {
    if (seen.has(a.id)) issues.push({ path: `$.accounts[${i}].id`, message: `duplicate account id "${a.id}"` });
    seen.add(a.id);
  });
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.owner.timezone });
  } catch {
    issues.push({ path: '$.owner.timezone', message: `unknown IANA timezone "${cfg.owner.timezone}"` });
  }
  if (cfg.owner.channel === 'imessage' && !/^\+[1-9]\d{7,14}$/.test(cfg.owner.imessageOwnerId ?? '')) issues.push({ path: '$.owner.imessageOwnerId', message: 'iMessage owner requires an international number' });
  const ids = new Set<string>();
  cfg.briefings.forEach((b, i) => {
    if (ids.has(b.id)) issues.push({ path: `$.briefings[${i}].id`, message: 'duplicate briefing id' });
    ids.add(b.id);
  });
  return issues;
}

/** Validates a parsed config object (accounts inline or already merged). */
export function validateConfig(raw: unknown, accountsDoc?: unknown): Result<LoadedConfig> {
  const schema = loadSchema();
  const issues = validateSchema(raw, schema);
  if (accountsDoc !== undefined) {
    issues.push(...validateSchema(accountsDoc, { $ref: '#/$defs/accountsDocument' }, schema).map((i) => ({ ...i, path: i.path.replace(/^\$/, '$accounts') })));
  }
  findRawSecrets(raw, '$', issues);
  if (accountsDoc !== undefined) findRawSecrets(accountsDoc, '$accounts', issues);
  if (issues.length) return perr('config_invalid', `config invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues });
  const base = raw as PottsConfig;
  if (base.accounts && accountsDoc !== undefined) return perr('config_invalid', 'config has both inline "accounts" and an accounts file');
  const accounts = (accountsDoc as { accounts: AccountEntry[] } | undefined)?.accounts ?? base.accounts ?? [];
  const cfg: LoadedConfig = { ...base, accounts };
  const sem = semanticChecks(cfg);
  if (sem.length) return perr('config_invalid', `config invalid: ${sem.map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues: sem });
  return ok(cfg);
}

/** Reads and validates potts.json (and its accountsFile, resolved relative to it). */
export function loadConfig(path: string): Result<LoadedConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return perr('config_invalid', `cannot read config ${path}: ${(e as Error).message}`);
  }
  let accountsDoc: unknown;
  const af = (raw as PottsConfig | null)?.accountsFile;
  if (typeof af === 'string') {
    const ap = isAbsolute(af) ? af : resolve(dirname(path), af);
    try {
      accountsDoc = JSON.parse(readFileSync(ap, 'utf8'));
    } catch (e) {
      return perr('config_invalid', `cannot read accounts file ${ap}: ${(e as Error).message}`);
    }
  }
  const r = validateConfig(raw, accountsDoc);
  if (r.ok) r.value.sourcePath = resolve(path);
  return r;
}

/** Read-only account lookup used by policy/broker. */
export interface AccountRegistry {
  get(id: string): AccountEntry | undefined;
  list(): readonly AccountEntry[];
}
export function createAccountRegistry(accounts: readonly AccountEntry[]): AccountRegistry {
  const map = new Map(accounts.map((a) => [a.id, Object.freeze({ ...a })]));
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}
