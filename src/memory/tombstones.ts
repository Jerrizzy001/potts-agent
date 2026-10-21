import { existsSync, readFileSync } from 'node:fs';
import type { Tombstone, TombstoneEntity } from './types.ts';

const ENTITIES: readonly TombstoneEntity[] = ['fact', 'fact_version', 'style_corpus', 'style_example', 'source'];

/**
 * Reads the content-free tombstone journal ($POTTS_HOME/memory/tombstones.jsonl).
 *
 * Backup/restore contract (for WP-8): the journal lives beside the database
 * and is append-only. After restoring an older database snapshot, call
 * `store.reapplyTombstones(readTombstoneJournal(path))` BEFORE the daemon
 * serves any reads, so facts, versions, style rows and source revocations
 * deleted after the snapshot was taken are deleted again. Malformed lines are
 * skipped and reported, never guessed.
 */
export function readTombstoneJournal(path: string): { tombstones: Tombstone[]; malformedLines: number } {
  if (!existsSync(path)) return { tombstones: [], malformedLines: 0 };
  const out: Tombstone[] = [];
  let bad = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as Tombstone;
      if (!ENTITIES.includes(t.entity) || typeof t.entityId !== 'string' || typeof t.receiptId !== 'string' || typeof t.deletedAt !== 'string') {
        bad++;
        continue;
      }
      out.push(t);
    } catch {
      bad++;
    }
  }
  return { tombstones: out, malformedLines: bad };
}
