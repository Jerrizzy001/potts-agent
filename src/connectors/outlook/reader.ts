/**
 * Outlook (Microsoft Graph) READER. Read-only by construction: only GETs on
 * /me/messages, /me/mailFolders/inbox/messages/delta and message attachment
 * metadata. No sendMail/reply/createReply/move/PATCH/DELETE code path exists
 * here; writers are WP-7's broker-owned executors.
 */
import type { Clock } from '../../core/clock.ts';
import { ok, type Result } from '../../core/result.ts';
import { cerr, type ConnectorError } from '../oauth/errors.ts';
import { openReadGate, type ReadGate } from '../oauth/gate.ts';
import { readerGet, realSleep, type FetchLike, type HttpResult, type Sleep } from '../oauth/http.ts';
import { classifyMicrosoftError } from '../oauth/microsoft.ts';
import type { AccessTokenProvider } from '../oauth/session.ts';
import type { AccountStatusStore } from '../oauth/status.ts';
import { MICROSOFT_DEFAULTS } from '../oauth/types.ts';
import { chooseBody } from '../mail/body.ts';
import { classifyMail, type ClassifierOptions } from '../mail/classify.ts';
import { disabledLocalClassifier, refineWithModel, type LocalMailClassifier } from '../mail/local-model.ts';
import type { MailStore } from '../mail/store.ts';
import { recordFailure, tally, zeroCounts, type MailSyncCounts, type MailSyncResult } from '../mail/sync-common.ts';
import { KEPT_HEADERS, type MailAddress, type MailAttachmentMeta, type NormalizedMail } from '../mail/types.ts';

export interface OutlookReaderOptions {
  accountId: string;
  tokens: AccessTokenProvider;
  store: MailStore;
  clock: Clock;
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Default https://graph.microsoft.com/v1.0 */
  graphBase?: string;
  gate?: ReadGate;
  /** When set, admin-consent blockers found by Graph calls are recorded on the account. */
  statusStore?: AccountStatusStore;
  /** Initial delta window (default 30 days). */
  initialWindowDays?: number;
  pageSize?: number;
  maxRetries?: number;
  classifierOptions?: ClassifierOptions;
  localClassifier?: LocalMailClassifier;
}

export const GRAPH_MESSAGE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'bodyPreview', 'body', 'from', 'toRecipients', 'ccRecipients', 'replyTo',
  'receivedDateTime', 'hasAttachments', 'categories', 'internetMessageHeaders', 'isDraft',
].join(',');

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: 'text' | 'html'; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  receivedDateTime?: string;
  hasAttachments?: boolean;
  categories?: string[];
  internetMessageHeaders?: { name: string; value: string }[];
  isDraft?: boolean;
  '@removed'?: { reason?: string };
}

const addr = (r: GraphRecipient | undefined): MailAddress | null =>
  r?.emailAddress?.address ? { address: r.emailAddress.address.toLowerCase(), name: r.emailAddress.name ?? null } : null;
const addrs = (rs: GraphRecipient[] | undefined): MailAddress[] => (rs ?? []).map(addr).filter((x): x is MailAddress => x !== null);

export function normalizeGraphMessage(accountId: string, m: GraphMessage, attachments: MailAttachmentMeta[]): NormalizedMail {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) {
    const k = h.name.toLowerCase();
    if ((KEPT_HEADERS as readonly string[]).includes(k) && headers[k] === undefined) headers[k] = h.value.slice(0, 2000);
  }
  const isHtml = m.body?.contentType === 'html';
  const body = chooseBody(isHtml ? { html: m.body?.content ?? '' } : { text: m.body?.content ?? '' });
  return {
    accountId,
    provider: 'outlook',
    providerMessageId: m.id,
    threadId: m.conversationId ?? null,
    internetMessageId: m.internetMessageId ?? null,
    from: addr(m.from),
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    replyTo: addrs(m.replyTo),
    subject: m.subject ?? '',
    snippet: m.bodyPreview ?? '',
    bodyText: body.bodyText,
    bodySource: body.bodySource,
    receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime).toISOString() : null,
    labels: [...(m.categories ?? [])].sort(),
    headers,
    attachments,
    contentFlags: body.contentFlags,
  };
}

