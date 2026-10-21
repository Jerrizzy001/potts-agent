/**
 * Owner-curated support knowledge. Each item is a Markdown file with a small
 * front matter block:
 *
 *   ---
 *   id: jf-reset-password
 *   kind: faq | feature | pricing | troubleshooting | status | info_request
 *   app: example-app
 *   title: Resetting your password
 *   keywords: reset password, forgot password, can't log in
 *   verifiedAt: 2026-10-06T12:00:00Z      (required for kind=status)
 *   ---
 *   Approved answer text, sent verbatim.
 *
 * The loaded base carries a version hash over every item's id and content
 * hash; each draft records the version and the per-item hashes it cited.
 * Being present in the directory is necessary but NOT sufficient for an
 * automatic reply: the owner policy must also list the id in
 * support.approvedKnowledgeIds.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hashCanonical } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';

export const KNOWLEDGE_KINDS = ['faq', 'feature', 'pricing', 'troubleshooting', 'status', 'info_request'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  app: string;
  title: string;
  keywords: string[];
  answer: string;
  verifiedAt: string | null;
  sha256: string;
  file: string;
}

export interface KnowledgeBase {
  readonly version: string;
  readonly items: readonly KnowledgeItem[];
  get(id: string): KnowledgeItem | undefined;
  forApp(app: string): KnowledgeItem[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export function parseKnowledgeFile(text: string, file: string): Result<KnowledgeItem> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return perr('invalid_input', `${file}: missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i <= 0) return perr('invalid_input', `${file}: bad front matter line`);
    const k = line.slice(0, i).trim();
    if (!['id', 'kind', 'app', 'title', 'keywords', 'verifiedAt'].includes(k)) return perr('invalid_input', `${file}: unknown front matter key ${k}`);
    meta[k] = line.slice(i + 1).trim();
  }
  const answer = m[2]!.trim();
  if (!meta.id || !ID_RE.test(meta.id)) return perr('invalid_input', `${file}: id must match ${ID_RE}`);
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(meta.kind ?? '')) return perr('invalid_input', `${file}: kind must be one of ${KNOWLEDGE_KINDS.join(', ')}`);
  if (!meta.app || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(meta.app)) return perr('invalid_input', `${file}: app is required`);
  if (!meta.title) return perr('invalid_input', `${file}: title is required`);
  if (!answer) return perr('invalid_input', `${file}: empty answer`);
  if (answer.length > 4000) return perr('invalid_input', `${file}: answer longer than 4000 characters`);
  let verifiedAt: string | null = null;
  if (meta.kind === 'status') {
    if (!meta.verifiedAt || Number.isNaN(Date.parse(meta.verifiedAt))) return perr('invalid_input', `${file}: status items need verifiedAt (ISO instant)`);
    verifiedAt = new Date(meta.verifiedAt).toISOString();
  }
  const keywords = (meta.keywords ?? '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const item = { id: meta.id, kind: meta.kind as KnowledgeKind, app: meta.app, title: meta.title, keywords, answer, verifiedAt };
  return ok({ ...item, sha256: hashCanonical(item), file });
}

export function buildKnowledgeBase(items: KnowledgeItem[]): Result<KnowledgeBase> {
  const byId = new Map<string, KnowledgeItem>();
  for (const it of items) {
    if (byId.has(it.id)) return perr('invalid_input', `duplicate knowledge id ${it.id} (${byId.get(it.id)!.file}, ${it.file})`);
    byId.set(it.id, Object.freeze({ ...it, keywords: [...it.keywords] }));
  }
  const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const version = hashCanonical(sorted.map((i) => [i.id, i.sha256]));
  return ok({ version, items: sorted, get: (id) => byId.get(id), forApp: (app) => sorted.filter((i) => i.app === app) });
}

/**
 * Loads every *.md file in `dir` (non-recursive). Refuses a directory or file
 * that is group/world writable, and symlinks, so the knowledge the model can
 * cite stays owner-curated.
 */
export function loadKnowledgeDir(dir: string, opts: { skipPermissionCheck?: boolean } = {}): Result<KnowledgeBase> {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return perr('not_found', `knowledge directory not found: ${dir}`);
  }
  if (!st.isDirectory()) return perr('invalid_input', `${dir} is not a directory`);
  if (!opts.skipPermissionCheck && (st.mode & 0o022) !== 0) return perr('policy_file_insecure', `knowledge directory ${dir} is group/world writable`);
  const items: KnowledgeItem[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const p = join(dir, f);
    const ls = lstatSync(p);
    if (ls.isSymbolicLink() || !ls.isFile()) return perr('invalid_input', `${f}: knowledge files must be regular files`);
    if (!opts.skipPermissionCheck && (ls.mode & 0o022) !== 0) return perr('policy_file_insecure', `${f} is group/world writable`);
    const r = parseKnowledgeFile(readFileSync(p, 'utf8'), f);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return buildKnowledgeBase(items);
}
