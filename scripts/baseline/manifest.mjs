#!/usr/bin/env node
// Potts WP-0 snapshot manifest helper. No dependencies.
//
//   node manifest.mjs create DIR [--meta k=v ...]        -> prints manifest JSON for DIR
//   node manifest.mjs verify DIR MANIFEST [--prefix P:Q]  -> checks every manifest file under DIR
//
// verify --prefix maps a manifest path prefix P to a directory-relative prefix Q
// (e.g. --prefix openclaw/:.openclaw/) so a restored tree can be checked in place.
// Exit 0 when all files match, 1 otherwise. Prints only paths and counts, never contents.

import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function create(dir, metaPairs) {
  const files = [];
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (rel === 'MANIFEST.json') continue;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      files.push({ path: rel, type: 'symlink', target: readlinkSync(p) });
    } else if (st.isFile()) {
      files.push({ path: rel, type: 'file', size: st.size, mode: (st.mode & 0o777).toString(8), sha256: await sha256File(p) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const meta = Object.fromEntries(metaPairs.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  return { format: 'potts-openclaw-snapshot/1', meta, files };
}

async function verify(dir, manifestPath, prefixes) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let ok = 0;
  const bad = [];
  for (const f of m.files) {
    let rel = f.path;
    for (const [from, to] of prefixes) if (rel.startsWith(from)) { rel = to + rel.slice(from.length); break; }
    const p = join(dir, rel);
    try {
      const st = lstatSync(p);
      if (f.type === 'symlink') {
        if (st.isSymbolicLink() && readlinkSync(p) === f.target) ok++;
        else bad.push(`${rel}: symlink mismatch`);
      } else if (!st.isFile()) bad.push(`${rel}: not a file`);
      else if ((await sha256File(p)) !== f.sha256) bad.push(`${rel}: sha256 mismatch`);
      else if ((st.mode & 0o777).toString(8) !== f.mode) bad.push(`${rel}: mode ${(st.mode & 0o777).toString(8)} != ${f.mode}`);
      else ok++;
    } catch {
      bad.push(`${rel}: missing`);
    }
  }
  console.log(`manifest verify: ${ok}/${m.files.length} ok, ${bad.length} problems`);
  for (const b of bad.slice(0, 50)) console.log(`  ${b}`);
  return bad.length === 0;
}

const [cmd, dir, ...rest] = process.argv.slice(2);
if (cmd === 'create') {
  const metas = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--meta') metas.push(rest[++i]);
  process.stdout.write(JSON.stringify(await create(dir, metas), null, 2) + '\n');
} else if (cmd === 'verify') {
  const [manifest, ...opts] = rest;
  const prefixes = [];
  for (let i = 0; i < opts.length; i++) if (opts[i] === '--prefix') { const [a, b] = opts[++i].split(':'); prefixes.push([a, b]); }
  process.exit((await verify(dir, manifest, prefixes)) ? 0 : 1);
} else {
  console.error('usage: manifest.mjs create DIR [--meta k=v]... | verify DIR MANIFEST [--prefix from:to]...');
  process.exit(2);
}
