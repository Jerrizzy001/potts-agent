import type { Clock } from '../../core/clock.ts';
import type { Db } from '../../store/db.ts';
import type { AccountAuthStatus } from './errors.ts';

export interface AccountStatusRecord {
  accountId: string;
  provider: 'google' | 'microsoft';
  status: AccountAuthStatus;
  consentedAddress: string | null;
  scopes: string | null;
  statusReason: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

/**
 * Per-account authentication status (connector_accounts table). Status changes
 * such as stale_auth are explicit and visible to /status (WP-8) and the
 * scheduler (WP-5); a failed refresh is never silent.
 */
export interface AccountStatusStore {
  get(accountId: string): AccountStatusRecord | undefined;
  set(rec: Omit<AccountStatusRecord, 'updatedAt' | 'connectedAt'> & { connectedAt?: string | null }): AccountStatusRecord;
  list(): AccountStatusRecord[];
}

type Row = {
  account_id: string; provider: AccountStatusRecord['provider']; status: AccountAuthStatus; consented_address: string | null;
  scopes: string | null; status_reason: string | null; connected_at: string | null; updated_at: string;
};
const toRec = (r: Row): AccountStatusRecord => ({
  accountId: r.account_id, provider: r.provider, status: r.status, consentedAddress: r.consented_address, scopes: r.scopes,
  statusReason: r.status_reason, connectedAt: r.connected_at, updatedAt: r.updated_at,
});

export function createAccountStatusStore(db: Db, clock: Clock): AccountStatusStore {
  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM connector_accounts WHERE account_id = ?').get(id) as Row | undefined;
    return r ? toRec(r) : undefined;
  };
  return {
    get,
    set(rec) {
      const prev = get(rec.accountId);
      const now = clock.nowIso();
      const connectedAt = rec.connectedAt !== undefined ? rec.connectedAt : (prev?.connectedAt ?? null);
      db.prepare(
        `INSERT INTO connector_accounts (account_id, provider, status, consented_address, scopes, status_reason, connected_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET provider=excluded.provider, status=excluded.status, consented_address=excluded.consented_address,
           scopes=excluded.scopes, status_reason=excluded.status_reason, connected_at=excluded.connected_at, updated_at=excluded.updated_at`,
      ).run(rec.accountId, rec.provider, rec.status, rec.consentedAddress, rec.scopes, rec.statusReason, connectedAt, now);
      return get(rec.accountId)!;
    },
    list: () => (db.prepare('SELECT * FROM connector_accounts ORDER BY account_id').all() as Row[]).map(toRec),
  };
}
