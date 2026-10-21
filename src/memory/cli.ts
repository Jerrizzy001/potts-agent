#!/usr/bin/env node
/**
 * Owner CLI for Potts memory and writing style.
 *
 *   npm run memory -- <command> [options]
 *
 * Runs against $POTTS_HOME (default ~/Library/Application Support/Potts/).
 * Destructive commands (forget, forget-ref, revoke-source, reapply-tombstones)
 * show a preview and require --yes. `style build` prints counts only, never
 * message text. Nothing here sends messages.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig, systemClock, type Clock } from '../core/index.ts';
import { ensurePottsHome, migrate, openDatabase, resolvePottsHome, type Db } from '../store/index.ts';
import { memoryConfigFrom, openMemory } from './config.ts';
import { renderProfile, alwaysAttachedTokens } from './identity.ts';
import { buildContext } from './retrieval.ts';
import { OWNER_SOURCE_ID, type MemoryStore } from './store.ts';
import { readTombstoneJournal } from './tombstones.ts';
import { FACT_STATUSES, type FactStatus, type MemoryConfig } from './types.ts';
import { memoryPaths } from './config.ts';
import {
  buildStyle,
  draftInStyle,
  feedbackSummary,
  generateReviewSamples,
  listExamples,
  loadStyleStats,
  rateSample,
  rebuildFromCorpus,
  removeStyleGuides,
  type Register,
} from '../style/index.ts';
import { DEFAULT_CHAT_DB } from '../connectors/imessage/reader.ts';

const DEFAULT_BUILT = [
  'Broker core: policy, approvals, audit, owner pause/revoke (WP-1)',
  'Local memory (SQLite FTS5) with inspect/correct/forget/revoke-source, and the read-only iMessage style reader (WP-3)',
];

const USAGE = `Potts memory CLI

Usage: npm run memory -- <command> [options]      (global: --home DIR, --config potts.json, --json)

Memory
  sources                                   list sources (and revoked state)
  remember --text T [--source-id ID] [--status verified|draft|inferred] [--confidence 0..1] [--topic T] [--tag X ...]
  search <query> [--status S,...] [--source-kind K,...] [--limit N]
  context <query> --budget TOKENS           compact retrieval context (what the model would get)
  inspect <factId>                          fact with full correction history and provenance
  correct <factId> --text T --reason R [--status S] [--confidence C]
  forget <factId> [--yes]                   hard delete fact, all versions, FTS rows, derived examples
  forget-ref <sourceId> <ref> [--yes]       forget everything derived from one item of a source
  revoke-source <sourceId> [--yes]          forget everything from a source and block it
  purge-expired                             apply retention rules from config
  receipts | tombstones [--after SEQ]
  reapply-tombstones [--journal PATH] [--yes]   after restoring an older DB backup

Profile
  profile generate --spec PATH [--out DIR] [--owner-call-name NAME] [--owner-name NAME] [--built TEXT ...]

Style (owner-authored iMessages only; read-only; never sends)
  style build [--db PATH] [--full] [--dry-run] [--mode copy|immutable] [--max-rows N] [--personal-domain D ...]
  style rebuild                             recompute stats/examples/guides from the stored corpus
  style examples [--register casual|professional]
  style forget-example <exampleId> [--yes]
  style draft --register R --purpose P [--recipient D] [--fact F ...] [--reply-to TEXT]
  style review [--n N] [--register R]       print sample prompts for the owner to run and rate
  style rate <sampleId> <1-5> [--comment C] [--approved-text T]
  style feedback                            rating summary and the acceptance gate
`;

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

export interface CliContext {
  db: Db;
  memory: MemoryStore;
  home: string;
  clock: Clock;
  out: (s: string) => void;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      home: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      text: { type: 'string' },
      'source-id': { type: 'string' },
      status: { type: 'string' },
      confidence: { type: 'string' },
      topic: { type: 'string' },
      tag: { type: 'string', multiple: true },
      'source-kind': { type: 'string' },
      limit: { type: 'string' },
      budget: { type: 'string' },
      reason: { type: 'string' },
      after: { type: 'string' },
      journal: { type: 'string' },
      spec: { type: 'string' },
      out: { type: 'string' },
      'owner-call-name': { type: 'string' },
      'owner-name': { type: 'string' },
      built: { type: 'string', multiple: true },
      db: { type: 'string' },
      full: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      mode: { type: 'string' },
      'max-rows': { type: 'string' },
      'personal-domain': { type: 'string', multiple: true },
      register: { type: 'string' },
      purpose: { type: 'string' },
      recipient: { type: 'string' },
      fact: { type: 'string', multiple: true },
      'reply-to': { type: 'string' },
      n: { type: 'string' },
      comment: { type: 'string' },
      'approved-text': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

type Parsed = ReturnType<typeof parse>;

function statuses(s: string | undefined): FactStatus[] | undefined {
  if (!s) return undefined;
  const list = s.split(',').map((x) => x.trim()) as FactStatus[];
  for (const x of list) if (!FACT_STATUSES.includes(x)) fail(`unknown status ${x}`);
  return list;
}

function register(s: string | undefined): Register {
  if (s !== 'casual' && s !== 'professional') fail('--register must be casual or professional');
  return s;
}

function num(s: string | undefined, name: string): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
}

function show(ctx: CliContext, json: boolean | undefined, value: unknown, text: () => string): void {
  ctx.out(json ? JSON.stringify(value, null, 2) : text());
}

/** Executes one CLI command. Exported for tests. */
export async function runCommand(ctx: CliContext, p: Parsed): Promise<number> {
  const v = p.values;
  const [cmd, ...pos] = p.positionals;
  const m = ctx.memory;
  const preview = (counts: unknown) => ctx.out(`Would delete: ${JSON.stringify(counts)}\nRe-run with --yes to proceed. Deletion is permanent (tombstones keep ids/hashes only).`);
  switch (cmd) {
    case 'sources':
      show(ctx, v.json, m.listSources(), () => m.listSources().map((s) => `${s.id}\t${s.kind}\t${s.revokedAt ? `REVOKED ${s.revokedAt}` : 'active'}\t${s.label ?? ''}`).join('\n') || '(no sources)');
      return 0;
    case 'remember': {
      if (!v.text) fail('--text is required');
      const r = m.remember({
        text: v.text,
        sourceId: v['source-id'] ?? OWNER_SOURCE_ID,
        status: (statuses(v.status)?.[0] ?? 'verified') as FactStatus,
        confidence: num(v.confidence, 'confidence') ?? 1,
        ...(v.topic ? { topic: v.topic } : {}),
        ...(v.tag ? { tags: v.tag } : {}),
        actor: 'owner',
      });
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `remembered ${r.value.id}`);
      return 0;
    }
    case 'search': {
      const query = pos.join(' ');
      if (!query) fail('search needs a query');
      const opts: Parameters<MemoryStore['search']>[1] = { limit: num(v.limit, 'limit') ?? 10 };
      const st = statuses(v.status);
      if (st) opts.statuses = st;
      if (v['source-kind']) opts.sourceKinds = v['source-kind'].split(',');
      const hits = m.search(query, opts);
      show(ctx, v.json, hits, () =>
        hits.map((h) => `${h.fact.id}  [${h.fact.current.status} ${h.fact.current.confidence}] ${h.fact.current.sourceKind}:${h.fact.current.sourceId}  ${h.snippet}`).join('\n') || '(no matches)',
      );
      return 0;
    }
    case 'context': {
      const budget = num(v.budget, 'budget');
      if (!budget) fail('--budget is required');
      const c = buildContext(m, pos.join(' '), { tokenBudget: budget });
      show(ctx, v.json, c, () => `${c.text || '(nothing relevant)'}\n-- ${c.facts.length} facts, ~${c.tokensUsed}/${c.tokenBudget} tokens, ${c.omitted} omitted`);
      return 0;
    }
    case 'inspect': {
      const r = m.inspect(pos[0] ?? '');
      if (!r.ok) fail(r.error.message);
      const f = r.value;
      show(ctx, v.json, f, () =>
        [
          `${f.id} (topic ${f.topic ?? '-'}) current v${f.currentVersion}; derived examples ${f.derived.styleExamples}, embeddings ${f.derived.embeddings}`,
          ...f.versions.map(
            (x) =>
              `  v${x.version} ${x.supersededAt ? `superseded ${x.supersededAt}` : 'CURRENT'} [${x.status} ${x.confidence}] by ${x.actor} from ${x.sourceKind}:${x.sourceId}${x.sourceRef ? `#${x.sourceRef}` : ''} at ${x.recordedAt}${x.correctionReason ? ` (reason: ${x.correctionReason})` : ''}\n     ${x.text}`,
          ),
        ].join('\n'),
      );
      return 0;
    }
    case 'correct': {
      if (!v.reason) fail('--reason is required');
      const input: Parameters<MemoryStore['correct']>[1] = { reason: v.reason, actor: 'owner' };
      if (v.text) input.text = v.text;
      const st = statuses(v.status);
      if (st) input.status = st[0]!;
      const c = num(v.confidence, 'confidence');
      if (c !== undefined) input.confidence = c;
      const r = m.correct(pos[0] ?? '', input);
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `corrected ${r.value.id} -> v${r.value.currentVersion}`);
      return 0;
    }
    case 'forget': {
      const id = pos[0] ?? '';
      const pv = m.previewForget(id);
      if (!pv.ok) fail(pv.error.message);
      if (!v.yes) return preview(pv.value), 2;
      const r = m.forget(id);
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `deleted; receipt ${r.value.id} ${JSON.stringify(r.value.counts)} hash ${r.value.receiptHash}`);
      return 0;
    }
    case 'forget-ref': {
      const [sid, ref] = pos;
      if (!sid || !ref) fail('forget-ref needs <sourceId> <ref>');
      if (!v.yes) return ctx.out(`Would delete every fact, corpus row and example from ${sid} with ref ${ref}. Re-run with --yes.`), 2;
      const r = m.forgetSourceRef(sid, ref);
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `deleted; receipt ${r.value.id} ${JSON.stringify(r.value.counts)}`);
      return 0;
    }
    case 'revoke-source': {
      const sid = pos[0] ?? '';
      const pv = m.previewRevokeSource(sid);
      if (!pv.ok) fail(pv.error.message);
      if (!v.yes) return preview(pv.value), 2;
      const r = m.revokeSource(sid);
      if (!r.ok) fail(r.error.message);
      const stale = ctx.db.prepare('SELECT COUNT(*) AS n FROM style_builds WHERE stale_at IS NOT NULL').get() as { n: number };
      const removed = stale.n > 0 ? removeStyleGuides(ctx.home) : [];
      show(ctx, v.json, { receipt: r.value, removedGuides: removed }, () => `revoked ${sid}; receipt ${r.value.id} ${JSON.stringify(r.value.counts)}${removed.length ? `; removed stale guides: ${removed.join(', ')}` : ''}`);
      return 0;
    }
    case 'purge-expired': {
      const rs = m.purgeExpired(ctx.clock);
      show(ctx, v.json, rs, () => rs.map((r) => `${r.target}: ${JSON.stringify(r.counts)} receipt ${r.id}`).join('\n') || 'nothing expired');
      return 0;
    }
    case 'receipts': {
      const rs = m.receipts(num(v.limit, 'limit') ?? 20);
      show(ctx, v.json, rs, () => rs.map((r) => `${r.at} ${r.id} ${r.reason} ${r.target} ${JSON.stringify(r.counts)}`).join('\n') || '(none)');
      return 0;
    }
    case 'tombstones': {
      const ts = m.listTombstones({ afterSeq: num(v.after, 'after') ?? 0, limit: num(v.limit, 'limit') ?? 200 });
      show(ctx, v.json, ts, () => ts.map((t) => `${t.seq} ${t.deletedAt} ${t.entity} ${t.entityId} ${t.reason}`).join('\n') || '(none)');
      return 0;
    }
    case 'reapply-tombstones': {
      const path = v.journal ?? memoryPaths(ctx.home).tombstoneJournal;
      const j = readTombstoneJournal(path);
      if (!v.yes) return ctx.out(`Journal ${path}: ${j.tombstones.length} tombstones (${j.malformedLines} malformed lines). Re-run with --yes to re-apply.`), 2;
      const r = m.reapplyTombstones(j.tombstones);
      show(ctx, v.json, r, () => `re-applied; receipt ${r.id} ${JSON.stringify(r.counts)}`);
      return 0;
    }
    case 'profile': {
      if (pos[0] !== 'generate') fail('profile generate --spec PATH');
      if (!v.spec) fail('--spec is required');
      const spec = JSON.parse(readFileSync(v.spec, 'utf8')) as Parameters<typeof renderProfile>[0];
      const opts: Parameters<typeof renderProfile>[1] = {};
      if (v['owner-call-name']) opts.ownerCallName = v['owner-call-name'];
      if (v['owner-name']) opts.ownerName = v['owner-name'];
      opts.builtNotInstalled = v.built ?? DEFAULT_BUILT;
      const files = renderProfile(spec, opts);
      const out = v.out ?? join(process.cwd(), 'profile', 'workspace');
      mkdirSync(out, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);
      ctx.out(`wrote ${Object.keys(files).length} files to ${out}; always-attached ~${alwaysAttachedTokens(files)} tokens`);
      return 0;
    }
    case 'style':
      return runStyle(ctx, p, pos);
    default:
      ctx.out(USAGE);
      return cmd ? 1 : 0;
  }
}

