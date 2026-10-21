import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectNamedProject } from '../../integrations/openclaw/potts-broker-plugin/lib/project-brief.ts';
import { createEnvironmentTool } from '../../integrations/openclaw/potts-broker-plugin/lib/environment.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'potts-project-'));
  const root = join(home, 'Projects'); mkdirSync(root);
  const add = (name: string, repo = 'potts-agent') => {
    const path = join(root, name); mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), `[remote "origin"]\n url = https://private:SECRET_CREDENTIAL@github.com/example/${repo}.git\n`);
    writeFileSync(join(path, 'README.md'), '# Potts\nA local messaging assistant with persistent memory.');
    return path;
  };
  return { home, root, add, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('the screenshot repository name resolves to a differently named local folder and reads actual evidence', async () => {
  const f = fixture(); try {
    const path = f.add('potts-public');
    const r = await inspectNamedProject(f.home, 'projects/potts-agent');
    assert.equal(r.state, 'inspected'); assert.ok('readmeExcerpt' in r); assert.equal(r.path, path); assert.equal(r.matchedBy, 'repository-name');
    assert.match(r.readmeExcerpt!, /persistent memory/); assert.match(r.evidenceLimit!, /no functionality or tests were verified/);
    assert.doesNotMatch(JSON.stringify(r), /SECRET_CREDENTIAL/);
  } finally { f.close(); }
});

test('ambiguous aliases ask for disambiguation; an exact directory selects its own evidence', async () => {
  const f = fixture(); try {
    f.add('first'); f.add('second');
    const r = await inspectNamedProject(f.home, 'potts-agent'); assert.equal(r.state, 'ambiguous'); assert.equal(r.matches!.length, 2);
    const exact = await inspectNamedProject(f.home, 'first'); assert.equal(exact.state, 'inspected'); assert.ok('name' in exact); assert.equal(exact.name, 'first');
  } finally { f.close(); }
});

test('source reading remains inside ordinary project files and rejects credential paths and symlinks', async () => {
  const f = fixture(); try {
    const path = f.add('potts-public'); mkdirSync(join(path, 'src')); writeFileSync(join(path, 'src', 'app.ts'), 'export const project = "fixture";\n');
    writeFileSync(join(path, '.env'), 'SECRET_FIXTURE'); symlinkSync(join(path, '.git'), join(path, 'linked'));
    const r = await inspectNamedProject(f.home, 'potts-agent', [], { file: 'src/app.ts' }); assert.equal(r.state, 'inspected'); assert.ok('sourceExcerpt' in r); assert.match(r.sourceExcerpt!, /fixture/);
    for (const file of ['../outside', '.env', '.git/config', 'linked/config', '/etc/passwd']) assert.equal((await inspectNamedProject(f.home, 'potts-agent', [], { file })).state, 'file_unavailable');
    assert.equal((await inspectNamedProject(f.home, '/etc')).state, 'not_found');
  } finally { f.close(); }
});

test('the existing discovery tool can inspect code directly without unrelated connection probes', async () => {
  const f = fixture(); try {
    f.add('potts-public'); const cfg = parsePluginConfig({ pottsHome: join(f.home, 'state') }); assert.ok(cfg.ok);
    let probes = 0; const tool = createEnvironmentTool(cfg.value, { home: f.home, read: () => null, query: async () => { probes++; return null; } });
    const r = await tool.execute('check', { project: 'potts-agent', file: 'README.md' });
    assert.equal(r.details.ok, true); assert.equal(r.details.project?.state, 'inspected'); assert.equal(probes, 0);
  } finally { f.close(); }
});

test('project inspection never invokes a repository-configured signature verifier', async () => {
  const f = fixture(); try {
    const path = join(f.root, 'signed-project'); mkdirSync(path);
    const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', ['-C', path, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    const tree = git(['mktree'], '');
    const commit = `tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nSignature fixture\n`;
    const sha = git(['hash-object', '-t', 'commit', '-w', '--stdin'], commit);
    git(['update-ref', 'HEAD', sha]);
    const verifier = join(path, 'configured-verifier');
    const marker = join(path, 'verifier-ran');
    writeFileSync(verifier, '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\ntouch verifier-ran\nexit 1\n', { mode: 0o700 });
    git(['config', 'log.showSignature', 'true']);
    git(['config', 'gpg.program', verifier]);
    const result = await inspectNamedProject(f.home, 'signed-project');
    assert.equal(result.state, 'inspected');
    assert.ok('recentCommits' in result);
    assert.match(result.recentCommits!, /Signature fixture/);
    assert.equal(existsSync(marker), false, 'read-only discovery must not execute repository-controlled programs');
  } finally { f.close(); }
});
