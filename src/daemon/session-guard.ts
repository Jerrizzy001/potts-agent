/**
 * Session guard: automatic recovery when the owner's Telegram chat wedges on context.
 *
 * OpenClaw's own overflow recovery (compact, truncate tool results, retry) handles most cases.
 * When it cannot (e.g. one oversized turn that compaction cannot split), every new message fails
 * with "Agent couldn't generate a response". This guard watches the gateway log; after a failed
 * owner turn that shows a context signal, it resets the owner session and re-sends the owner's
 * last message into the fresh session so the reply still arrives. Durable facts live in the
 * workspace memory files, so a reset loses only the raw transcript (OpenClaw archives it).
 *
 * Loop safety: at most one recovery per cooldown window, each failed message is handled once,
 * and a replay that itself fails is not retried.
 *
 * The owner's chat may be bound to a different agent than `main` (the Qwen coordinator), so the
 * guard resolves the target (agent, session key, transcript database) on every tick.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';

export interface CliResult { code: number; stdout: string; stderr: string }

export interface OwnerSessionTarget { agentId: string; sessionKey: string; agentDbPath: string }

export interface SessionGuardDeps {
  logPath: string;
  owner(): OwnerSessionTarget;
  runCli(args: string[], timeoutMs: number): Promise<CliResult>;
  clock: Clock;
  log: Logger;
  cooldownMs?: number;
}

export interface OverflowFailure { messageId: string; line: number }

const CONTEXT_SIGNALS = [
  /incomplete turn detected.*stopReason=length/,
  /context-pressure-diagnostic/,
  /context-overflow/,
  /Auto-compaction failed/,
  /overflow_unrecoverable/,
  /Input does not fit in context length/,
  /Context is too large/,
];

/** Pure: the agent the owner's Telegram DM is bound to in openclaw.json (`main` when unbound). */
export function ownerAgentId(openclawConfig: unknown, ownerId: string): string {
  const bindings = (openclawConfig as { bindings?: unknown } | null)?.bindings;
  if (!Array.isArray(bindings)) return 'main';
  for (const b of bindings as { agentId?: unknown; match?: { channel?: unknown; peer?: { kind?: unknown; id?: unknown } } }[]) {
    const m = b?.match;
    if (m?.channel === 'telegram' && m.peer?.kind === 'direct' && String(m.peer.id) === ownerId && typeof b.agentId === 'string' && /^[a-z0-9_-]+$/i.test(b.agentId)) return b.agentId;
  }
  return 'main';
}

/** Pure: failed owner turns in `lines` that were preceded (within `window` lines) by a context signal. */
export function findOverflowFailures(lines: string[], sessionKey: string, window = 80): OverflowFailure[] {
  const out: OverflowFailure[] = [];
  const needle = `sessionKey=${sessionKey} `;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.includes('message processed: channel=telegram') || !l.includes(needle) || !l.includes('outcome=error')) continue;
    const id = /messageId=(\d+)/.exec(l)?.[1];
    if (!id) continue;
    let from = Math.max(0, i - window);
    for (let j = i - 1; j >= from; j--) if (lines[j]!.includes('message processed:')) { from = j + 1; break; } // only this turn's lines
    const ctx = lines.slice(from, i);
    if (ctx.some((c) => CONTEXT_SIGNALS.some((re) => re.test(c)))) out.push({ messageId: id, line: i });
  }
  return out;
}

/** Last owner-authored text in the session transcript (read-only), optionally for a specific Telegram message id. */
export function lastOwnerMessage(agentDbPath: string, sessionKey: string, messageId?: string): string | null {
  if (!existsSync(agentDbPath)) return null;
  const db = new DatabaseSync(agentDbPath, { readOnly: true });
  try {
    const w = db.prepare('SELECT session_id FROM session_windows WHERE session_key = ?').get(sessionKey) as { session_id: string } | undefined;
    if (!w) return null;
    const rows = db.prepare('SELECT event_json FROM transcript_events WHERE session_id = ? AND event_json IS NOT NULL ORDER BY seq DESC LIMIT 400').all(w.session_id) as { event_json: string }[];
    for (const r of rows) {
      let e: { message?: { role?: string; content?: unknown; __openclaw?: { senderIsOwner?: boolean; transport?: { messageId?: string } } } };
      try { e = JSON.parse(r.event_json); } catch { continue; }
      const m = e.message;
      if (m?.role !== 'user' || m.__openclaw?.senderIsOwner !== true) continue;
      if (messageId && m.__openclaw?.transport?.messageId && m.__openclaw.transport.messageId !== messageId) continue;
      const text = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ') : '';
      if (text.trim()) return text.trim().slice(0, 4000);
    }
    return null;
  } finally {
    db.close();
  }
}

export function createSessionGuard(d: SessionGuardDeps) {
  const cooldownMs = d.cooldownMs ?? 10 * 60_000;
  let offset: number | null = null;
  let carry = '';
  let lastRecoveryMs = -Infinity;
  const handled = new Set<string>();

  function readNewLines(): string[] {
    if (!existsSync(d.logPath)) return [];
    const size = statSync(d.logPath).size;
    if (offset === null || size < offset) { offset = size; carry = ''; return []; } // start at the end; rotation resets
    if (size === offset) return [];
    const fd = openSync(d.logPath, 'r');
    try {
      const len = Math.min(size - offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      offset = size;
      const text = carry + buf.toString('utf8');
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      return parts;
    } finally {
      closeSync(fd);
    }
  }

  async function recover(f: OverflowFailure, owner: OwnerSessionTarget): Promise<'reset_and_replayed' | 'reset_only' | 'reset_failed'> {
    const text = lastOwnerMessage(owner.agentDbPath, owner.sessionKey, f.messageId);
    const reset = await d.runCli(['gateway', 'call', 'sessions.reset', '--params', JSON.stringify({ key: owner.sessionKey }), '--json'], 60_000);
    if (reset.code !== 0 || !/"ok"\s*:\s*true/.test(reset.stdout)) {
      d.log.warn('session-guard: reset failed', { code: reset.code, stderr: reset.stderr.slice(0, 300) });
      return 'reset_failed';
    }
    if (!text) return 'reset_only';
    const replay = await d.runCli(['agent', '--session-key', owner.sessionKey, '--agent', owner.agentId, '--deliver', '--timeout', '300', '-m', text], 330_000);
    if (replay.code !== 0) d.log.warn('session-guard: replay failed', { code: replay.code, stderr: replay.stderr.slice(0, 300) });
    return 'reset_and_replayed';
  }

  return {
    /** One scheduler tick. Returns what it did, for the job detail. */
    async tick(): Promise<{ checked: number; recovered?: string; skipped?: string }> {
      const lines = readNewLines();
      const owner = d.owner();
      const failures = findOverflowFailures(lines, owner.sessionKey).filter((f) => !handled.has(f.messageId));
      if (!failures.length) return { checked: lines.length };
      for (const f of failures) handled.add(f.messageId);
      const now = d.clock.nowMs();
      if (now - lastRecoveryMs < cooldownMs) {
        d.log.warn('session-guard: overflow failure inside cooldown; not resetting again', { messageId: failures.at(-1)!.messageId });
        return { checked: lines.length, skipped: 'cooldown' };
      }
      lastRecoveryMs = now;
      const outcome = await recover(failures.at(-1)!, owner);
      d.log.info('session-guard: recovered owner session', { outcome, messageId: failures.at(-1)!.messageId });
      return { checked: lines.length, recovered: outcome };
    },
  };
}
