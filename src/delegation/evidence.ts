/**
 * Evidence collection. After a worker returns, Potts does NOT trust its
 * account. It independently:
 *
 *  1. Captures the change as a patch from the worker's copy (git add -A +
 *     git diff --cached --binary against the base commit), running git AS THE
 *     WORKER through the IsolatedRunner — Potts never runs git inside a
 *     worker-writable repository.
 *  2. Applies that patch in a Potts-owned evidence clone of the registered
 *     repository at the base commit and commits it with a fixed identity:
 *     the resulting candidate SHA/tree is exactly what an approval binds.
 *     Diffstat and file list are computed by Potts in that clone.
 *  3. Clones the candidate into a fresh worker-owned test copy and runs the
 *     registered setup + test commands (and any release checks the changed
 *     paths require) through the runner, recording exit codes.
 *  4. Compares the worker's "tests passed" claim with the independent result
 *     and lists risks. The claim is recorded; it never counts as evidence.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { hashCanonical, sha256Hex } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { gitOk, revParse } from './git.ts';
import { matchesAny } from './glob.ts';
import type { CommandSpec, ProjectEntry, ReleaseCheck } from './projects.ts';
import { buildWorkerEnv, outputTail, type IsolatedRunner, type NetworkPolicy } from './runner.ts';
import type { WorkerResult } from './claude.ts';
import { cloneDetached, forbiddenPaths } from './workspace.ts';

export interface FileChange {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

export interface CommandEvidence {
  id: string;
  group: 'setup' | 'test' | `release_check:${string}`;
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export type RiskLevel = 'blocker' | 'warning' | 'info';
export interface Risk {
  level: RiskLevel;
  code: string;
  message: string;
}

export interface EvidenceReport {
  taskId: string;
  projectId: string;
  baseSha: string;
  candidateSha: string | null;
  candidateTree: string | null;
  evidenceRepo: string | null;
  patchSha256: string;
  patchBytes: number;
  filesChanged: FileChange[];
  diffstat: { files: number; insertions: number; deletions: number };
  commands: CommandEvidence[];
  testsRan: boolean;
  allTestsPassed: boolean;
  releaseChecks: { id: string; required: boolean; passed: boolean | null; runbook: string | null }[];
  worker: {
    status: string;
    claimedTestsPassed: boolean | null;
    claimedSummary: string | null;
    claimVerified: boolean | null;
    sessionId: string | null;
    numTurns: number | null;
  };
  isolation: { runner: string; osUser: string | null; network: boolean; filesystem: boolean };
  risks: Risk[];
  createdAt: string;
  reportHash: string;
}

export const EVIDENCE_LIMITS = { maxPatchBytes: 16 * 1024 * 1024, largeDiffLines: 1500, largeDiffFiles: 40 } as const;

const DEPLOY_CONFIG_GLOBS = ['wrangler*.json', 'wrangler*.jsonc', '**/wrangler*.json', '**/wrangler*.jsonc', 'scripts/deploy/**', 'package.json', 'package-lock.json', '.nvmrc'];
const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**', 'vitest.config.*', '**/vitest.*.config.*'];

const EVIDENCE_IDENTITY = { GIT_AUTHOR_NAME: 'Potts evidence', GIT_AUTHOR_EMAIL: 'potts-evidence@localhost', GIT_COMMITTER_NAME: 'Potts evidence', GIT_COMMITTER_EMAIL: 'potts-evidence@localhost' };

export function requiredReleaseChecks(project: ProjectEntry, paths: readonly string[]): ReleaseCheck[] {
  return (project.releaseChecks ?? []).filter((c) => paths.some((p) => matchesAny(p, c.pathPatterns, true)));
}

export function workerEnvFor(project: ProjectEntry, runner: IsolatedRunner): Record<string, string> {
  return buildWorkerEnv(project.worker.envAllowlist, runner.baseEnv, { ...(project.worker.env ?? {}) });
}

const net = (hosts: readonly string[] | undefined): NetworkPolicy => (hosts && hosts.length ? { mode: 'allowlist', hosts: [...hosts] } : { mode: 'none' });

export interface CapturePatchResult {
  patch: string;
  error: string | null;
}

