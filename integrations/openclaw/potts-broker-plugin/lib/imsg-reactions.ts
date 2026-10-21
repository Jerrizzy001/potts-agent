import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { PreciseReactionAdapter, ReactionTarget } from './owner-reactions.ts';

type Row = Record<string, unknown>;
export interface ImsgReactionOptions {
  /** Trusted channel config only. Never accept executable paths in tool arguments. */
  cliPath: string;
  ownerId: string;
  timeoutMs?: number;
}
/** imsg 0.17: status/group JSON objects; history JSONL with current reaction receipts. */
export function createImsgReactionAdapter(o: ImsgReactionOptions): PreciseReactionAdapter {
  if (!isAbsolute(o.cliPath) || !/^\+[1-9]\d{7,14}$/.test(o.ownerId)) throw new Error('Invalid trusted iMessage configuration');
  const run = (args: string[]) => new Promise<Row[]>((resolve, reject) => {
    execFile(o.cliPath, args, { timeout: Math.min(o.timeoutMs ?? 8000, 15000), maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('iMessage command unavailable'));
      try {
        const rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
        if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid response');
        resolve(rows as Row[]);
      } catch { reject(new Error('Invalid iMessage response')); }
    });
  });
  async function ready() {
    try { const rows = await run(['status', '--json']); return rows.length === 1 && rows[0]?.advanced_features === true; } catch { return false; }
  }
  async function lookup(t: ReactionTarget) {
    if (!/^\d{1,16}$/.test(t.conversationId) || !/^[A-Za-z0-9-]{16,128}$/.test(t.messageId)) return null;
    const groups = await run(['group', '--chat-id', t.conversationId, '--json']);
    const g = groups[0];
    if (groups.length !== 1 || !g || String(g.id) !== t.conversationId || g.is_group !== false || g.service !== 'iMessage' || g.identifier !== o.ownerId || typeof g.guid !== 'string' || g.guid !== `iMessage;-;${o.ownerId}` || !Array.isArray(g.participants) || g.participants.length !== 1 || g.participants[0] !== o.ownerId) return null;
    const rows = await run(['history', '--chat-id', t.conversationId, '--limit', '100', '--json']);
    const matches = rows.filter(m => typeof m.guid === 'string' && m.guid.toLowerCase() === t.messageId.toLowerCase());
    const m = matches[0];
    if (matches.length !== 1 || !m || String(m.chat_id) !== t.conversationId || m.is_from_me !== false || m.sender !== o.ownerId || m.is_forwarded === true || m.is_reaction === true || !Array.isArray(m.reactions)) return null;
    const reactions = m.reactions as Row[];
    if (reactions.some(r => !r || typeof r !== 'object' || typeof r.is_from_me !== 'boolean' || typeof r.type !== 'string')) return null;
    return { chatGuid: g.guid, messageGuid: m.guid as string, present: reactions.some(r => r.is_from_me === true && r.type === (t.reaction === 'emphasize' ? 'emphasis' : t.reaction)) };
  }
  return {
    ready,
    async inspect(t) {
      const result = await lookup(t);
      return result ? { ownerId: o.ownerId, isGroup: false, isForwarded: false, present: result.present } : null;
    },
    async set(t, present, assertCurrent) {
      if (!['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'].includes(t.reaction) || typeof present !== 'boolean') throw new Error('Invalid reaction');
      if (!await ready()) throw new Error('Precise reactions unavailable');
      const target = await lookup(t);
      if (!target) throw new Error('Message target could not be verified');
      if (target.present === present) return;
      if (!assertCurrent) throw new Error('Live owner authority unavailable');
      assertCurrent();
      await run(['tapback', '--chat', target.chatGuid, '--message', target.messageGuid, '--kind', t.reaction, '--part', '0', ...(present ? [] : ['--remove']), '--json']);
      // Never retry a write. The durable service also inspects the receipt before reporting success.
      const after = await lookup(t);
      if (!after || after.present !== present) throw new Error('Reaction not confirmed');
    },
  };
}
