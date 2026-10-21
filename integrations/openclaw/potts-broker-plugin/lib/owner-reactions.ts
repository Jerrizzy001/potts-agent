import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export type Reaction = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export interface ReactionTarget { conversationId: string; messageId: string; reaction: Reaction }
export interface ReactionContext {
  messageChannel?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  nativeChannelId?: string;
  assertInvocationCurrent?: () => void;
}
/** Implementations must use exact message GUIDs; never last-message or toggle APIs. */
export interface PreciseReactionAdapter {
  ready(): Promise<boolean>;
  inspect(target: ReactionTarget): Promise<{ ownerId: string; isGroup: boolean; isForwarded: boolean; present: boolean } | null>;
  set(target: ReactionTarget, present: boolean, assertCurrent?: () => void): Promise<void>;
}
export const unavailableReactionAdapter: PreciseReactionAdapter = {
  ready: async () => false,
  inspect: async () => null,
  set: async () => { throw new Error('Precise reactions unavailable'); },
};
export function canUseOwnerReactions(ctx: ReactionContext, ownerId: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(ownerId) && ctx.messageChannel === 'imessage' && ctx.senderIsOwner === true && ctx.requesterSenderId === ownerId && Boolean(ctx.nativeChannelId) && typeof ctx.assertInvocationCurrent === 'function';
}
export type ReactionResult = { status: 'applied' | 'unchanged' | 'unavailable' | 'rejected' | 'uncertain' | 'failed'; message: string };

/** Durable intent before dispatch prevents retries after timeouts/restarts. Reconcile reads only. */
export function createOwnerReactions(path: string, adapter: PreciseReactionAdapter = unavailableReactionAdapter) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS reactions (target TEXT PRIMARY KEY, desired INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)`);
  const locks = new Set<string>();
  return {
    close() { db.close(); },
    async set(ctx: ReactionContext, ownerId: string, target: ReactionTarget, present: boolean): Promise<ReactionResult> {
      if (!canUseOwnerReactions(ctx, ownerId) || target.conversationId !== ctx.nativeChannelId || !/^[A-Za-z0-9-]{16,128}$/.test(target.messageId) || !['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'].includes(target.reaction) || typeof present !== 'boolean') return { status: 'rejected', message: 'I can only react to a verified message in your current private chat.' };
      if (!await adapter.ready()) return { status: 'unavailable', message: 'I can’t reliably react to that exact message with the current connection yet.' };
      const key = JSON.stringify([ownerId, target.conversationId, target.messageId, target.reaction]);
      if (locks.has(key)) return { status: 'uncertain', message: 'That reaction is already being checked.' };
      locks.add(key);
      try {
        const initial = db.prepare('SELECT revision FROM reactions WHERE target = ?').get(key) as { revision: number } | undefined;
        const observed = await adapter.inspect(target);
        if (!observed || observed.ownerId !== ownerId || observed.isGroup || observed.isForwarded) return { status: 'rejected', message: 'I couldn’t verify that message belongs to your private chat.' };
        ctx.assertInvocationCurrent!();
        const row = db.prepare('SELECT desired, state FROM reactions WHERE target = ?').get(key) as { desired: number; state: string } | undefined;
        // Unknown delivery must be reconciled against its original desired state before another mutation.
        if (row && ['pending', 'uncertain'].includes(row.state)) {
          if (observed.present !== Boolean(row.desired)) return { status: 'uncertain', message: 'I’m still unable to confirm the earlier reaction. I haven’t sent another one.' };
          db.prepare("UPDATE reactions SET state = 'applied' WHERE target = ?").run(key);
        }
        if (observed.present === present) return { status: 'unchanged', message: present ? 'That reaction is already there.' : 'That reaction is already removed.' };
        // Cross-process claim: only a settled row may be replaced. No await between guard and claim.
        const claim = db.prepare(`INSERT INTO reactions (target,desired,state,revision) VALUES (?, ?, 'pending', 1) ON CONFLICT(target) DO UPDATE SET desired=excluded.desired, state='pending', revision=reactions.revision+1 WHERE reactions.state NOT IN ('pending','uncertain') AND reactions.revision=?`).run(key, Number(present), initial?.revision ?? -1);
        if (!Number(claim.changes)) return { status: 'uncertain', message: 'That reaction is already being checked.' };
        try {
          await adapter.set(target, present, ctx.assertInvocationCurrent);
          const after = await adapter.inspect(target);
          if (!after || after.ownerId !== ownerId || after.isGroup || after.isForwarded || after.present !== present) throw new Error('unconfirmed');
          db.prepare("UPDATE reactions SET state='applied' WHERE target=?").run(key);
          return { status: 'applied', message: present ? 'Reaction added.' : 'Reaction removed.' };
        } catch {
          db.prepare("UPDATE reactions SET state='uncertain' WHERE target=?").run(key);
          return { status: 'uncertain', message: 'I couldn’t confirm whether the reaction changed. I won’t resend it automatically.' };
        }
      } catch {
        return { status: 'failed', message: 'I couldn’t check that message right now.' };
      } finally { locks.delete(key); }
    },
  };
}
