/**
 * Owner checks for LLM-free command and button handlers.
 *
 * OpenClaw 2026.9.8 facts these checks rely on (verified in the installed
 * runtime, see docs/phase1/boundary-report.md):
 *  - Plugin commands are matched only on the INBOUND message body of a
 *    channel turn (auto-reply commands-plugin handler / Telegram native
 *    command dispatch); model output and tool results are never routed there.
 *  - For Telegram, ctx.from is `telegram:<chatId>` for a private chat and
 *    `telegram:group:<chatId>[...]` for groups; ctx.senderId is the Telegram
 *    from.id resolved by the channel adapter, not message text.
 *  - Internal control-plane callers (Gateway clients) carry
 *    ctx.gatewayClientScopes; a genuine Telegram update does not.
 *  - `senderIsOwner` is only exposed to trusted bundled handlers, so the
 *    owner is identified by comparing senderId with the owner id held in
 *    Potts configuration (never by a flag the host computed for us).
 */
import { TELEGRAM_ID_PATTERN } from './config.ts';

/** The subset of PluginCommandContext this plugin reads. */
export interface CommandContextLike {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  gatewayClientScopes?: string[];
  commandBody: string;
  args?: string;
  from?: string;
  to?: string;
  messageThreadId?: string | number;
  isForwarded?: boolean;
  isGroup?: boolean;
  assertOwnerCurrent?: () => void;
}

/** The subset of TelegramInteractiveHandlerContext this plugin reads. */
export interface CallbackContextLike {
  channel: string;
  callbackId: string;
  conversationId?: string;
  senderId?: string;
  isGroup: boolean;
  isForum?: boolean;
  threadId?: number;
  auth: { isAuthorizedSender: boolean };
  callback: { data: string; namespace: string; payload: string; messageId: number; chatId: string; messageText?: string };
}

export type GuardResult = { ok: true; senderId: string; chatId: string } | { ok: false; reason: string };

export function checkOwnerCommand(ctx: CommandContextLike, ownerId: string | null, channel: 'telegram' | 'imessage' = 'telegram'): GuardResult {
  if (!ownerId || !(channel === 'imessage' ? /^\+[1-9]\d{7,14}$/ : TELEGRAM_ID_PATTERN).test(ownerId)) return { ok: false, reason: 'owner_not_configured' };
  if (ctx.channel !== channel) return { ok: false, reason: 'wrong_channel' };
  if (ctx.gatewayClientScopes?.length) return { ok: false, reason: 'internal_caller' };
  if (ctx.isAuthorizedSender !== true) return { ok: false, reason: 'not_authorized_sender' };
  if (ctx.senderId !== ownerId) return { ok: false, reason: 'not_owner' };
  if (ctx.isForwarded === true || ctx.isGroup === true) return { ok: false, reason: 'not_private_chat' };
  // Current iMessage adapter labels DMs by their resolved service, or auto.
  const allowedFrom = channel === 'imessage' ? [`imessage:${ownerId}`, `auto:${ownerId}`, `sms:${ownerId}`] : [`telegram:${ownerId}`];
  if (!allowedFrom.includes(ctx.from ?? '')) return { ok: false, reason: 'not_private_chat' };
  return { ok: true, senderId: ownerId, chatId: ownerId };
}

export function checkOwnerCallback(ctx: CallbackContextLike, ownerId: string | null): GuardResult {
  if (!ownerId || !TELEGRAM_ID_PATTERN.test(ownerId)) return { ok: false, reason: 'owner_not_configured' };
  if (ctx.channel !== 'telegram') return { ok: false, reason: 'wrong_channel' };
  if (ctx.isGroup !== false || ctx.isForum === true) return { ok: false, reason: 'not_private_chat' };
  if (ctx.auth?.isAuthorizedSender !== true) return { ok: false, reason: 'not_authorized_sender' };
  if (typeof ctx.senderId !== 'string' || ctx.senderId !== ownerId) return { ok: false, reason: 'not_owner' };
  if (String(ctx.callback?.chatId) !== ownerId) return { ok: false, reason: 'not_private_chat' };
  if (typeof ctx.callbackId !== 'string' || !ctx.callbackId) return { ok: false, reason: 'missing_update_id' };
  return { ok: true, senderId: ownerId, chatId: ownerId };
}

/** Bounded set of recently seen update references (defence in depth; the broker's ingress_consumed table is authoritative). */
export function createReplayCache(max = 2048) {
  const seen = new Map<string, true>();
  return {
    /** Returns false if `ref` was seen before. */
    claim(ref: string): boolean {
      if (seen.has(ref)) return false;
      seen.set(ref, true);
      if (seen.size > max) seen.delete(seen.keys().next().value as string);
      return true;
    },
  };
}
export type ReplayCache = ReturnType<typeof createReplayCache>;