async function runStyle(ctx: CliContext, p: Parsed, pos: string[]): Promise<number> {
  const v = p.values;
  const [sub, ...rest] = pos;
  switch (sub) {
    case 'build': {
      const mode = v.mode === undefined ? undefined : v.mode === 'copy' || v.mode === 'immutable' ? v.mode : fail('--mode must be copy or immutable');
      const chatDb = v.db ?? DEFAULT_CHAT_DB;
      if (!existsSync(chatDb)) fail(`chat database not found at ${chatDb}`);
      const opts: Parameters<typeof buildStyle>[0] = { db: ctx.db, memory: ctx.memory, clock: ctx.clock, home: ctx.home, chatDbPath: chatDb };
      if (mode) opts.mode = mode;
      if (v.full) opts.full = true;
      if (v['dry-run']) opts.dryRun = true;
      const mr = num(v['max-rows'], 'max-rows');
      if (mr) opts.maxRows = mr;
      if (v['personal-domain']) opts.personalEmailDomains = v['personal-domain'];
      let r;
      try {
        r = buildStyle(opts);
      } catch (e) {
        const msg = (e as Error).message;
        if (/authori[sz]ation denied|unable to open|operation not permitted|SQLITE_CANTOPEN|EPERM|EACCES/i.test(msg)) {
          fail(`${msg}\nThe process cannot read the Messages database. Grant Full Disk Access to the binary running this command (see the WP-3 owner steps), then retry.`);
        }
        throw e;
      }
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () =>
        [
          `${r.value.dryRun ? 'DRY RUN — nothing written. ' : ''}reader mode ${r.value.readerMode}; cursor ${r.value.cursor.from} -> ${r.value.cursor.to}`,
          `scanned ${r.value.scanned} owner-authored rows; kept ${r.value.kept} (casual ${r.value.byRegister.casual}, professional ${r.value.byRegister.professional}); inserted ${r.value.inserted}`,
          `excluded: ${JSON.stringify(r.value.excluded)}`,
          r.value.dryRun ? '' : `corpus: ${JSON.stringify(r.value.corpus)}; examples: ${JSON.stringify(r.value.examples)}`,
          r.value.dryRun ? '' : `guides: ${r.value.guidePaths.join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return 0;
    }
    case 'rebuild': {
      const r = rebuildFromCorpus({ db: ctx.db, clock: ctx.clock, home: ctx.home });
      show(ctx, v.json, { counts: { casual: r.stats.casual.count, professional: r.stats.professional.count }, guidePaths: r.guidePaths }, () => `rebuilt from corpus (casual ${r.stats.casual.count}, professional ${r.stats.professional.count}); guides: ${r.guidePaths.join(', ')}`);
      return 0;
    }
    case 'examples': {
      const ex = listExamples(ctx.db, v.register ? register(v.register) : undefined);
      show(ctx, v.json, ex, () => ex.map((e) => `${e.id} [${e.register}${e.origin === 'owner_approved' ? ', owner-approved' : ''}] ${e.text}`).join('\n') || '(no examples)');
      return 0;
    }
    case 'forget-example': {
      const id = rest[0] ?? '';
      if (!v.yes) return ctx.out(`Would delete style example ${id}. Re-run with --yes.`), 2;
      const r = ctx.memory.forgetStyleExample(id);
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `deleted; receipt ${r.value.id}`);
      return 0;
    }
    case 'draft': {
      if (!v.purpose) fail('--purpose is required');
      const reg = register(v.register);
      const req: Parameters<typeof draftInStyle>[1] = { register: reg, purpose: v.purpose };
      if (v.recipient) req.recipientDescription = v.recipient;
      if (v.fact) req.facts = v.fact;
      if (v['reply-to']) req.replyTo = v['reply-to'];
      const pr = draftInStyle(ctx.db, req, loadStyleStats(ctx.home)?.[reg] ?? null);
      show(ctx, v.json, pr, () => `--- system ---\n${pr.system}\n--- user ---\n${pr.user}`);
      return 0;
    }
    case 'review': {
      const opts: { n?: number; register?: Register } = {};
      const n = num(v.n, 'n');
      if (n) opts.n = n;
      if (v.register) opts.register = register(v.register);
      const samples = generateReviewSamples(ctx.db, ctx.clock, loadStyleStats(ctx.home), opts);
      show(ctx, v.json, samples, () =>
        samples
          .map((s) => `=== sample ${s.id} (${s.register}) — ${s.scenario}\n--- system ---\n${s.prompt.system}\n--- user ---\n${s.prompt.user}\nRate with: npm run memory -- style rate ${s.id} <1-5> [--comment ...] [--approved-text ...]`)
          .join('\n\n'),
      );
      return 0;
    }
    case 'rate': {
      const [id, ratingS] = rest;
      const rating = Number(ratingS);
      const input: Parameters<typeof rateSample>[4] = { rating };
      if (v.comment) input.comment = v.comment;
      if (v['approved-text']) input.approvedText = v['approved-text'];
      const r = rateSample(ctx.db, ctx.memory, ctx.clock, id ?? '', input);
      if (!r.ok) fail(r.error.message);
      show(ctx, v.json, r.value, () => `recorded rating as fact ${r.value.fact.id}${r.value.exampleId ? `; owner-approved example ${r.value.exampleId}` : ''}`);
      return 0;
    }
    case 'feedback': {
      const s = feedbackSummary(ctx.db);
      show(ctx, v.json, s, () => s.map((x) => `${x.register}: ${x.rated} rated, average ${x.average ?? '-'} — ${x.accepted ? 'ACCEPTED' : 'not yet accepted (needs >=5 ratings averaging >=4)'}`).join('\n'));
      return 0;
    }
    default:
      ctx.out(USAGE);
      return 1;
  }
}

export function openCliContext(opts: { home?: string; config?: string; clock?: Clock; out?: (s: string) => void; migrationsDir?: string }): CliContext {
  const home = opts.home ?? resolvePottsHome();
  const paths = ensurePottsHome(home);
  const cfgPath = opts.config ?? (existsSync(join(home, 'potts.json')) ? join(home, 'potts.json') : undefined);
  let memCfg: MemoryConfig | undefined;
  if (cfgPath) {
    const c = loadConfig(cfgPath);
    if (!c.ok) fail(c.error.message);
    memCfg = memoryConfigFrom(c.value);
  }
  const db = openDatabase(paths.db);
  const clock = opts.clock ?? systemClock;
  migrate(db, { clock, ...(opts.migrationsDir ? { dir: opts.migrationsDir } : {}) });
  const mem = openMemory({ db, clock, home, ...(memCfg ? { config: memCfg } : {}) });
  if (!mem.ok) fail(mem.error.message);
  return { db, memory: mem.value, home, clock, out: opts.out ?? ((s) => process.stdout.write(s + '\n')) };
}

async function main(): Promise<void> {
  let p: Parsed;
  try {
    p = parse(process.argv.slice(2));
  } catch (e) {
    fail(`${(e as Error).message}\n\n${USAGE}`);
  }
  if (p.values.help || p.positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  if (p.positionals[0] === 'profile') {
    // Profile generation needs no database.
    const ctx = { out: (s: string) => void process.stdout.write(s + '\n') } as unknown as CliContext;
    process.exitCode = await runCommand(ctx, p);
    return;
  }
  const ctx = openCliContext({ ...(p.values.home ? { home: p.values.home } : {}), ...(p.values.config ? { config: p.values.config } : {}) });
  try {
    process.exitCode = await runCommand(ctx, p);
  } finally {
    ctx.db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/memory/cli.ts')) {
  await main();
}

export { parse as parseCliArgs, USAGE };
