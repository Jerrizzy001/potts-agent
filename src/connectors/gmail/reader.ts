/**
 * Gmail READER. Read-only by construction: every request goes through
 * `readerGet` (GET only) against users.messages.list/get, users.history.list
 * and users.getProfile. There is no send/modify/insert/trash/drafts code path
 * here; writers are WP-7's broker-owned executors.
 */
import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from '../oauth/errors.ts';
import { openReadGate, type ReadGate } from '../oauth/gate.ts';
import { readerGet, realSleep, type FetchLike, type HttpResult, type Sleep } from '../oauth/http.ts';
import type { AccessTokenProvider } from '../oauth/session.ts';
import { GOOGLE_DEFAULTS } from '../oauth/types.ts';
import { chooseBody, decodeBase64Url } from '../mail/body.ts';
import type { MailStore } from '../mail/store.ts';
import { recordFailure, tally, zeroCounts, type MailSyncCounts, type MailSyncResult } from '../mail/sync-common.ts';
import { KEPT_HEADERS, parseAddressList, type MailAttachmentMeta, type NormalizedMail } from '../mail/types.ts';
import { refineWithModel, disabledLocalClassifier, type LocalMailClassifier } from '../mail/local-model.ts';
import { classifyMail, type ClassifierOptions } from '../mail/classify.ts';

export interface GmailReaderOptions {
  accountId: string;
  tokens: AccessTokenProvider;
  store: MailStore;
  clock: Clock;
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Default https://gmail.googleapis.com/gmail/v1 */
  apiBase?: string;
  gate?: ReadGate;
  /** Query for the initial/full sync (default: last 30 days, excluding sent, drafts and chats). */
  fullSyncQuery?: string;
  /** Upper bound on messages fetched by one full sync (default 500). */
  maxFullSyncMessages?: number;
  pageSize?: number;
  maxRetries?: number;
  classifierOptions?: ClassifierOptions;
  localClassifier?: LocalMailClassifier;
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

const SKIP_LABELS = new Set(['SENT', 'DRAFT', 'CHAT']);

function isGmailRateLimit(status: number, body: unknown): boolean {
  if (status !== 403 && status !== 429) return false;
  const e = (body as { error?: { status?: string; errors?: { reason?: string }[] } } | null)?.error;
  return e?.status === 'RESOURCE_EXHAUSTED' || !!e?.errors?.some((x) => x.reason === 'rateLimitExceeded' || x.reason === 'userRateLimitExceeded');
}

function charsetOf(part: GmailPart): string {
  const ct = part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1] ?? 'utf-8';
}

/** Converts a Gmail API message (format=full) to the provider-neutral shape. */
export function normalizeGmailMessage(accountId: string, msg: GmailMessage): NormalizedMail {
  const headers = new Map<string, string>();
  for (const h of msg.payload?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!headers.has(k)) headers.set(k, h.value);
  }
  let text: string | null = null;
  let html: string | null = null;
  const attachments: MailAttachmentMeta[] = [];
  const visit = (p: GmailPart) => {
    const disp = p.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
    const cid = p.headers?.some((h) => h.name.toLowerCase() === 'content-id');
    const isAttachment = !!p.filename || !!p.body?.attachmentId || /^attachment/i.test(disp);
    if (isAttachment && !(p.mimeType ?? '').startsWith('multipart/')) {
      attachments.push({
        name: p.filename || '(unnamed)', mimeType: p.mimeType ?? 'application/octet-stream', size: p.body?.size ?? 0,
        providerAttachmentId: p.body?.attachmentId ?? null, inline: /^inline/i.test(disp) || !!cid,
      });
      return;
    }
    if (p.mimeType === 'text/plain' && text === null && p.body?.data) text = decodeBase64Url(p.body.data, charsetOf(p));
    else if (p.mimeType === 'text/html' && html === null && p.body?.data) html = decodeBase64Url(p.body.data, charsetOf(p));
    for (const c of p.parts ?? []) visit(c);
  };
  if (msg.payload) visit(msg.payload);
  const body = chooseBody({ text, html });
  const kept: Record<string, string> = {};
  for (const k of KEPT_HEADERS) {
    const v = headers.get(k);
    if (v !== undefined) kept[k] = v.slice(0, 2000);
  }
  const from = parseAddressList(headers.get('from'))[0] ?? null;
  return {
    accountId,
    provider: 'gmail',
    providerMessageId: msg.id,
    threadId: msg.threadId ?? null,
    internetMessageId: headers.get('message-id') ?? null,
    from,
    to: parseAddressList(headers.get('to')),
    cc: parseAddressList(headers.get('cc')),
    replyTo: parseAddressList(headers.get('reply-to')),
    subject: headers.get('subject') ?? '',
    snippet: msg.snippet ?? '',
    bodyText: body.bodyText,
    bodySource: body.bodySource,
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    labels: [...(msg.labelIds ?? [])].sort(),
    headers: kept,
    attachments,
    contentFlags: body.contentFlags,
  };
}

