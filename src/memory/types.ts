export const FACT_STATUSES = ['verified', 'draft', 'inferred'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** Who is writing. Model-originated writes can never be 'verified'. */
export const MEMORY_ACTORS = ['owner', 'system', 'model'] as const;
export type MemoryActor = (typeof MEMORY_ACTORS)[number];

/**
 * Source kinds are open-ended slugs so other packages can add their own
 * (e.g. gmail, outlook). Well-known kinds used by WP-3:
 */
export const KNOWN_SOURCE_KINDS = [
  'owner_stated', // the owner told Potts directly (Telegram / CLI)
  'owner_feedback', // owner ratings of style samples
  'imessage', // local chat.db (owner-authored messages only)
  'gmail',
  'outlook',
  'telegram',
  'document',
  'potts_inference', // something Potts inferred; always 'inferred' status
  'system',
] as const;
export const SOURCE_KIND_RE = /^[a-z][a-z0-9_]{0,40}$/;

export interface MemorySource {
  id: string;
  kind: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface FactVersion {
  factId: string;
  version: number;
  text: string;
  tags: string[];
  status: FactStatus;
  confidence: number;
  sourceId: string;
  sourceKind: string;
  sourceRef: string | null;
  observedAt: string | null;
  recordedAt: string;
  actor: MemoryActor;
  correctionReason: string | null;
  contentHash: string;
  supersededAt: string | null;
}

export interface Fact {
  id: string;
  topic: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  current: FactVersion;
}

export interface FactInspection extends Fact {
  /** All versions, oldest first, including superseded ones. */
  versions: FactVersion[];
  sources: MemorySource[];
  derived: { styleExamples: number; embeddings: number };
}

export interface RememberInput {
  text: string;
  sourceId: string;
  sourceRef?: string;
  observedAt?: string;
  status: FactStatus;
  confidence: number;
  topic?: string;
  tags?: string[];
  actor?: MemoryActor;
}

export interface CorrectInput {
  text?: string;
  status?: FactStatus;
  confidence?: number;
  tags?: string[];
  reason: string;
  /** Defaults to the built-in owner source (src_owner). */
  sourceId?: string;
  sourceRef?: string;
  actor?: MemoryActor;
}

export interface SearchOptions {
  statuses?: FactStatus[];
  sourceKinds?: string[];
  sourceIds?: string[];
  topic?: string;
  limit?: number;
}

export interface SearchHit {
  fact: Fact;
  score: number;
  snippet: string;
}

export interface DeletionCounts {
  facts: number;
  factVersions: number;
  ftsRows: number;
  embeddings: number;
  styleCorpus: number;
  styleExamples: number;
  sourcesRevoked: number;
}

export interface DeletionReceipt {
  id: string;
  reason: 'forget' | 'revoke_source' | 'retention' | 'forget_source_ref' | 'restore_reapply';
  target: string;
  at: string;
  counts: DeletionCounts;
  tombstones: { firstSeq: number | null; lastSeq: number | null; count: number };
  receiptHash: string;
  journalWritten: boolean;
}

export type TombstoneEntity = 'fact' | 'fact_version' | 'style_corpus' | 'style_example' | 'source';

/** Content-free deletion record. entityId for fact_version is "<factId>#<version>". */
export interface Tombstone {
  seq: number;
  entity: TombstoneEntity;
  entityId: string;
  contentHash: string | null;
  sourceId: string | null;
  reason: string;
  receiptId: string;
  deletedAt: string;
}

export interface RetentionRule {
  /** Keep for this many days; null = keep until forgotten. */
  days: number | null;
  /** Age measured from when Potts recorded it (default) or from the evidence timestamp. */
  basis?: 'recorded' | 'observed';
}

export interface MemoryConfig {
  retention?: Record<string, RetentionRule>;
  embeddings?: { provider: 'disabled' | 'lmstudio'; url?: string; model?: string };
  /** Append tombstones to $POTTS_HOME/memory/tombstones.jsonl as well (default true). */
  tombstoneJournal?: boolean;
}
