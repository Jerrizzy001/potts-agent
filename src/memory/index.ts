/**
 * WP-3 local memory: versioned, source-backed facts in SQLite + FTS5, with
 * inspect/correct/forget/revoke-source, retention purge, content-free
 * tombstones for restore, optional loopback-only embeddings, and a compact
 * context builder. See docs in each module.
 */
export * from './types.ts';
export * from './store.ts';
export * from './retrieval.ts';
export * from './sensitive.ts';
export * from './embeddings.ts';
export * from './config.ts';
export * from './tombstones.ts';
export * from './identity.ts';
export * from './derived.ts';
