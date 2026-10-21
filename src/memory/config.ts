import { join } from 'node:path';
import { ok, type Clock, type Logger, type Result } from '../core/index.ts';
import type { Db } from '../store/index.ts';
import { embeddingsFromConfig } from './embeddings.ts';
import { createMemoryStore, type MemoryStore } from './store.ts';
import type { MemoryConfig, RetentionRule } from './types.ts';

/**
 * Default retention: nothing expires automatically. Retention periods are an
 * owner decision (plan P2-02); the example config proposes values the owner
 * must confirm before ingesting the full message history.
 */
export const DEFAULT_RETENTION: Readonly<Record<string, RetentionRule>> = Object.freeze({});

export function memoryConfigFrom(config: object | undefined): MemoryConfig {
  const m = ((config as { memory?: unknown } | undefined)?.memory ?? {}) as MemoryConfig;
  return {
    retention: { ...DEFAULT_RETENTION, ...(m.retention ?? {}) },
    embeddings: m.embeddings ?? { provider: 'disabled' },
    tombstoneJournal: m.tombstoneJournal ?? true,
  };
}

export function memoryPaths(home: string): { dir: string; tombstoneJournal: string; styleDir: string } {
  return { dir: join(home, 'memory'), tombstoneJournal: join(home, 'memory', 'tombstones.jsonl'), styleDir: join(home, 'style') };
}

export interface OpenMemoryOptions {
  db: Db;
  clock: Clock;
  home: string;
  config?: MemoryConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** Production constructor: wires retention, local-only embeddings and the tombstone journal from config. */
export function openMemory(o: OpenMemoryOptions): Result<MemoryStore> {
  const cfg = o.config ?? memoryConfigFrom(undefined);
  const emb = embeddingsFromConfig(cfg.embeddings, o.fetchImpl);
  if (!emb.ok) return emb;
  const opts: Parameters<typeof createMemoryStore>[0] = { db: o.db, clock: o.clock, embeddings: emb.value };
  if (cfg.retention) opts.retention = cfg.retention;
  if (cfg.tombstoneJournal !== false) opts.tombstoneJournalPath = memoryPaths(o.home).tombstoneJournal;
  if (o.logger) opts.logger = o.logger;
  return ok(createMemoryStore(opts));
}
