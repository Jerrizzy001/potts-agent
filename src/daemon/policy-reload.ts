/**
 * Policy hot reload (SIGHUP, or a change of policy.json's mtime/size/inode).
 *
 * - The file is re-validated exactly like at startup (owner-only file, schema,
 *   version equal to potts.json policy.version).
 * - Invalid, insecure or missing → the CURRENT policy stays in force, the
 *   rejection is audited and the owner is alerted.
 * - Valid and different (content hash) → swapped in atomically for every
 *   later decision; every live (pending or approved, unused) approval bound to
 *   the old policy hash is invalidated and a fresh approval is requested under
 *   the new policy, so the owner re-approves against the rules now in force.
 *   Audited as policy_reload and announced to the owner.
 * - Valid but identical hash → nothing happens (an mtime touch is not a change).
 */
import { statSync } from 'node:fs';
import type { Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import type { AuditLedger } from '../audit/ledger.ts';
import { loadPolicyFile, type LoadedPolicy } from '../policy/document.ts';
import type { ApprovalStore } from '../approvals/store.ts';
import type { Broker } from '../broker/broker.ts';

export type PolicyReloadTrigger = 'sighup' | 'mtime' | 'manual';

export type PolicyReloadResult =
  | { outcome: 'unchanged'; trigger: PolicyReloadTrigger }
  | { outcome: 'reloaded'; trigger: PolicyReloadTrigger; oldVersion: string; newVersion: string; oldHash: string; newHash: string; invalidated: number; rerequested: number }
  | { outcome: 'rejected'; trigger: PolicyReloadTrigger; reason: string };

export interface PolicyReloaderOptions {
  path: string;
  /** Version the file must carry (re-read from potts.json at each reload). */
  expectedVersion: () => string;
  current: () => LoadedPolicy;
  set: (p: LoadedPolicy) => void;
  db: Db;
  broker: Pick<Broker, 'getAction' | 'approvals'>;
  audit: Pick<AuditLedger, 'append'>;
  clock: Clock;
  /** Owner notification (outbox). */
  notify: (n: { dedupKey: string; text: string }) => void;
  log?: Logger;
  skipOwnershipCheck?: boolean;
}

export interface PolicyReloader {
  /** Reloads when forced (sighup/manual) or when the file's stat signature changed (mtime). */
  check(trigger: PolicyReloadTrigger): PolicyReloadResult;
}

const sig = (path: string): string | null => {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

export function createPolicyReloader(o: PolicyReloaderOptions): PolicyReloader {
  let lastSig = sig(o.path);
  let lastRejectedSig: string | null = null;
  const approvals: ApprovalStore = o.broker.approvals;

  const reject = (trigger: PolicyReloadTrigger, reason: string, s: string | null): PolicyReloadResult => {
    const cur = o.current();
    o.audit.append({ type: 'policy_reload', actor: 'system:daemon', data: { outcome: 'rejected', trigger, reason: reason.slice(0, 300), keptVersion: cur.version, keptHash: cur.hash } });
    // One alert per distinct broken file state (a SIGHUP re-alerts).
    if (trigger !== 'mtime' || s !== lastRejectedSig) {
      o.notify({
        dedupKey: `policy-reload-rejected:${s ?? 'missing'}:${trigger === 'mtime' ? '' : o.clock.nowIso()}`,
        text: `Potts did not load the edited policy.json: ${reason.slice(0, 300)}. The previous policy (version ${cur.version}) is still in force. Fix the file (chmod 600, valid JSON, policyVersion equal to potts.json policy.version) and save it again or send SIGHUP.`,
      });
    }
    lastRejectedSig = s;
    o.log?.warn('policy reload rejected; keeping the current policy', { reason, trigger });
    return { outcome: 'rejected', trigger, reason };
  };

  return {
    check(trigger) {
      const s = sig(o.path);
      if (trigger === 'mtime' && s === lastSig) return { outcome: 'unchanged', trigger };
      lastSig = s;
      if (s === null) return reject(trigger, `${o.path} is missing`, s);
      let expected: string;
      try {
        expected = o.expectedVersion();
      } catch (e) {
        return reject(trigger, `cannot read the expected policy version: ${(e as Error).message}`, s);
      }
      const r = loadPolicyFile(o.path, { expectedVersion: expected, ...(o.skipOwnershipCheck ? { skipOwnershipCheck: true } : {}) });
      if (!r.ok) return reject(trigger, r.error.message, s);
      lastRejectedSig = null;
      const old = o.current();
      const next = r.value;
      if (next.hash === old.hash) return { outcome: 'unchanged', trigger };

      const { invalidated, rerequested } = withTransaction(o.db, () => {
        o.set(next);
        const live = o.db.prepare("SELECT id, action_id FROM approvals WHERE status IN ('pending','approved') ORDER BY created_at").all() as { id: string; action_id: string }[];
        let inv = 0;
        let req = 0;
        for (const row of live) {
          const rec = approvals.get(row.id);
          if (!rec || rec.binding.policyHash === next.hash) continue;
          approvals.invalidateLive(row.action_id, `policy changed (${old.version} → ${next.version})`, 'system:policy-reload');
          inv++;
          const a = o.broker.getAction(row.action_id);
          if (a && (a.status === 'awaiting_approval' || a.status === 'ready')) {
            approvals.request(a, next);
            if (a.status === 'ready') o.db.prepare("UPDATE actions SET status = 'awaiting_approval', updated_at = ? WHERE id = ? AND status = 'ready'").run(o.clock.nowIso(), a.id);
            req++;
          }
        }
        o.audit.append({
          type: 'policy_reload', actor: 'system:daemon',
          data: { outcome: 'reloaded', trigger, oldVersion: old.version, newVersion: next.version, oldHash: old.hash, newHash: next.hash, invalidated: inv, rerequested: req },
        });
        return { invalidated: inv, rerequested: req };
      });
      o.notify({
        dedupKey: `policy-reload:${next.hash}`,
        text: `Potts loaded the edited policy (version ${next.version}).${invalidated ? ` ${invalidated} outstanding approval(s) were invalidated; ${rerequested} request(s) need your approval again (/approvals).` : ''}`,
      });
      o.log?.info('policy reloaded', { trigger, oldVersion: old.version, newVersion: next.version, invalidated });
      return { outcome: 'reloaded', trigger, oldVersion: old.version, newVersion: next.version, oldHash: old.hash, newHash: next.hash, invalidated, rerequested };
    },
  };
}
