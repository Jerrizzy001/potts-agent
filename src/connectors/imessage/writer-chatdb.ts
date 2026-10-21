/**
 * Read-only chat.db probe used ONLY by the iMessage writer's lookup() to
 * reconcile an uncertain send. Opens the database read-only, runs one bounded
 * query and returns the message GUID — no bodies are copied out.
 *
 * Not run by tests against the real ~/Library/Messages/chat.db; tests use a
 * synthetic fixture with the same minimal schema.
 */
import { DatabaseSync } from 'node:sqlite';

/** Apple's Core Data epoch (2001-01-01T00:00:00Z) in Unix ms. */
export const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
/** message.date is nanoseconds since the Apple epoch on macOS 10.13+. */
export const toAppleNanos = (iso: string): bigint => BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000n;

export type ChatDbProbe =
  | { status: 'found'; guid: string }
  | { status: 'failed'; guid: string }
  | { status: 'absent' }
  | { status: 'error'; reason: string };

export function findOutgoingMessage(q: { chatDbPath: string; handle: string; text: string; sinceIso: string; slackSeconds?: number }): ChatDbProbe {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(q.chatDbPath, { readOnly: true });
    const since = toAppleNanos(new Date(Date.parse(q.sinceIso) - (q.slackSeconds ?? 60) * 1000).toISOString());
    // Newer macOS keeps the text only in attributedBody (a typedstream blob containing the UTF-8 text).
    const rows = db
      .prepare(
        `SELECT m.guid AS guid, m.error AS error FROM message m JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.is_from_me = 1 AND h.id = ? AND m.date >= ?
           AND (m.text = ? OR (m.text IS NULL AND m.attributedBody IS NOT NULL AND instr(m.attributedBody, CAST(? AS BLOB)) > 0))
         ORDER BY m.date ASC LIMIT 5`,
      )
      .all(q.handle, since, q.text, q.text) as { guid: string; error: number | null }[];
    const ok = rows.find((r) => !r.error);
    if (ok) return { status: 'found', guid: ok.guid };
    if (rows[0]) return { status: 'failed', guid: rows[0].guid };
    return { status: 'absent' };
  } catch (e) {
    return { status: 'error', reason: `chat.db not readable (Full Disk Access?): ${(e as Error).message.slice(0, 160)}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
