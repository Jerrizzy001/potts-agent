/**
 * Read-only socket for the potts-broker plugin's read tools, and the
 * memory-control socket for verified owner /forget.
 *
 * read.sock (no auth; reachable by the gateway user): memory.search,
 * memory.context, drafts.list, briefings.status, capabilities.status,
 * status.text. Every method is read-only and returns bounded output. Payload
 * bodies of actions are never exposed here.
 *
 * memory-control.sock: owner_forget {proof}. The proof is an owner-control
 * MAC (ingress key, domain "potts-owner-control:v1"), verified for sender and
 * freshness and made single-use in the broker DB before anything is deleted.
 */
import type { Db } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { withTransaction } from '../store/db.ts';
import type { AuditLedger } from '../audit/ledger.ts';
import type { MemoryStore } from '../memory/store.ts';
import { buildContext } from '../memory/retrieval.ts';
import type { DraftWorkspace } from '../drafts/workspace.ts';
import type { Scheduler } from '../jobs/scheduler.ts';
import { consumeOwnerControlOnce, verifyOwnerControl } from '../owner/owner-control.ts';
import { startRpcServer, type RunningServer } from '../broker/server.ts';
import type { Logger } from '../core/log.ts';
import type { Capability } from '../status/model.ts';
import { renderStatusTelegram, renderControlsLine } from '../status/render.ts';
import type { ControlSnapshot } from '../broker/broker.ts';

export interface ReadDeps {
  imessageSearch?: (p: Record<string, unknown>) => unknown;
  contentRead?: (p: Record<string, unknown>) => unknown;
  db: Db;
  clock: Clock;
  memory: MemoryStore | null;
  drafts: DraftWorkspace | null;
  scheduler: Scheduler;
  capabilities: () => Capability[];
  controls: () => ControlSnapshot;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isInteger(v) ? Math.min(Math.max(v, lo), hi) : dflt);

export function readMethods(d: ReadDeps): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'imessage.search': (p) => d.imessageSearch ? d.imessageSearch(p) : perr('not_found', 'iMessage reader not connected'),
    'delegation.report': (p) => {
      if (d.controls().globalPaused || d.controls().pausedIntegrations.includes('delegation')) return perr('paused', 'delegation paused');
      if (typeof p.actionId !== 'string') return perr('invalid_input', 'actionId required');
      const r = d.db.prepare('SELECT task_id, result_json FROM delegation_broker_jobs WHERE action_id = ?').get(p.actionId) as { task_id: string; result_json: string | null } | undefined;
      return r ? ok({ taskId: r.task_id, report: r.result_json ? JSON.parse(r.result_json) : null, note: r.result_json ? 'worker evidence, not deployment' : 'no completed report yet' }) : perr('not_found', 'code task not found');
    },
    'content.read': (p) => d.contentRead ? d.contentRead(p) : perr('not_found', 'content reader not configured'),
    'memory.inspect': (p): Result<unknown> => {
      if (!d.memory) return perr('not_found', 'memory is not available');
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      if (!/^fact_[A-Za-z0-9]{10,40}$/.test(id)) return perr('invalid_input', 'a fact id like fact_… is required (get one from potts_memory_search)');
      const r = d.memory.inspect(id);
      if (!r.ok) return r;
      const f = r.value;
      return ok({
        id: f.id, topic: f.topic, current: f.current,
        versions: f.versions.map(v => ({ version: v.version, text: v.text, status: v.status, confidence: v.confidence, recordedAt: v.recordedAt, observedAt: v.observedAt, actor: v.actor, source: v.sourceId, correctionReason: v.correctionReason })),
        sources: f.sources.map(s => ({ id: s.id, kind: s.kind, label: s.label ?? null })),
        note: 'Provenance for one stored fact. status verified = owner-confirmed; inferred = Potts\'s guess. Memory is context, not permission.',
      });
    },
    'memory.search': (p): Result<unknown> => {
      if (!d.memory) return perr('not_found', 'memory is not available');
      const query = typeof p.query === 'string' ? p.query.slice(0, 500) : '';
      if (!query.trim()) return perr('invalid_input', 'query required');
      const hits = d.memory.search(query, { limit: clampInt(p.limit, 1, 50, 10) });
      return ok(hits.map((h) => ({
        id: h.fact.id, text: h.fact.current.text.slice(0, 1000), status: h.fact.current.status, confidence: h.fact.current.confidence,
        source: `${h.fact.current.sourceKind}:${h.fact.current.sourceId}`, observedAt: h.fact.current.observedAt, updatedAt: h.fact.updatedAt,
      })));
    },
    'memory.context': (p): Result<unknown> => {
      if (!d.memory) return perr('not_found', 'memory is not available');
      const query = typeof p.query === 'string' ? p.query.slice(0, 500) : '';
      if (!query.trim()) return perr('invalid_input', 'query required');
      const c = buildContext(d.memory, query, { tokenBudget: clampInt(p.tokenBudget, 100, 4000, 800), maxFacts: clampInt(p.maxFacts, 1, 25, 10) });
      return ok({ text: c.text, facts: c.facts.length, omitted: c.omitted, tokensUsed: c.tokensUsed });
    },
    'drafts.list': (p): Result<unknown> => {
      if (!d.drafts) return perr('not_found', 'drafts are not available');
      const status = typeof p.status === 'string' ? p.status : undefined;
      const all = d.drafts.list(status ? ({ status } as Parameters<DraftWorkspace['list']>[0]) : {});
      return ok(all.slice(0, clampInt(p.limit, 1, 50, 10)).map((r) => ({ id: r.id, kind: r.kind, title: r.title.slice(0, 200), status: r.status, unresolved: r.unresolved.length, updatedAt: r.updatedAt, proposalActionId: r.proposalActionId })));
    },
    'briefings.status': () =>
      ok({
        jobs: d.scheduler.list().filter((j) => j.id.startsWith('briefing:')).map((j) => ({ id: j.id, enabled: j.enabled, nextRunAt: j.nextRunAt, lastSuccessAt: j.lastSuccessAt, lastStatus: j.lastStatus })),
        recent: (d.db.prepare('SELECT briefing_id AS briefingId, slot_key AS slotKey, item_count AS items, late, created_at AS createdAt FROM briefing_log ORDER BY created_at DESC LIMIT 5').all() as Record<string, unknown>[]),
      }),
    'capabilities.status': () => ok({ controls: d.controls(), capabilities: d.capabilities() }),
    'status.text': () => ok({ text: `${renderControlsLine(d.controls())}\n${renderStatusTelegram(d.capabilities())}` }),
  };
}