export interface GmailReader {
  readonly accountId: string;
  /** Incremental sync via historyId; full sync when there is no cursor or history expired (404). */
  sync(): Promise<MailSyncResult>;
  /** Lists message ids (one page). */
  listMessages(o?: { q?: string; pageToken?: string; maxResults?: number }): Promise<Result<{ ids: string[]; nextPageToken: string | null }, ConnectorError>>;
  getMessage(id: string): Promise<Result<NormalizedMail | null, ConnectorError>>;
}

export function createGmailReader(o: GmailReaderOptions): GmailReader {
  const base = `${o.apiBase ?? GOOGLE_DEFAULTS.gmailApiBase}/users/me`;
  const fetchFn = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const gate = o.gate ?? openReadGate;
  const local = o.localClassifier ?? disabledLocalClassifier;

  async function authedGet(pathAndQuery: string): Promise<Result<HttpResult, ConnectorError>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await o.tokens.getAccessToken(attempt > 0);
      if (!tok.ok) return tok;
      const r = await readerGet(`${base}${pathAndQuery}`, {
        fetch: fetchFn, clock: o.clock, sleep, maxRetries: o.maxRetries ?? 5, isRateLimited: isGmailRateLimit,
        headers: { authorization: `Bearer ${tok.value}` },
      });
      if (!r.ok) return r;
      if (r.value.status === 401 && attempt === 0) continue;
      if (r.value.status === 401) return cerr('stale_auth', 'Gmail rejected a freshly refreshed token (401)', { status: 401 });
      if (r.value.status === 403) {
        const reason = (r.value.body as { error?: { errors?: { reason?: string }[] } } | null)?.error?.errors?.[0]?.reason ?? 'forbidden';
        return cerr(reason === 'insufficientPermissions' ? 'scope_rejected' : 'http_error', `Gmail 403 (${reason})`, { status: 403, providerError: reason });
      }
      return r;
    }
    return cerr('stale_auth', 'unreachable');
  }

  async function getMessage(id: string): Promise<Result<NormalizedMail | null, ConnectorError>> {
    const r = await authedGet(`/messages/${encodeURIComponent(id)}?format=full`);
    if (!r.ok) return r;
    if (r.value.status === 404) return ok(null);
    if (r.value.status !== 200) return cerr('http_error', `Gmail messages.get ${r.value.status}`, { status: r.value.status });
    const msg = r.value.body as GmailMessage;
    if (msg.labelIds?.some((l) => SKIP_LABELS.has(l)) && !msg.labelIds.includes('INBOX')) return ok(null);
    return ok(normalizeGmailMessage(o.accountId, msg));
  }

  async function storeMessage(id: string, c: MailSyncCounts): Promise<ConnectorError | null> {
    const m = await getMessage(id);
    if (!m.ok) return m.error;
    if (m.value === null) {
      c.skipped++;
      return null;
    }
    const h = classifyMail(m.value, o.classifierOptions ?? o.store.classifierOptions);
    const cls = await refineWithModel(m.value, h, local);
    tally(c, o.store.upsert(m.value, cls));
    return null;
  }

  async function listMessages(q: { q?: string; pageToken?: string; maxResults?: number } = {}) {
    const p = new URLSearchParams({ maxResults: String(q.maxResults ?? o.pageSize ?? 100), includeSpamTrash: 'false' });
    if (q.q) p.set('q', q.q);
    if (q.pageToken) p.set('pageToken', q.pageToken);
    const r = await authedGet(`/messages?${p}`);
    if (!r.ok) return r;
    if (r.value.status !== 200) return cerr('http_error', `Gmail messages.list ${r.value.status}`, { status: r.value.status });
    const b = r.value.body as { messages?: { id: string }[]; nextPageToken?: string };
    return ok({ ids: (b.messages ?? []).map((m) => m.id), nextPageToken: b.nextPageToken ?? null });
  }

  async function fullSync(c: MailSyncCounts): Promise<Result<string, ConnectorError>> {
    // Take the history cursor BEFORE listing so changes during the listing are picked up next time.
    const prof = await authedGet('/profile');
    if (!prof.ok) return prof;
    const historyId = (prof.value.body as { historyId?: string } | null)?.historyId;
    if (prof.value.status !== 200 || !historyId) return cerr('invalid_response', `Gmail getProfile ${prof.value.status}`);
    const max = o.maxFullSyncMessages ?? 500;
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await listMessages({ q: o.fullSyncQuery ?? 'newer_than:30d -in:sent -in:drafts -in:chats', ...(pageToken ? { pageToken } : {}) });
      if (!page.ok) return page;
      for (const id of page.value.ids) {
        if (seen.size >= max) break;
        if (seen.has(id)) continue;
        seen.add(id);
        const e = await storeMessage(id, c);
        if (e) return { ok: false, error: e };
      }
      pageToken = page.value.nextPageToken ?? undefined;
    } while (pageToken && seen.size < max);
    return ok(historyId);
  }

  async function incremental(cursor: string, c: MailSyncCounts): Promise<Result<string, ConnectorError> | 'expired'> {
    const added: string[] = [];
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    let newest = cursor;
    do {
      const p = new URLSearchParams({ startHistoryId: cursor, maxResults: '500' });
      p.append('historyTypes', 'messageAdded');
      p.append('historyTypes', 'messageDeleted');
      if (pageToken) p.set('pageToken', pageToken);
      const r = await authedGet(`/history?${p}`);
      if (!r.ok) return r;
      if (r.value.status === 404) return 'expired';
      if (r.value.status !== 200) return cerr('http_error', `Gmail history.list ${r.value.status}`, { status: r.value.status });
      const b = r.value.body as {
        history?: { messagesAdded?: { message: GmailMessage }[]; messagesDeleted?: { message: GmailMessage }[] }[];
        historyId?: string;
        nextPageToken?: string;
      };
      for (const h of b.history ?? []) {
        for (const a of h.messagesAdded ?? []) if (!a.message.labelIds?.some((l) => SKIP_LABELS.has(l))) added.push(a.message.id);
        for (const d of h.messagesDeleted ?? []) deleted.add(d.message.id);
      }
      if (b.historyId) newest = b.historyId;
      pageToken = b.nextPageToken;
    } while (pageToken);
    for (const id of new Set(added)) {
      if (deleted.has(id)) continue;
      const e = await storeMessage(id, c);
      if (e) return { ok: false, error: e };
    }
    for (const id of deleted) if (o.store.markDeleted(o.accountId, id)) c.deleted++;
    return ok(newest);
  }

  return {
    accountId: o.accountId,
    listMessages,
    getMessage,
    async sync() {
      const startedAt = o.clock.nowIso();
      const prev = o.store.getSyncState(o.accountId);
      const c = zeroCounts();
      const g = gate(o.accountId, 'gmail');
      if (!g.ok) return recordFailure(o.store, o.accountId, 'gmail', prev, { code: g.code, message: g.reason }, 'none', startedAt, c);
      let mode: MailSyncResult['mode'] = prev?.cursor ? 'incremental' : 'full';
      let cursorR: Result<string, ConnectorError>;
      if (prev?.cursor) {
        const r = await incremental(prev.cursor, c);
        if (r === 'expired') {
          mode = 'full_after_expiry';
          cursorR = await fullSync(c);
        } else cursorR = r;
      } else cursorR = await fullSync(c);
      if (!cursorR.ok) return recordFailure(o.store, o.accountId, 'gmail', prev, cursorR.error, mode, startedAt, c);
      const now = o.clock.nowIso();
      o.store.setSyncState({
        accountId: o.accountId, provider: 'gmail', cursor: cursorR.value, lastFullSyncAt: mode === 'incremental' ? (prev?.lastFullSyncAt ?? null) : now,
        lastSyncAt: now, lastSuccessAt: now, status: 'ok', statusReason: mode === 'full_after_expiry' ? 'history expired; full resync performed' : null,
      });
      o.store.logSync({ accountId: o.accountId, startedAt, mode, outcome: 'ok', ...c });
      return { accountId: o.accountId, status: 'ok', mode, ...c };
    },
  };
}
