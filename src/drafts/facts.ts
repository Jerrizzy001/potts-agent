/**
 * Verified-fact interface used by resume / job-material drafts. Only facts
 * whose status is 'verified' are ever inserted into a draft; draft/inferred or
 * missing facts are listed as unresolved. The WP-3 memory store is adapted
 * structurally so this package does not depend on its internals.
 */
export type FactStatusLike = 'verified' | 'draft' | 'inferred';

export interface FactRecord {
  id: string;
  text: string;
  status: FactStatusLike;
  topic: string | null;
  tags: string[];
  sourceKind: string;
  sourceRef: string | null;
}

/** What a draft section needs, e.g. {key:'education', label:'Education', topic:'education'}. */
export interface FactRequirement {
  key: string;
  label: string;
  topic?: string;
  tags?: string[];
  /** Full-text query (defaults to the label). */
  query?: string;
  /** Max facts to use (default 5). */
  limit?: number;
}

export interface FactSource {
  find(req: FactRequirement): Promise<FactRecord[]> | FactRecord[];
}

/** Minimal structural view of WP-3's MemoryStore.search(). */
export interface MemorySearchLike {
  search(
    query: string,
    opts?: { topic?: string; limit?: number },
  ): { fact: { id: string; topic: string | null; current: { text: string; tags: string[]; status: FactStatusLike; sourceKind: string; sourceRef: string | null } } }[];
}

export function memoryFactSource(mem: MemorySearchLike): FactSource {
  return {
    find(req) {
      const hits = mem.search(req.query ?? req.label, { ...(req.topic ? { topic: req.topic } : {}), limit: (req.limit ?? 5) * 3 });
      return hits
        .map((h) => ({
          id: h.fact.id, text: h.fact.current.text, status: h.fact.current.status, topic: h.fact.topic, tags: h.fact.current.tags,
          sourceKind: h.fact.current.sourceKind, sourceRef: h.fact.current.sourceRef,
        }))
        .filter((f) => !req.tags?.length || req.tags.every((t) => f.tags.includes(t)));
    },
  };
}

/** In-memory fact source for tests and owner-provided fact lists. */
export function staticFactSource(facts: FactRecord[]): FactSource {
  return {
    find(req) {
      return facts.filter(
        (f) =>
          (!req.topic || f.topic === req.topic) &&
          (!req.tags?.length || req.tags.every((t) => f.tags.includes(t))) &&
          (req.topic || req.tags?.length || f.text.toLowerCase().includes((req.query ?? req.label).toLowerCase())),
      );
    },
  };
}