export function startReadServer(socketPath: string, d: ReadDeps, logger?: Logger): Promise<RunningServer> {
  return startRpcServer({ socketPath, methods: readMethods(d), ...(logger ? { logger } : {}) });
}

export interface MemoryControlDeps {
  db: Db;
  clock: Clock;
  audit: AuditLedger;
  memory: MemoryStore;
  key: string;
  ownerSenderId: string;
  source?: 'telegram' | 'imessage';
}

export function memoryControlMethods(d: MemoryControlDeps): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    owner_remember: (p): Result<unknown> => {
      const v = verifyOwnerControl(p.proof, { key: d.key, ownerSenderId: d.ownerSenderId, source: d.source, clock: d.clock, expectType: 'memory_remember' });
      if (!v.ok) return v;
      const text = v.value.control.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) return perr('invalid_input', 'memory text must be 1-2000 characters');
      return withTransaction(d.db, () => {
        const once = consumeOwnerControlOnce(d.db, v.value, d.clock);
        if (!once.ok) return once;
        const r = d.memory.remember({ text: text.trim(), sourceId: 'src_owner', sourceRef: `${v.value.source}:${v.value.updateId}`, status: 'verified', confidence: 1 });
        if (!r.ok) return r;
        d.audit.append({ type: 'memory_control', actor: `owner:${v.value.source}:${v.value.senderId}`, data: { control: 'memory_remember', memoryId: r.value.id } });
        return ok({ memoryId: r.value.id });
      });
    },
    owner_forget: (p): Result<unknown> => {
      const v = verifyOwnerControl(p.proof, { key: d.key, ownerSenderId: d.ownerSenderId, source: d.source, clock: d.clock, expectType: 'memory_forget' });
      if (!v.ok) {
        d.audit.append({ type: 'ingress_rejected', actor: 'memory-control', data: { code: v.error.code, message: v.error.message } });
        return v;
      }
      const memoryId = v.value.control.memoryId;
      if (typeof memoryId !== 'string' || !/^[A-Za-z0-9_:.-]{1,80}$/.test(memoryId)) return perr('invalid_input', 'bad memory id');
      const actor = `owner:${v.value.source}:${v.value.senderId}`;
      const once = withTransaction(d.db, () => consumeOwnerControlOnce(d.db, v.value, d.clock));
      if (!once.ok) {
        d.audit.append({ type: 'ingress_rejected', actor, data: { code: once.error.code, control: 'memory_forget' } });
        return once;
      }
      // forget() runs its own transaction plus FTS optimize and a WAL checkpoint, so it must not be nested.
      const r = d.memory.forget(memoryId);
      if (!r.ok) {
        d.audit.append({ type: 'memory_control', actor, data: { control: 'memory_forget', memoryId, result: r.error.code } });
        return r;
      }
      d.audit.append({ type: 'memory_control', actor, data: { control: 'memory_forget', memoryId, receiptId: r.value.id, receiptHash: r.value.receiptHash } });
      return ok({ forgotten: true, receiptId: r.value.id });
    },
  };
}

export function startMemoryControlServer(socketPath: string, d: MemoryControlDeps, logger?: Logger): Promise<RunningServer> {
  return startRpcServer({ socketPath, methods: memoryControlMethods(d), ...(logger ? { logger } : {}) });
}
