/**
 * Audit-head journal (WP-1 note: the hash chain cannot detect truncation of
 * the newest entries, so the head must be exported somewhere the worker cannot
 * write). The journal lives at $POTTS_HOME/audit-heads.jsonl, mode 0600, in
 * the 0700 Potts home. The model has no file tools outside its workspace and
 * the worker runs as a different user / under a Seatbelt profile that denies
 * the Potts home, so neither can rewrite it. Backups copy it too.
 *
 * Each record also carries the broker's runtime controls (pauses/revocations),
 * which restore uses as a second source of truth for revocations.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../store/db.ts';
import type { ControlSnapshot } from '../broker/broker.ts';

export type HeadKind = 'startup' | 'periodic' | 'shutdown' | 'controls' | 'backup' | 'restore';

export interface AuditHeadRecord {
  at: string;
  kind: HeadKind;
  seq: number;
  hash: string;
  controls: ControlSnapshot['runtime'];
}

export const auditHeadsPath = (home: string) => join(home, 'audit-heads.jsonl');

export function appendAuditHead(home: string, rec: AuditHeadRecord): void {
  const p = auditHeadsPath(home);
  appendFileSync(p, JSON.stringify(rec) + '\n', { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

export function readAuditHeads(home: string): AuditHeadRecord[] {
  const p = auditHeadsPath(home);
  if (!existsSync(p)) return [];
  const out: AuditHeadRecord[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as AuditHeadRecord;
      if (typeof r.seq === 'number' && typeof r.hash === 'string') out.push({ ...r, controls: Array.isArray(r.controls) ? r.controls : [] });
    } catch {
      /* ignore a torn last line */
    }
  }
  return out;
}

export function lastAuditHead(home: string): AuditHeadRecord | null {
  const all = readAuditHeads(home);
  return all.length ? all[all.length - 1]! : null;
}

export type HeadCheck = { ok: true; detail: string } | { ok: false; reason: string };

/** Compares the DB's audit log with the last exported head: detects truncation and rewritten history. */
export function checkAuditHead(db: Db, last: AuditHeadRecord | null): HeadCheck {
  if (!last) return { ok: true, detail: 'no exported head yet' };
  const cur = (db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined) ?? { seq: 0, hash: '0'.repeat(64) };
  if (cur.seq < last.seq) return { ok: false, reason: `audit log truncated: DB head seq ${cur.seq} < exported head seq ${last.seq} (${last.kind} at ${last.at})` };
  if (last.seq === 0) return { ok: true, detail: 'exported head was empty' };
  const row = db.prepare('SELECT hash FROM audit_log WHERE seq = ?').get(last.seq) as { hash: string } | undefined;
  if (!row || row.hash !== last.hash) return { ok: false, reason: `audit entry ${last.seq} differs from the exported head (history rewritten)` };
  return { ok: true, detail: `head ${cur.seq} extends exported head ${last.seq}` };
}