/** Runs git as the worker inside its own copy to export the change against base. */
export async function capturePatch(runner: IsolatedRunner, project: ProjectEntry, workingDir: string, baseSha: string): Promise<CapturePatchResult> {
  const env = { ...workerEnvFor(project, runner), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const common = { cwd: workingDir, env, network: { mode: 'none' as const }, timeoutMs: 300_000 };
  const add = await runner.run({ ...common, argv: ['git', '-c', 'core.hooksPath=/dev/null', 'add', '-A'], label: 'evidence:git-add' });
  if (add.exitCode !== 0) return { patch: '', error: `git add failed: ${outputTail(add.stderr, 500)}` };
  const diff = await runner.run({
    ...common,
    argv: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.noprefix=false', 'diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', baseSha, '--'],
    label: 'evidence:git-diff',
    maxOutputBytes: EVIDENCE_LIMITS.maxPatchBytes + 1,
  });
  if (diff.exitCode !== 0) return { patch: '', error: `git diff failed: ${outputTail(diff.stderr, 500)}` };
  if (diff.outputTruncated || Buffer.byteLength(diff.stdout) > EVIDENCE_LIMITS.maxPatchBytes) return { patch: '', error: 'patch exceeds the size limit' };
  return { patch: diff.stdout, error: null };
}

function parseNumstat(numstat: string, nameStatus: string): FileChange[] {
  const status = new Map<string, string>();
  for (const l of nameStatus.split('\n').filter(Boolean)) {
    const [s, ...rest] = l.split('\t');
    status.set(rest.join('\t'), s ?? '?');
  }
  return numstat.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...rest] = l.split('\t');
    const path = rest.join('\t');
    return { path, status: status.get(path) ?? 'M', added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) };
  });
}

async function runCommands(runner: IsolatedRunner, project: ProjectEntry, dir: string, cmds: { spec: CommandSpec; group: CommandEvidence['group']; network: NetworkPolicy }[], signal?: AbortSignal): Promise<CommandEvidence[]> {
  const env = workerEnvFor(project, runner);
  const out: CommandEvidence[] = [];
  for (const c of cmds) {
    const r = await runner.run({ argv: c.spec.argv, cwd: dir, env, network: c.network, timeoutMs: (c.spec.timeoutSeconds ?? 600) * 1000, label: `${c.group}:${c.spec.id}` }, signal);
    const passed = r.exitCode === 0 && !r.timedOut && !r.spawnError;
    out.push({
      id: c.spec.id, group: c.group, command: c.spec.argv.join(' '), exitCode: r.exitCode, passed, timedOut: r.timedOut, durationMs: r.durationMs,
      outputTail: outputTail(`${r.stdout}\n${r.stderr}${r.spawnError ? `\n${r.spawnError}` : ''}`, 3000),
    });
    // A failed setup step makes later test results meaningless.
    if (c.group === 'setup' && !passed) break;
  }
  return out;
}

export interface CollectEvidenceOptions {
  taskId: string;
  project: ProjectEntry;
  runner: IsolatedRunner;
  workingDir: string;
  baseSha: string;
  worker: WorkerResult | null;
  /** Potts-owned directory for evidence clones (never worker-writable). */
  evidenceRoot: string;
  clock?: Clock;
  /** Run setupCommands before tests (default true). */
  runSetup?: boolean;
  signal?: AbortSignal;
}

