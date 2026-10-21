/**
 * Credentialed release executor (broker Executor for `merge` and `deploy`).
 *
 * - Constructed only by trusted startup code and REGISTERED DISABLED by
 *   default: while disabled, execute() definitively rejects (nothing happens).
 * - Credentials are secret references in the project registry, resolved only
 *   here, at dispatch time, into the release command environment. They are
 *   never given to the coding worker, never logged, never persisted.
 * - Works from a clean checkout of the EXACT approved commit:
 *     remote_push:    clone of Potts' evidence repo at commitSha, tree checked,
 *                     remote head re-resolved == expectedRemoteHead, then a
 *                     fast-forward `git push <remote> <sha>:refs/heads/<branch>`
 *                     (never --force), optional pull request via GitHub REST.
 *     release_script: fresh clone of the registered remote, branch
 *                     <sourceBranch> checked out at commitSha, remote head
 *                     re-resolved == commitSha, optional artifact hash check,
 *                     `pre` commands (failure = definitive rejection, nothing
 *                     deployed), then the repo's own release command(s), then
 *                     post-deploy identity + live verification.
 * - Payload/destination/kind/target/remote are re-validated against the
 *   CURRENT registry and CI classification before anything runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { resolveSecretRef, type SecretResolverOptions } from '../core/secrets.ts';
import { ExecutorRejectedError, type DispatchIntent, type Executor, type ExecutorReceipt, type LookupResult } from '../broker/executor.ts';
import { git, gitOk, remoteBranchHead, revParse } from '../delegation/git.ts';
import type { ProjectEntry, ProjectRegistry } from '../delegation/projects.ts';
import { outputTail, spawnBounded, type RunResult, type RunSpec } from '../delegation/runner.ts';
import { cloneDetached } from '../delegation/workspace.ts';
import { classifyRemoteOperation } from './ci-guard.ts';
import { destinationFor, githubRepoOf, parseReleasePayload, releaseCommandsHash, type ReleasePayload, type ReleaseScriptPayload, type RemotePushPayload } from './payload.ts';
import { verifyDeployment, type VerificationResult } from './verify.ts';

export interface ReleaseExecutorOptions {
  /** Default false. The owner enables it explicitly in trusted startup wiring. */
  enabled?: boolean;
  projects: ProjectRegistry;
  /** Potts-owned scratch dir for clean release checkouts. */
  workRoot: string;
  clock?: Clock;
  secretResolver?: SecretResolverOptions;
  /** Runs release/verification commands as the release identity (default: local spawn). */
  run?: (spec: RunSpec) => Promise<RunResult>;
  fetch?: typeof fetch;
  /** Source for envAllowlist names (default process.env). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

const releaseRun = (spec: RunSpec): Promise<RunResult> => spawnBounded({ spec, enforcement: { osUser: null, filesystem: false, network: false } });

function reject(msg: string): never {
  throw new ExecutorRejectedError(msg);
}

export function createReleaseExecutor(o: ReleaseExecutorOptions): Executor & { readonly enabled: boolean; lastVerification(actionId: string): VerificationResult | undefined } {
  const enabled = o.enabled === true;
  const clock = o.clock ?? systemClock;
  const run = o.run ?? releaseRun;
  const f = o.fetch ?? fetch;
  const verifications = new Map<string, VerificationResult>();

  const validate = (intent: Readonly<DispatchIntent>): { p: ReleasePayload; project: ProjectEntry } => {
    const p = parseReleasePayload(intent.payload);
    if (!p) reject('payload is not a valid release payload');
    const project = o.projects.get(p.projectId);
    if (!project) reject(`project ${p.projectId} is not registered`);
    if (!project.release?.enabled) reject(`release is disabled for project ${p.projectId}`);
    if (project.remoteUrl !== p.remoteUrl) reject('bound remote URL no longer matches the registry');
    const dest = destinationFor(p);
    if (JSON.stringify([...intent.destination].sort()) !== JSON.stringify(dest)) reject('destination does not match the payload');
    if (p.type === 'remote_push') {
      const c = classifyRemoteOperation(project, p.pullRequest ? { type: 'pull_request', head: p.branch, base: p.pullRequest.base, changedFiles: p.changedFiles } : { type: 'push', branch: p.branch, changedFiles: p.changedFiles });
      if (c.kind !== intent.kind) reject(`operation is classified as ${c.kind} but was approved as ${intent.kind}`);
    } else {
      if (intent.kind !== 'deploy') reject('a release script is a deploy');
      if (o.projects.targetHash(p.projectId, p.targetId) !== p.targetHash) reject('deployment target changed since approval');
      if (!project.release) reject('project has no release configuration');
      if (releaseCommandsHash(project.release.commands) !== p.releaseCommandsHash) reject('release commands changed since approval');
    }
    return { p, project };
  };

  const credentialEnv = async (project: ProjectEntry): Promise<Record<string, string>> => {
    const rel = project.release;
    const env: Record<string, string> = {};
    const src = o.baseEnv ?? process.env;
    for (const n of rel?.envAllowlist ?? ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) {
      if (n === 'SSH_AUTH_SOCK' && !rel?.allowSshAgent) continue;
      const v = src[n];
      if (typeof v === 'string') env[n] = v;
    }
    Object.assign(env, rel?.env ?? {});
    if (!env.PATH) env.PATH = src.PATH ?? '/usr/bin:/bin';
    for (const [name, ref] of Object.entries(rel?.credentialEnv ?? {})) {
      const r = await resolveSecretRef(ref, o.secretResolver ?? {});
      if (!r.ok) reject(`credential ${name} unavailable: ${r.error.message}`);
      env[name] = r.value;
    }
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
  };

  /** Git env for HTTPS remotes: token via env-provided extraHeader (never argv). */
  const gitAuthEnv = (remoteUrl: string, env: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of ['SSH_AUTH_SOCK', 'HOME', 'USER']) if (env[k]) out[k] = env[k]!;
    const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
    if (token && remoteUrl.startsWith('https://')) {
      out.GIT_CONFIG_COUNT = '1';
      out.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      out.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    }
    return out;
  };

  const workDir = (intent: Readonly<DispatchIntent>) => {
    const d = join(o.workRoot, intent.actionId, `attempt-${intent.attempt}`);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    mkdirSync(join(o.workRoot, intent.actionId), { recursive: true, mode: 0o700 });
    return d;
  };

  const github = async (method: string, path: string, token: string | undefined, body?: unknown) => {
    if (!token) throw new Error('GitHub token unavailable for pull request operations');
    const res = await f(`https://api.github.com${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
  };

  async function push(intent: Readonly<DispatchIntent>, p: RemotePushPayload, project: ProjectEntry): Promise<ExecutorReceipt> {
    const env = await credentialEnv(project);
    const genv = gitAuthEnv(p.remoteUrl, env);
    const dir = workDir(intent);
    try {
      await cloneDetached({ source: p.sourceRepo, dest: dir, sha: p.commitSha, branch: `release/${intent.actionId}` });
    } catch (e) {
      reject(`approved commit is not available in the evidence repository: ${(e as Error).message}`);
    }
    const tree = await gitOk(['rev-parse', `${p.commitSha}^{tree}`], { cwd: dir });
    if (tree !== p.treeSha) reject('approved commit tree does not match');
    let head: string | null;
    try {
      head = await remoteBranchHead(p.remoteUrl, p.branch, genv);
    } catch (e) {
      reject(`cannot resolve remote branch: ${(e as Error).message}`);
    }
    if (head !== p.expectedRemoteHead) reject(`remote ${p.branch} moved since approval (now ${head ?? 'absent'})`);
    if (p.expectedRemoteHead) {
      const anc = await git(['merge-base', '--is-ancestor', p.expectedRemoteHead, p.commitSha], { cwd: dir });
      if (anc.code !== 0) reject('push would not be a fast-forward');
    }
    // From here on a failure may have reached the remote: uncertain, reconcile via lookup().
    const r = await git(['push', '--porcelain', '--', p.remoteUrl, `${p.commitSha}:refs/heads/${p.branch}`], { cwd: dir, env: genv, timeoutMs: o.timeoutMs ?? 300_000 });
    if (r.code !== 0) {
      if (/\[rejected\]|non-fast-forward|protected branch|permission denied|could not read from remote/i.test(r.stdout + r.stderr) && !/\bdone\b/i.test(r.stdout))
        reject(`push rejected: ${outputTail(r.stderr, 400)}`);
      throw new Error(`push outcome unknown: ${outputTail(r.stderr, 400)}`);
    }
    let prDetail: Record<string, unknown> = {};
    let opId = `push:${p.branch}@${p.commitSha}`;
    if (p.pullRequest) {
      const gh = githubRepoOf(p.remoteUrl);
      if (!gh) throw new Error('pushed, but the remote is not a GitHub repository; pull request not opened');
      const res = await github('POST', `/repos/${gh.owner}/${gh.repo}/pulls`, env.GH_TOKEN ?? env.GITHUB_TOKEN, { title: p.pullRequest.title, body: p.pullRequest.body, head: p.branch, base: p.pullRequest.base });
      const j = res.json as { number?: number; html_url?: string } | null;
      if (res.status !== 201 || !j?.number) throw new Error(`pushed, but opening the pull request returned HTTP ${res.status}`);
      opId = `pr:${gh.owner}/${gh.repo}#${j.number}@${p.commitSha}`;
      prDetail = { pullRequest: j.number, url: j.html_url ?? null };
    }
    return { providerOperationId: opId, detail: { branch: p.branch, commitSha: p.commitSha, ...prDetail } };
  }

  async function release(intent: Readonly<DispatchIntent>, p: ReleaseScriptPayload, project: ProjectEntry): Promise<ExecutorReceipt> {
    const env = await credentialEnv(project);
    const genv = gitAuthEnv(p.remoteUrl, env);
    const dir = workDir(intent);
    const cl = await git(['clone', '--quiet', '--no-hardlinks', '--branch', p.sourceBranch, '--', p.remoteUrl, dir], { env: genv, timeoutMs: 900_000 });
    if (cl.code !== 0) reject(`clean clone failed: ${outputTail(cl.stderr, 400)}`);
    const remoteHead = await remoteBranchHead(p.remoteUrl, p.sourceBranch, genv).catch((e: Error) => reject(`cannot resolve ${p.sourceBranch}: ${e.message}`));
    if (remoteHead !== p.commitSha) reject(`${p.sourceBranch} is now ${remoteHead ?? 'absent'}, not the approved ${p.commitSha}`);
    if ((await git(['checkout', '--quiet', '-B', p.sourceBranch, p.commitSha], { cwd: dir })).code !== 0) reject('approved commit not found in a clean clone');
    if ((await revParse(dir, 'HEAD')) !== p.commitSha) reject('clean checkout HEAD is not the approved commit');
    if ((await gitOk(['--no-optional-locks', 'status', '--porcelain'], { cwd: dir })) !== '') reject('clean checkout is not clean');
    if (p.artifact) {
      const file = join(dir, p.artifact.path);
      if (!existsSync(file)) reject(`artifact ${p.artifact.path} missing`);
      const h = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (h !== p.artifact.sha256) reject(`artifact ${p.artifact.path} hash ${h} != approved ${p.artifact.sha256}`);
    }
    const cmds = project.release!.commands.map((c) => ({ ...c, argv: c.argv.map((a) => a.split('{sha}').join(p.commitSha)) }));
    const log: { id: string; exitCode: number | null; tail: string }[] = [];
    for (const c of cmds.filter((x) => (x.phase ?? 'pre') === 'pre')) {
      const r = await run({ argv: c.argv, cwd: dir, env, network: { mode: 'allowlist', hosts: ['*'] }, timeoutMs: (c.timeoutSeconds ?? 900) * 1000, label: `release-pre:${c.id}` });
      log.push({ id: c.id, exitCode: r.exitCode, tail: outputTail(r.stdout + r.stderr, 800) });
      if (r.exitCode !== 0 || r.timedOut || r.spawnError) reject(`pre-release step ${c.id} failed (exit ${r.exitCode}); nothing was deployed: ${outputTail(r.stdout + r.stderr, 400)}`);
    }
    for (const c of cmds.filter((x) => x.phase === 'release')) {
      const r = await run({ argv: c.argv, cwd: dir, env, network: { mode: 'allowlist', hosts: ['*'] }, timeoutMs: (c.timeoutSeconds ?? 3600) * 1000, label: `release:${c.id}` });
      log.push({ id: c.id, exitCode: r.exitCode, tail: outputTail(r.stdout + r.stderr, 800) });
      if (r.exitCode !== 0 || r.timedOut || r.spawnError) throw new Error(`release step ${c.id} failed (exit ${r.exitCode}); deployment state uncertain: ${outputTail(r.stdout + r.stderr, 400)}`);
    }
    const target = o.projects.target(p.projectId, p.targetId)!;
    const verification = await verifyDeployment(target, { sha: p.commitSha, cwd: dir, env, fetch: f, run });
    verifications.set(intent.actionId, verification);
    return {
      providerOperationId: `deploy:${p.projectId}/${p.targetId}@${p.commitSha}`,
      detail: {
        commitSha: p.commitSha, targetId: p.targetId, verifiedAt: clock.nowIso(), verificationOk: verification.ok,
        identity: verification.identity.map((x) => ({ ok: x.ok, target: x.target })), live: verification.live.map((x) => ({ ok: x.ok, target: x.target })),
        steps: log.map((l) => ({ id: l.id, exitCode: l.exitCode })),
      },
    };
  }

  return {
    name: 'release',
    integration: 'deploy',
    kinds: ['merge', 'deploy'],
    timeoutMs: o.timeoutMs ?? 2 * 60 * 60 * 1000,
    enabled,
    lastVerification: (id) => verifications.get(id),
    async execute(intent) {
      if (!enabled) reject('release executor is disabled; the owner must enable it in trusted wiring');
      const { p, project } = validate(intent);
      return p.type === 'remote_push' ? push(intent, p, project) : release(intent, p, project);
    },
    async lookup(intent): Promise<LookupResult> {
      const p = parseReleasePayload(intent.payload);
      if (!p) return { status: 'unknown', reason: 'bad payload' };
      const project = o.projects.get(p.projectId);
      if (!project) return { status: 'unknown', reason: 'project not registered' };
      try {
        const env = await credentialEnv(project);
        if (p.type === 'remote_push') {
          const head = await remoteBranchHead(p.remoteUrl, p.branch, gitAuthEnv(p.remoteUrl, env));
          if (head === p.commitSha) return { status: 'found', providerOperationId: `push:${p.branch}@${p.commitSha}` };
          if (head === p.expectedRemoteHead && !p.pullRequest) return { status: 'not_found' };
          return { status: 'unknown', reason: `remote head is ${head ?? 'absent'}` };
        }
        const target = o.projects.target(p.projectId, p.targetId);
        if (!target) return { status: 'unknown', reason: 'target not registered' };
        const attemptDir = join(o.workRoot, intent.actionId, `attempt-${intent.attempt}`);
        const cwd = existsSync(attemptDir) ? attemptDir : o.workRoot;
        const v = await verifyDeployment({ ...target, liveChecks: [] }, { sha: p.commitSha, cwd, env, fetch: f, run });
        return v.ok ? { status: 'found', providerOperationId: `deploy:${p.projectId}/${p.targetId}@${p.commitSha}` } : { status: 'unknown', reason: 'deployed identity does not show the approved commit' };
      } catch (e) {
        return { status: 'unknown', reason: (e as Error).message };
      }
    },
  };
}
