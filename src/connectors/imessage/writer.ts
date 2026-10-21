/**
 * iMessage writer (broker executor). Constructed only by trusted broker
 * startup code; registered only when enabled (default off). Requires the
 * owner to grant the broker process Automation permission for Messages (and
 * Full Disk Access for the read-only chat.db lookup).
 *
 * execute(): guards → osascript with a FIXED AppleScript; the handle and the
 * text are passed as argv (never interpolated into script source), so message
 * text cannot inject AppleScript. Exactly one recipient handle; attachments
 * and group chats are rejected. Errors raised while resolving the
 * account/participant (before `send`) are definitive rejections; anything
 * after that, or a timeout, is uncertain.
 *
 * lookup(): reads chat.db READ-ONLY for an outgoing message to the exact
 * handle with the exact text, dated at/after the intent. Found → found.
 * Not found → "unknown" (never not_found): Messages may still be queueing,
 * and an automatic resend could duplicate. The owner resolves it.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecutorRejectedError, type DispatchIntent, type ExecutorReceipt, type LookupResult } from '../../broker/executor.ts';
import { enforceApproval, verifyMessageIntent, type ApprovalCheck, type WriterIdentity } from '../writers/writer-guard.ts';
import type { WriterExecutor } from '../gmail/writer.ts';
import { findOutgoingMessage } from './writer-chatdb.ts';

/** Fixed script. argv: 1 handle, 2 text, 3 Messages account id ("" = first iMessage account). */
export const IMESSAGE_SEND_SCRIPT = [
  'on run argv',
  'set targetHandle to item 1 of argv',
  'set messageText to item 2 of argv',
  'set accountId to item 3 of argv',
  'tell application "Messages"',
  'try',
  'if accountId is "" then',
  'set targetService to 1st account whose service type = iMessage',
  'else',
  'set targetService to account id accountId',
  'end if',
  'set targetBuddy to participant targetHandle of targetService',
  'on error errMsg number errNum',
  'return "POTTS_REJECT:" & errNum & ":" & errMsg',
  'end try',
  'send messageText to targetBuddy',
  'end tell',
  'return "POTTS_SENT"',
  'end run',
] as const;

export interface OsascriptResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type OsascriptRunner = (args: string[], signal: AbortSignal) => Promise<OsascriptResult>;

export const defaultOsascriptRunner: OsascriptRunner = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', args, { signal, timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return reject(error);
      if (error && typeof (error as { code?: unknown }).code !== 'number') return reject(error);
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface ImessageWriterOptions extends WriterIdentity {
  approvalCheck?: ApprovalCheck;
  runOsascript?: OsascriptRunner;
  /** Messages account id for `account id "..."`; empty → first iMessage account. */
  messagesAccountId?: string;
  /** Path to chat.db for lookup(); default ~/Library/Messages/chat.db (read-only). */
  chatDbPath?: string;
  timeoutMs?: number;
}

export function createImessageWriter(o: ImessageWriterOptions): WriterExecutor {
  const run = o.runOsascript ?? defaultOsascriptRunner;
  const who: WriterIdentity = { accountId: o.accountId, accountAddress: o.accountAddress };
  const chatDbPath = o.chatDbPath ?? join(homedir(), 'Library', 'Messages', 'chat.db');
  return {
    name: `imessage-writer:${o.accountId}`,
    integration: 'imessage',
    kinds: ['send_message'],
    accountId: o.accountId,
    accountAddress: o.accountAddress,
    timeoutMs: o.timeoutMs ?? 60_000,

    async execute(intent: Readonly<DispatchIntent>, signal: AbortSignal): Promise<ExecutorReceipt> {
      if (intent.attachments.length) throw new ExecutorRejectedError('iMessage attachments are not supported');
      const p = verifyMessageIntent(intent, who, { kinds: ['send_message'], channel: 'imessage' });
      enforceApproval(o.approvalCheck, intent);
      const handle = p.to[0]!;
      const args: string[] = [];
      for (const line of IMESSAGE_SEND_SCRIPT) args.push('-e', line);
      args.push(handle, p.body, o.messagesAccountId ?? '');
      let r: OsascriptResult;
      try {
        r = await run(args, signal);
      } catch (e) {
        throw new Error(`osascript did not complete: ${(e as Error).message}; outcome unknown`);
      }
      const out = r.stdout.trim();
      if (out.startsWith('POTTS_REJECT:')) {
        const detail = out.slice('POTTS_REJECT:'.length, 200);
        const hint = detail.startsWith('-1743') ? ' (Automation permission for Messages not granted)' : '';
        throw new ExecutorRejectedError(`Messages refused before sending: ${detail}${hint}`);
      }
      if (r.code !== 0) {
        // Errors before any Apple event (permission prompt denied) are reported as -1743 on stderr.
        if (/-1743|not authori[sz]ed/i.test(r.stderr) && !out) throw new ExecutorRejectedError('Automation permission for Messages not granted; nothing sent');
        throw new Error(`osascript exited ${r.code} after resolving the recipient: outcome unknown (${r.stderr.trim().slice(0, 200)})`);
      }
      if (out !== 'POTTS_SENT') throw new Error(`unexpected osascript output; outcome unknown`);
      return { providerOperationId: `imessage:${intent.idempotencyKey}`, detail: { handle } };
    },

    async lookup(intent: Readonly<DispatchIntent>): Promise<LookupResult> {
      const p = intent.payload as { to?: string[]; body?: string };
      const handle = p.to?.[0];
      if (!handle || typeof p.body !== 'string') return { status: 'unknown', reason: 'intent payload unreadable' };
      const r = findOutgoingMessage({ chatDbPath, handle, text: p.body, sinceIso: intent.createdAt });
      if (r.status === 'found') return { status: 'found', providerOperationId: `imessage:${r.guid}`, detail: { via: 'chat.db' } };
      return { status: 'unknown', reason: r.status === 'error' ? r.reason : r.status === 'failed' ? 'Messages recorded the message with an error; owner should check' : 'no matching outgoing message in chat.db; not resending automatically' };
    },
  };
}
