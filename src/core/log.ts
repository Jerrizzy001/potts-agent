import { systemClock, type Clock } from './clock.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always replaced with "[REDACTED]". */
export const SECRET_KEY_PATTERN = /token|secret|passw(or)?d|passphrase|api[-_]?key|private[-_]?key|cookie|authorization|^auth$|credential|otp|session[-_]?id|hmac|signature|^mac$/i;
/** String values that look like secrets regardless of key. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token shape
  /\b(sk|pk|rk|ghp|gho|ghs|xox[bpas])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
export const REDACTED = '[REDACTED]';

/** Deep-copies a value, redacting secret-looking keys and token-shaped strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') {
    let s = value;
    for (const re of SECRET_VALUE_PATTERNS) s = s.replace(re, REDACTED);
    return s;
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Secret *references* (keychain:/env:) are not secrets; keep them visible.
    if (SECRET_KEY_PATTERN.test(k) && !(typeof v === 'string' && /^(keychain|env):/.test(v)) && !/Ref$|Refs$/.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  clock?: Clock;
  level?: LogLevel;
  /** Receives one JSON line per record. Default: stderr. */
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

/** JSON-lines logger. Every record passes through redact() before reaching the sink. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const clock = opts.clock ?? systemClock;
  const min = LEVELS[opts.level ?? 'info'];
  const sink = opts.sink ?? ((line: string) => void process.stderr.write(line + '\n'));
  const bindings = opts.bindings ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const rec = redact({ ...bindings, ...fields, at: clock.nowIso(), level, msg });
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ ...opts, clock, sink, bindings: { ...bindings, ...b } }),
  };
}

/** Logger that discards everything (default for library code in tests). */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