export interface OutlookReader {
  readonly accountId: string;
  /** Delta sync of the inbox; deltaLink persisted as the cursor; 410 → full resync. */
  sync(): Promise<MailSyncResult>;
  /** One page of /me/messages (newest first). */
  listMessages(o?: { nextLink?: string; top?: number }): Promise<Result<{ messages: NormalizedMail[]; nextLink: string | null }, ConnectorError>>;
}

export function createOutlookReader(o: OutlookReaderOptions): OutlookReader {
  const base = o.graphBase ?? MICROSOFT_DEFAULTS.graphBase;
  const baseHost = new URL(base).host;
  const fetchFn = o.fetch ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const gate = o.gate ?? openReadGate;
  const local = o.localClassifier ?? disabledLocalClassifier;

  const blocker = (e: ConnectorError) => {
    if (e.code === 'admin_consent_required' && o.statusStore) {
      const prev = o.statusStore.get(o.accountId);
      o.statusStore.set({ accountId: o.accountId, provider: 'microsoft', status: 'admin_consent_required', statusReason: e.message, consentedAddress: prev?.consentedAddress ?? null, scopes: prev?.scopes ?? null });
    }
    return e;
  };

  async function authedGet(url: string): Promise<Result<HttpResult, ConnectorError>> {
    // Never send the bearer token to a host other than Graph (nextLink/deltaLink are server-provided URLs).
    if (new URL(url).host !== baseHost) return cerr('invalid_response', 'refusing to follow a link outside Microsoft Graph');
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await o.tokens.getAccessToken(attempt > 0);
      if (!tok.ok) return tok;
      const r = await readerGet(url, {
        fetch: fetchFn, clock: o.clock, sleep, maxRetries: o.maxRetries ?? 5,
        headers: { authorization: `Bearer ${tok.value}`, prefer: `odata.maxpagesize=${o.pageSize ?? 50}` },
      });
      if (!r.ok) return r;
      if (r.value.status === 401 && attempt === 0) continue;
      if (r.value.status === 401 || r.value.status === 403) {
        const ge = (r.value.body as { error?: { code?: string; message?: string } } | null)?.error;
        const ms = classifyMicrosoftError(r.value.status, { error: ge?.code ?? '', error_description: ge?.message ?? '' });
        if (ms.code === 'admin_consent_required') return { ok: false, error: blocker(ms) };
        if (r.value.status === 401) return cerr('stale_auth', 'Graph rejected a freshly refreshed token (401)', { status: 401 });
        return cerr('http_error', `Graph 403 (${ge?.code ?? 'forbidden'})`, { status: 403, ...(ge?.code ? { providerError: ge.code } : {}) });
      }
      return r;
    }
    return cerr('stale_auth', 'unreachable');
  }

  async function attachmentsOf(m: GraphMessage): Promise<Result<MailAttachmentMeta[], ConnectorError>> {
    if (!m.hasAttachments) return ok([]);
    // $select excludes contentBytes: metadata only, nothing is downloaded.
    const r = await authedGet(`${base}/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
    if (!r.ok) return r;
    if (r.value.status === 404) return ok([]);
    if (r.value.status !== 200) return cerr('http_error', `Graph attachments ${r.value.status}`, { status: r.value.status });
    const v = (r.value.body as { value?: { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean }[] }).value ?? [];
    return ok(v.map((a) => ({ name: a.name ?? '(unnamed)', mimeType: a.contentType ?? 'application/octet-stream', size: a.size ?? 0, providerAttachmentId: a.id, inline: !!a.isInline })));
  }

  async function storeMessage(m: GraphMessage, c: MailSyncCounts): Promise<ConnectorError | null> {
    if (m.isDraft) {
      c.skipped++;
      return null;
    }
    const at = await attachmentsOf(m);
    if (!at.ok) return at.error;
    const n = normalizeGraphMessage(o.accountId, m, at.value);
    const cls = await refineWithModel(n, classifyMail(n, o.classifierOptions ?? o.store.classifierOptions), local);
    tally(c, o.store.upsert(n, cls));
    return null;
  }

  function initialDeltaUrl(): string {
    const since = new Date(o.clock.nowMs() - (o.initialWindowDays ?? 30) * 86_400_000).toISOString();
    const p = new URLSearchParams({ $select: GRAPH_MESSAGE_SELECT, $filter: `receivedDateTime ge ${since}` });
    return `${base}/me/mailFolders/inbox/messages/delta?${p}`;
  }

  async function runDelta(start: string, c: MailSyncCounts): Promise<Result<string, ConnectorError> | 'resync'> {
    let url: string | null = start;
    while (url) {
      const r = await authedGet(url);
      if (!r.ok) return r;
      if (r.value.status === 410) return 'resync';
      if (r.value.status !== 200) {
        const code = (r.value.body as { error?: { code?: string } } | null)?.error?.code ?? '';
        if (/syncStateNotFound|resyncRequired|SyncStateInvalid/i.test(code)) return 'resync';
        return cerr('http_error', `Graph delta ${r.value.status}${code ? ` (${code})` : ''}`, { status: r.value.status });
      }
      const b = r.value.body as { value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
      for (const m of b.value ?? []) {
        if (m['@removed']) {
          if (o.store.markDeleted(o.accountId, m.id)) c.deleted++;
          continue;
        }
        const e = await storeMessage(m, c);
        if (e) return { ok: false, error: e };
      }
      if (b['@odata.deltaLink']) return ok(b['@odata.deltaLink']);
      url = b['@odata.nextLink'] ?? null;
    }
    return cerr('invalid_response', 'delta ended without a deltaLink');
  }

  return {
    accountId: o.accountId,
    async listMessages(q = {}) {
      const url = q.nextLink ?? `${base}/me/messages?${new URLSearchParams({ $select: GRAPH_MESSAGE_SELECT, $top: String(q.top ?? 25), $orderby: 'receivedDateTime desc' })}`;
      const r = await authedGet(url);
      if (!r.ok) return r;
      if (r.value.status !== 200) return cerr('http_error', `Graph messages ${r.value.status}`, { status: r.value.status });
      const b = r.value.body as { value?: GraphMessage[]; '@odata.nextLink'?: string };
      const out: NormalizedMail[] = [];
      for (const m of b.value ?? []) {
        const at = await attachmentsOf(m);
        if (!at.ok) return at;
        out.push(normalizeGraphMessage(o.accountId, m, at.value));
      }
      return ok({ messages: out, nextLink: b['@odata.nextLink'] ?? null });
    },
    async sync() {
      const startedAt = o.clock.nowIso();
      const prev = o.store.getSyncState(o.accountId);
      const c = zeroCounts();
      const g = gate(o.accountId, 'outlook');
      if (!g.ok) return recordFailure(o.store, o.accountId, 'outlook', prev, { code: g.code, message: g.reason }, 'none', startedAt, c);
      let mode: MailSyncResult['mode'] = prev?.cursor ? 'incremental' : 'full';
      let r = await runDelta(prev?.cursor ?? initialDeltaUrl(), c);
      if (r === 'resync') {
        mode = 'full_after_expiry';
        r = await runDelta(initialDeltaUrl(), c);
        if (r === 'resync') r = cerr('invalid_response', 'Graph demanded a resync of a fresh delta');
      }
      if (!r.ok) return recordFailure(o.store, o.accountId, 'outlook', prev, r.error, mode, startedAt, c);
      const now = o.clock.nowIso();
      o.store.setSyncState({
        accountId: o.accountId, provider: 'outlook', cursor: r.value, lastFullSyncAt: mode === 'incremental' ? (prev?.lastFullSyncAt ?? null) : now,
        lastSyncAt: now, lastSuccessAt: now, status: 'ok', statusReason: mode === 'full_after_expiry' ? 'delta token expired; full resync performed' : null,
      });
      o.store.logSync({ accountId: o.accountId, startedAt, mode, outcome: 'ok', ...c });
      return { accountId: o.accountId, status: 'ok', mode, ...c };
    },
  };
}
