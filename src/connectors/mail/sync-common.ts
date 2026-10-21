import type { ConnectorError } from '../oauth/errors.ts';
import type { MailStore, MailSyncState, MailSyncStatus } from './store.ts';

export interface MailSyncCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
}

export interface MailSyncResult extends MailSyncCounts {
  accountId: string;
  /** 'ok' on success; otherwise the explicit stale/blocked status (never "no mail"). */
  status: MailSyncStatus;
  mode: 'full' | 'incremental' | 'full_after_expiry' | 'none';
  error?: ConnectorError;
}

export const zeroCounts = (): MailSyncCounts => ({ inserted: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 });

export function statusForError(e: ConnectorError): MailSyncStatus {
  switch (e.code) {
    case 'stale_auth':
    case 'not_connected':
      return 'stale_auth';
    case 'admin_consent_required':
      return 'admin_consent_required';
    case 'rate_limited':
      return 'rate_limited';
    case 'revoked':
      return 'revoked';
    case 'paused':
      return 'paused';
    default:
      return 'error';
  }
}

/** Records a failed sync: cursor and existing items are kept; status explains why data may be stale. */
export function recordFailure(
  store: MailStore, accountId: string, provider: 'gmail' | 'outlook', prev: MailSyncState | undefined, e: ConnectorError,
  mode: MailSyncResult['mode'], startedAt: string, counts: MailSyncCounts,
): MailSyncResult {
  const status = statusForError(e);
  const now = store.clock.nowIso();
  store.setSyncState({
    accountId, provider, cursor: prev?.cursor ?? null, lastFullSyncAt: prev?.lastFullSyncAt ?? null, lastSyncAt: now,
    lastSuccessAt: prev?.lastSuccessAt ?? null, status, statusReason: e.message,
  });
  store.logSync({ accountId, startedAt, mode: mode === 'none' ? 'incremental' : mode, outcome: status, ...counts, detail: e.code });
  return { accountId, status, mode, ...counts, error: e };
}

export function tally(c: MailSyncCounts, outcome: 'inserted' | 'updated' | 'unchanged'): void {
  c[outcome]++;
}