export async function collectEvidence(o: CollectEvidenceOptions): Promise<EvidenceReport> {
  const clock = o.clock ?? systemClock;
  const risks: Risk[] = [];
  const isolation = { runner: o.runner.id, osUser: o.runner.enforcement.osUser, network: o.runner.enforcement.network, filesystem: o.runner.enforcement.filesystem };
  if (!isolation.osUser) risks.push({ level: 'warning', code: 'no_os_isolation', message: 'Worker ran without the OS user boundary (development runner).' });

  const cap = await capturePatch(o.runner, o.project, o.workingDir, o.baseSha);
  const patch = cap.patch;
  if (cap.error) risks.push({ level: 'blocker', code: 'patch_unavailable', message: cap.error });

  // Evidence clone owned by Potts.
  const attempt = newId('ev', clock).toLowerCase();
  const evDir = join(o.evidenceRoot, o.taskId, `evidence-${attempt}`);
  mkdirSync(join(o.evidenceRoot, o.taskId), { recursive: true, mode: 0o700 });
  let candidateSha: string | null = null;
  let candidateTree: string | null = null;
  let filesChanged: FileChange[] = [];
  if (!cap.error) {
    try {
      await cloneDetached({ source: o.project.repoPath, dest: evDir, sha: o.baseSha, branch: `potts/evidence/${o.taskId}` });
      if (patch.trim()) {
        const pf = join(o.evidenceRoot, o.taskId, `patch-${attempt}.diff`);
        writeFileSync(pf, patch, { mode: 0o600 });
        await gitOk(['apply', '--index', '--binary', '--whitespace=nowarn', pf], { cwd: evDir });
        const when = clock.nowIso();
        await gitOk(['commit', '--quiet', '--no-verify', '-m', `potts: candidate for task ${o.taskId}`], { cwd: evDir, env: { ...EVIDENCE_IDENTITY, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
      }
      candidateSha = await revParse(evDir, 'HEAD');
      candidateTree = candidateSha ? await gitOk(['rev-parse', `${candidateSha}^{tree}`], { cwd: evDir }) : null;
      const numstat = await gitOk(['diff', '--numstat', '--no-renames', o.baseSha, 'HEAD'], { cwd: evDir });
      const nameStatus = await gitOk(['diff', '--name-status', '--no-renames', o.baseSha, 'HEAD'], { cwd: evDir });
      filesChanged = parseNumstat(numstat, nameStatus);
      const raw = await gitOk(['diff', '--raw', '--no-renames', o.baseSha, 'HEAD'], { cwd: evDir });
      const links = raw.split('\n').filter((l) => / 120000 [0-9a-f]+ [0-9a-f]+ [AM]\t/.test(l)).map((l) => l.split('\t')[1]);
      if (links.length) risks.push({ level: 'warning', code: 'symlink_added', message: `Change adds or modifies symbolic links: ${links.join(', ')}` });
    } catch (e) {
      risks.push({ level: 'blocker', code: 'patch_apply_failed', message: `Potts could not reproduce the change from the worker's patch: ${(e as Error).message}` });
      candidateSha = null;
    }
  }
  const paths = filesChanged.map((f) => f.path);
  if (!patch.trim() && !cap.error) risks.push({ level: 'warning', code: 'no_changes', message: 'The worker made no changes.' });
  const bad = forbiddenPaths(paths, o.project);
  if (bad.length) risks.push({ level: 'blocker', code: 'forbidden_paths', message: `Change touches credential-like or excluded paths: ${bad.join(', ')}` });
  const wfGlobs = o.project.ci.workflowPathPatterns ?? ['.github/workflows/**'];
  const wf = paths.filter((p) => matchesAny(p, wfGlobs) || p.startsWith('.github/'));
  if (wf.length) risks.push({ level: 'warning', code: 'ci_workflow_change', message: `Change edits CI configuration (${wf.join(', ')}); any push or PR is treated as a deploy.` });
  const dep = paths.filter((p) => matchesAny(p, DEPLOY_CONFIG_GLOBS));
  if (dep.length) risks.push({ level: 'warning', code: 'deploy_config_change', message: `Change edits deployment/dependency configuration: ${dep.join(', ')}` });
  const tests = paths.filter((p) => matchesAny(p, TEST_GLOBS));
  if (tests.length) risks.push({ level: 'info', code: 'tests_modified', message: `Change modifies tests: ${tests.slice(0, 20).join(', ')}` });
  const ins = filesChanged.reduce((n, f) => n + (f.added ?? 0), 0);
  const del = filesChanged.reduce((n, f) => n + (f.deleted ?? 0), 0);
  if (ins + del > EVIDENCE_LIMITS.largeDiffLines || filesChanged.length > EVIDENCE_LIMITS.largeDiffFiles) risks.push({ level: 'warning', code: 'large_change', message: `Large change: ${filesChanged.length} files, +${ins}/-${del}.` });

  const checks = requiredReleaseChecks(o.project, paths);
  for (const c of checks) risks.push({ level: 'warning', code: `release_check:${c.id}`, message: `Requires the repository's ${c.id} release checks${c.runbook ? ` (${c.runbook})` : ''}; a green health endpoint is not enough.` });

  // Independent test run in a fresh worker-owned copy of the candidate.
  let commands: CommandEvidence[] = [];
  if (candidateSha) {
    const testDir = join(o.runner.workspaceRoot, o.taskId, `verify-${attempt}`);
    try {
      await cloneDetached({ source: evDir, dest: testDir, sha: candidateSha, branch: `potts/verify/${o.taskId}` });
      await o.runner.adoptWorkspace(testDir);
      const plan: { spec: CommandSpec; group: CommandEvidence['group']; network: NetworkPolicy }[] = [];
      if (o.runSetup !== false) for (const s of o.project.setupCommands ?? []) plan.push({ spec: s, group: 'setup', network: net(o.project.worker.setupNetwork) });
      for (const t of o.project.testCommands) plan.push({ spec: t, group: 'test', network: net(o.project.worker.testNetwork) });
      for (const c of checks) for (const s of c.commands) plan.push({ spec: s, group: `release_check:${c.id}`, network: net(o.project.worker.testNetwork) });
      commands = await runCommands(o.runner, o.project, testDir, plan, o.signal);
    } catch (e) {
      risks.push({ level: 'blocker', code: 'verification_failed_to_start', message: `Independent test run could not start: ${(e as Error).message}` });
      rmSync(testDir, { recursive: true, force: true });
    }
  }
  const testCmds = commands.filter((c) => c.group === 'test');
  const setupOk = commands.filter((c) => c.group === 'setup').every((c) => c.passed);
  const testsRan = testCmds.length === o.project.testCommands.length && setupOk;
  const allTestsPassed = testsRan && testCmds.length > 0 && testCmds.every((c) => c.passed);
  if (!testsRan) risks.push({ level: 'blocker', code: 'tests_not_run', message: 'The registered tests did not all run.' });
  else if (!allTestsPassed) risks.push({ level: 'blocker', code: 'tests_failed', message: `Independent test run failed: ${testCmds.filter((c) => !c.passed).map((c) => c.id).join(', ')}` });
  const releaseChecks = checks.map((c) => {
    const rs = commands.filter((x) => x.group === `release_check:${c.id}`);
    return { id: c.id, required: true, passed: rs.length === c.commands.length ? rs.every((x) => x.passed) : null, runbook: c.runbook ?? null };
  });

  const w = o.worker;
  const claimed = w?.claim.testsPassed ?? null;
  const claimVerified = claimed === null ? null : claimed === allTestsPassed;
  if (claimed === true && !allTestsPassed) risks.push({ level: 'blocker', code: 'claim_mismatch', message: 'The worker reported that tests passed, but Potts\'s independent run did not pass.' });
  if (w && w.status !== 'completed') risks.push({ level: 'warning', code: `worker_${w.status}`, message: `Worker finished with status ${w.status}.` });

  const body = {
    taskId: o.taskId, projectId: o.project.id, baseSha: o.baseSha, candidateSha, candidateTree, evidenceRepo: candidateSha ? evDir : null,
    patchSha256: sha256Hex(patch), patchBytes: Buffer.byteLength(patch), filesChanged, diffstat: { files: filesChanged.length, insertions: ins, deletions: del },
    commands, testsRan, allTestsPassed, releaseChecks,
    worker: {
      status: w?.status ?? 'none', claimedTestsPassed: claimed, claimedSummary: w?.claim.summary ?? null, claimVerified,
      sessionId: w?.transcript.sessionId ?? null, numTurns: w?.transcript.numTurns ?? null,
    },
    isolation, risks, createdAt: clock.nowIso(),
  };
  return { ...body, reportHash: hashCanonical(body) };
}

export function hasBlockers(r: EvidenceReport): boolean {
  return r.risks.some((x) => x.level === 'blocker');
}

/** Concise owner-facing report (Telegram-sized). Worker text is labelled as a claim. */
export function renderOwnerReport(r: EvidenceReport): string {
  const L: string[] = [];
  const verdict = hasBlockers(r) ? 'NOT READY' : 'Ready for your review';
  L.push(`Task ${r.taskId} (${r.projectId}): ${verdict}`);
  L.push(`Base ${r.baseSha.slice(0, 12)} → candidate ${r.candidateSha ? r.candidateSha.slice(0, 12) : 'none'}`);
  L.push(`Diff: ${r.diffstat.files} files, +${r.diffstat.insertions}/-${r.diffstat.deletions}`);
  for (const f of r.filesChanged.slice(0, 15)) L.push(`  ${f.status} ${f.path} (+${f.added ?? 'bin'}/-${f.deleted ?? 'bin'})`);
  if (r.filesChanged.length > 15) L.push(`  …and ${r.filesChanged.length - 15} more`);
  L.push('Independent checks (run by Potts):');
  if (!r.commands.length) L.push('  none ran');
  for (const c of r.commands) L.push(`  ${c.passed ? 'PASS' : 'FAIL'} ${c.group} ${c.command}${c.timedOut ? ' (timed out)' : ''}`);
  const claim = r.worker.claimedTestsPassed === null ? 'no claim' : r.worker.claimedTestsPassed ? 'claimed tests passed' : 'claimed tests failed';
  L.push(`Worker (${r.worker.status}): ${claim}${r.worker.claimVerified === false ? ' — CONTRADICTED by the independent run' : r.worker.claimVerified ? ' — matches' : ''}`);
  if (r.worker.claimedSummary) L.push(`Worker summary (unverified claim): ${r.worker.claimedSummary.slice(0, 600)}`);
  if (r.risks.length) {
    L.push('Risks:');
    for (const x of r.risks) L.push(`  [${x.level}] ${x.message}`);
  }
  L.push('Nothing has been merged, pushed or deployed. Each of those needs your approval of the exact commit and target.');
  return L.join('\n');
}
