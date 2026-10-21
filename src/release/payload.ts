/**
 * Release payloads bound into `merge` / `deploy` approvals. Every field that
 * decides WHAT is released and WHERE is in the payload, so the WP-1 approval
 * binding (payload hash + destination) pins the exact commit/tree/artifact,
 * target descriptor and remote URL. A pre-execution recheck re-resolves them.
 */
import { SHA_RE } from '../delegation/git.ts';
import { hashCanonical } from '../core/hash.ts';
import type { CommandSpec } from '../delegation/projects.ts';

export interface RemotePushPayload {
  type: 'remote_push';
  projectId: string;
  remoteUrl: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  /** Remote branch head when proposed (null: new branch). Pushes are fast-forward only from it. */
  expectedRemoteHead: string | null;
  /** Potts-owned evidence repository that contains the commit. */
  sourceRepo: string;
  pullRequest: { base: string; title: string; body: string } | null;
  changedFiles: string[];
  ciTriggered: string[];
  evidenceReportHash: string | null;
}

export interface ReleaseScriptPayload {
  type: 'release_script';
  projectId: string;
  remoteUrl: string;
  targetId: string;
  /** hashCanonical of the registered target descriptor (url, workers, checks...). */
  targetHash: string;
  sourceBranch: string;
  commitSha: string;
  /** Optional built/committed artifact (path in the checkout + sha256) that must match exactly. */
  artifact: { path: string; sha256: string } | null;
  releaseCommandsHash: string;
  requiredChecks: string[];
  evidenceReportHash: string | null;
}

export type ReleasePayload = RemotePushPayload | ReleaseScriptPayload;

export const releaseCommandsHash = (cmds: readonly CommandSpec[]): string => hashCanonical(cmds.map((c) => ({ id: c.id, argv: c.argv, phase: c.phase ?? 'pre' })));

export function destinationFor(p: ReleasePayload): string[] {
  if (p.type === 'remote_push') {
    const d = [`git:${p.remoteUrl}#refs/heads/${p.branch}`];
    if (p.pullRequest) d.push(`github-pr:${p.remoteUrl}#${p.pullRequest.base}<-${p.branch}`);
    return d.sort();
  }
  return [`deploy:${p.projectId}/${p.targetId}`];
}

const isStr = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

/** Strict structural validation of a payload read back from an action. */
export function parseReleasePayload(v: unknown): ReleasePayload | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (p.type === 'remote_push') {
    const keys = ['type', 'projectId', 'remoteUrl', 'branch', 'commitSha', 'treeSha', 'expectedRemoteHead', 'sourceRepo', 'pullRequest', 'changedFiles', 'ciTriggered', 'evidenceReportHash'];
    if (Object.keys(p).some((k) => !keys.includes(k))) return null;
    if (!isStr(p.projectId, 64) || !isStr(p.remoteUrl, 500) || !isStr(p.branch, 200) || !BRANCH_RE.test(p.branch)) return null;
    if (!isStr(p.commitSha) || !SHA_RE.test(p.commitSha) || !isStr(p.treeSha) || !SHA_RE.test(p.treeSha)) return null;
    if (p.expectedRemoteHead !== null && !(isStr(p.expectedRemoteHead) && SHA_RE.test(p.expectedRemoteHead))) return null;
    if (!isStr(p.sourceRepo, 4096) || !p.sourceRepo.startsWith('/')) return null;
    if (p.pullRequest !== null) {
      const pr = p.pullRequest as Record<string, unknown>;
      if (!pr || typeof pr !== 'object' || !isStr(pr.base, 200) || !BRANCH_RE.test(pr.base) || !isStr(pr.title, 300) || typeof pr.body !== 'string' || pr.body.length > 60000) return null;
    }
    if (!Array.isArray(p.changedFiles) || !p.changedFiles.every((x) => typeof x === 'string')) return null;
    if (!Array.isArray(p.ciTriggered) || !p.ciTriggered.every((x) => typeof x === 'string')) return null;
    if (p.evidenceReportHash !== null && !isStr(p.evidenceReportHash, 64)) return null;
    return p as unknown as RemotePushPayload;
  }
  if (p.type === 'release_script') {
    const keys = ['type', 'projectId', 'remoteUrl', 'targetId', 'targetHash', 'sourceBranch', 'commitSha', 'artifact', 'releaseCommandsHash', 'requiredChecks', 'evidenceReportHash'];
    if (Object.keys(p).some((k) => !keys.includes(k))) return null;
    if (!isStr(p.projectId, 64) || !isStr(p.remoteUrl, 500) || !isStr(p.targetId, 64) || !isStr(p.targetHash, 64) || !isStr(p.releaseCommandsHash, 64)) return null;
    if (!isStr(p.sourceBranch, 200) || !BRANCH_RE.test(p.sourceBranch) || !isStr(p.commitSha) || !SHA_RE.test(p.commitSha)) return null;
    if (p.artifact !== null) {
      const a = p.artifact as Record<string, unknown>;
      if (!a || typeof a !== 'object' || !isStr(a.path, 1000) || (a.path as string).startsWith('/') || (a.path as string).split('/').includes('..') || !isStr(a.sha256) || !/^[0-9a-f]{64}$/.test(a.sha256 as string)) return null;
    }
    if (!Array.isArray(p.requiredChecks) || !p.requiredChecks.every((x) => typeof x === 'string')) return null;
    if (p.evidenceReportHash !== null && !isStr(p.evidenceReportHash, 64)) return null;
    return p as unknown as ReleaseScriptPayload;
  }
  return null;
}

/** Parses `git@github.com:Owner/Repo.git` / `https://github.com/Owner/Repo(.git)` → {owner, repo}. */
export function githubRepoOf(remoteUrl: string): { owner: string; repo: string } | null {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remoteUrl);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
