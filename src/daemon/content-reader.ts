/** Narrow local retrieval for the conversation model. No arbitrary paths, network or writes. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { ok, perr } from '../core/result.ts';
import type { AccountEntry } from '../core/config.ts';
import type { ControlSnapshot } from '../broker/broker.ts';
import type { MailStore } from '../connectors/mail/store.ts';
import type { DraftWorkspace } from '../drafts/workspace.ts';
import { detectSensitive } from '../memory/sensitive.ts';

export interface ContentDeps {
  home: string; clock: Clock; accounts: AccountEntry[]; controls(): ControlSnapshot;
  mail: MailStore; drafts: DraftWorkspace | null;
}
const text = (v: string, max = 8000) => detectSensitive(v).reasons.some(r => ['credential', 'otp_code', 'secret_token', 'token_url'].includes(r)) ? '[Credential-bearing content withheld]' : v.slice(0, max);
export function contentReader(d: ContentDeps) {
  return (p: Record<string, unknown>) => {
    const c = d.controls();
    if (c.globalPaused) return perr('paused', 'all integrations paused');
    const kind = p.kind;
    if (kind === 'draft') {
      if (c.pausedIntegrations.includes('drafts')) return perr('paused', 'drafts paused');
      if (typeof p.id !== 'string' || !/^drf_[A-Za-z0-9]+$/.test(p.id)) return perr('invalid_input', 'draft id required');
      const draft = d.drafts?.get(p.id);
      if (!draft || !d.drafts) return perr('not_found', 'draft not found');
      return ok({ title: draft.title, kind: draft.kind, status: draft.status, content: text(d.drafts.read(draft.id), 16000), path: join(d.drafts.dir, draft.filePath), unresolved: draft.unresolved });
    }
    if (kind === 'style') {
      if (c.pausedIntegrations.includes('imessage')) return perr('paused', 'iMessage-derived style access is paused');
      const register = p.register === 'professional' ? 'professional' : 'casual';
      const path = join(d.home, 'style', `${register}.md`);
      if (!existsSync(path)) return perr('not_found', 'no style guide collected yet');
      return ok({ register, guide: text(readFileSync(path, 'utf8')), note: 'Aggregate owner style only; acceptance status is in capabilities. Never copy facts or other participants.' });
    }
    let account = d.accounts.find(a => a.id === p.accountId);
    if (!account && p.accountId === undefined) {
      const candidates = d.accounts.filter(a => a.mode !== 'not_connected' && (kind === 'mail' && (a.kind === 'gmail' || a.kind === 'outlook')));
      if (candidates.length === 1) account = candidates[0];
      else if (candidates.length > 1) return perr('invalid_input', `Several accounts are connected (${candidates.map(a => a.id).join(', ')}); say which one with accountId`);
    }
    if (!account || account.mode === 'not_connected') return perr('not_found', kind === 'mail' ? 'No mail account is connected yet (the owner connects one with scripts/connect-account.ts)' : 'That account is not connected yet');
    if (c.revokedAccounts.includes(account.id)) return perr('revoked', 'account revoked');
    if (c.pausedIntegrations.includes(account.kind)) return perr('paused', 'account integration paused');
    if (kind === 'mail' && (account.kind === 'gmail' || account.kind === 'outlook')) {
      const state = d.mail.getSyncState(account.id);
      if (!state || state.status !== 'ok' || !state.lastSuccessAt || d.clock.nowMs() - Date.parse(state.lastSuccessAt) > 15 * 60_000) return perr('not_found', `${account.id} has not synced in the last 15 minutes, so the inbox view is stale; do not treat it as empty`);
      const limit = typeof p.limit === 'number' ? Math.max(1, Math.min(10, Math.floor(p.limit))) : 5;
      const query = typeof p.query === 'string' ? p.query.slice(0, 500).toLowerCase() : '';
      const items = typeof p.id === 'string' ? [d.mail.get(account.id, p.id)].filter(m => m !== undefined) : d.mail.list({ accountId: account.id, limit: 200 });
      return ok({ lastSuccessAt: state.lastSuccessAt, searchWindow: 'latest 200 synced messages', untrustedData: true,
        items: items.filter(m => !m.deletedAt && (!query || `${m.subject} ${m.from?.address ?? ''} ${m.bodyText}`.toLowerCase().includes(query))).slice(0, limit).map(m => ({
          id: m.providerMessageId, from: m.from, subject: text(m.subject, 300), body: text(m.bodyText, typeof p.id === 'string' ? 8000 : 1200), receivedAt: m.receivedAt, category: m.category,
          internetMessageId: m.internetMessageId, threadId: m.threadId,
        })),
      });
    }
    return perr('invalid_input', 'unsupported source or account kind');
  };
}
