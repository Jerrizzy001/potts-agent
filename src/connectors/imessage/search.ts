/** Parameterized, read-only search of a private Messages snapshot. Never runs model-written SQL or scripts. */
import { openReadOnly, appleDateToIso } from './reader.ts';
import { decodeAttributedBody } from './reader-typedstream.ts';
import { detectSensitive } from '../../memory/sensitive.ts';

export function searchMessages(dbPath: string, query: string, opts: { limit?: number; beforeRowid?: number; maxScan?: number } = {}) {
  if (!query.trim() || query.length > 300) throw new Error('query must be 1-300 characters');
  const { db, cleanup } = openReadOnly(dbPath, 'copy');
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(message)').all() as { name: string }[]).map(r => r.name));
    for (const key of ['text', 'date', 'is_from_me', 'handle_id']) if (!columns.has(key)) throw new Error('unsupported Messages schema');
    const optional = (key: string, fallback: string) => columns.has(key) ? `m.${key}` : fallback;
    const limit = Math.max(1, Math.min(20, Math.floor(opts.limit ?? 5)));
    const maxScan = Math.max(1, Math.min(20000, Math.floor(opts.maxScan ?? 20000)));
    const before = Number.isSafeInteger(opts.beforeRowid) && opts.beforeRowid! > 0 ? opts.beforeRowid! : Number.MAX_SAFE_INTEGER;
    const statement = db.prepare(`SELECT m.ROWID AS id, m.text, ${optional('attributedBody','NULL')} AS body,
      CASE WHEN m.date > 100000000000 THEN m.date / 1000000000.0 ELSE m.date END AS date,
      m.is_from_me AS outgoing, h.id AS handle, ${optional('service', 'NULL')} AS service
      FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
      WHERE m.ROWID < ? AND ${optional('associated_message_type','0')} = 0 AND ${optional('item_type','0')} = 0
      ORDER BY m.ROWID DESC LIMIT ?`);
    const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/);
    const matches: { id: number; text: string; sentAt: string | null; direction: string; handle: string | null; service: string | null }[] = [];
    let scanned = 0, last = before, withheld = 0;
    for (const raw of statement.iterate(before, maxScan)) {
      const r = raw as { id: number; text: string | null; body: Uint8Array | null; date: number | null; outgoing: number; handle: string | null; service: string | null };
      scanned++; last = Number(r.id);
      const body = r.text?.trim() || (r.body ? decodeAttributedBody(r.body) : null) || '';
      const haystack = `${body} ${r.handle ?? ''}`.normalize('NFKC').toLowerCase();
      if (!terms.every(term => haystack.includes(term))) continue;
      if (detectSensitive(body).sensitive) { withheld++; continue; }
      matches.push({ id: Number(r.id), text: body.slice(0, 3000), sentAt: appleDateToIso(r.date), direction: r.outgoing ? 'sent' : 'received', handle: r.handle, service: r.service });
      if (matches.length >= limit) break;
    }
    const more = !!db.prepare('SELECT 1 FROM message WHERE ROWID < ? LIMIT 1').get(last);
    return { matches, scanned, withheld, hasMore: more, nextBeforeRowid: more ? last : null, untrustedData: true, note: 'Read-only local Messages search. No messages sent. Search is bounded; paginate before concluding there are no matches.' };
  } finally { cleanup(); }
}
