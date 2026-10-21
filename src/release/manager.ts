/**
 * Release manager: turns verified evidence into exact-change `merge` /
 * `deploy` proposals in the broker, and re-checks them before execution.
 *
 *  - The kind comes from the CI guard: a push / PR that triggers a deploying
 *    workflow (e.g. Example App's push to main) is proposed as `deploy`.
 *  - The payload binds commit SHA, tree, remote URL, branch, expected remote
 *    head (push) or target descriptor hash + release commands hash (deploy).
 *    WP-1's approval binding invalidates the approval if any of it changes.
 *  - recheck() re-resolves the live state (remote heads, current registry,
 *    CI classification). If anything moved, the action is cancelled (its
 *    approval invalidated) and a fresh proposal with fresh evidence is needed.
 *  - execute() always rechecks first; the executor rechecks again itself.
 */
import type { Db } from '../store/db.ts';
import { withTransaction } from '../store/db.ts';
import type { Broker, ProposeOutcome } from '../broker/broker.ts';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { canonicalJson } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { ExecuteOutcome } from '../broker/broker.ts';
import { git, gitOk, remoteBranchHead } from '../delegation/git.ts';
import type { EvidenceReport } from '../delegation/evidence.ts';
import { hasBlockers } from '../delegation/evidence.ts';
import type { ProjectRegistry } from '../delegation/projects.ts';
import { classifyRemoteOperation, type Classification } from './ci-guard.ts';
import { destinationFor, githubRepoOf, parseReleasePayload, releaseCommandsHash, type ReleaseScriptPayload, type RemotePushPayload } from './payload.ts';

export type RemoteHeadResolver = (remoteUrl: string, branch: string) => Promise<string | null>;

export interface ReleaseManagerOptions {
  db: Db;
  broker: Broker;
  projects: ProjectRegistry;
  clock?: Clock;
  actor?: string;
  /** Default: `git ls-remote` with the given env (the release identity's SSH agent / token). */
  resolveRemoteHead?: RemoteHeadResolver;
  gitEnv?: Record<string, string>;
}

export type RecheckResult = { status: 'current' } | { status: 'stale'; changed: string[]; observed: Record<string, unknown>; cancelled: boolean };

export interface ReleaseProposal extends ProposeOutcome {
  kind: 'merge' | 'deploy';
  classification: Classification | null;
  payload: RemotePushPayload | ReleaseScriptPayload;
}

export interface ReleaseManager {
  proposeRemotePush(o: { report: EvidenceReport; branch: string; pullRequest?: { base: string; title: string; body: string } | null; allowFailingEvidence?: boolean }): Promise<Result<ReleaseProposal>>;
  proposeDeploy(o: { projectId: string; targetId: string; commitSha: string; report?: EvidenceReport | null; artifact?: { path: string; sha256: string } | null; allowWithoutEvidence?: boolean }): Promise<Result<ReleaseProposal>>;
  recheck(actionId: string): Promise<Result<RecheckResult>>;
  /** recheck() then broker.execute(); a stale release never reaches the executor. */
  execute(actionId: string): Promise<Result<ExecuteOutcome>>;
}

export function createReleaseManager(o: ReleaseManagerOptions): ReleaseManager {
  const clock = o.clock ?? systemClock;
  const actor = o.actor ?? 'potts:release';
  const resolveHead: RemoteHeadResolver = o.resolveRemoteHead ?? ((url, branch) => remoteBranchHead(url, branch, o.gitEnv ?? {}));

  const record = (actionId: string, result: 'current' | 'stale' | 'error', changed: string[], observed: Record<string, unknown>) =>
    o.db.prepare('INSERT INTO release_rechecks (id, action_id, result, changed_json, observed_json, created_at) VALUES (?,?,?,?,?,?)').run(
      newId('rck', clock), actionId, result, canonicalJson(changed), canonicalJson(observed), clock.nowIso(),
    );

  const propose = (kind: 'merge' | 'deploy', payload: RemotePushPayload | ReleaseScriptPayload, summary: string, taskId: string | null, classification: Classification | null): Result<ReleaseProposal> => {
    const r = o.broker.propose(
      { kind, destination: destinationFor(payload), payload, scope: taskId ? { taskId, projectId: payload.projectId } : { projectId: payload.projectId }, summary },
      actor,
    );
    if (!r.ok) return r;
    return ok({ ...r.value, kind, classification, payload });
  };

  const manager: ReleaseManager = {
    async proposeRemotePush(a) {
      const r = a.report;
      const project = o.projects.get(r.projectId);
      if (!project) return perr('not_found', `project ${r.projectId} not registered`);
      if (!r.candidateSha || !r.candidateTree || !r.evidenceRepo) return perr('invalid_input', 'evidence has no candidate commit');
      if (hasBlockers(r) && !a.allowFailingEvidence) return perr('held', 'evidence has blocking risks (failed/missing tests, claim mismatch, forbidden paths); not proposing a release', { risks: r.risks.filter((x) => x.level === 'blocker').map((x) => x.code) });
      const tree = await gitOk(['rev-parse', `${r.candidateSha}^{tree}`], { cwd: r.evidenceRepo }).catch(() => null);
      if (tree !== r.candidateTree) return perr('invalid_input', 'candidate commit is missing or changed in the evidence repository');
      const head = await resolveHead(project.remoteUrl, a.branch);
      if (head) {
        const anc = await git(['merge-base', '--is-ancestor', head, r.candidateSha], { cwd: r.evidenceRepo });
        if (anc.code !== 0) return perr('held', `remote ${a.branch} (${head.slice(0, 12)}) is not an ancestor of the candidate; rebase and re-verify first`);
      }
      const files = r.filesChanged.map((f) => f.path);
      const pr = a.pullRequest ?? null;
      if (pr && !githubRepoOf(project.remoteUrl)) return perr('invalid_input', 'pull requests are only supported for GitHub remotes');
      const cls = classifyRemoteOperation(project, pr ? { type: 'pull_request', head: a.branch, base: pr.base, changedFiles: files } : { type: 'push', branch: a.branch, changedFiles: files });
      const payload: RemotePushPayload = {
        type: 'remote_push', projectId: project.id, remoteUrl: project.remoteUrl, branch: a.branch, commitSha: r.candidateSha, treeSha: r.candidateTree,
        expectedRemoteHead: head, sourceRepo: r.evidenceRepo, pullRequest: pr, changedFiles: files, ciTriggered: cls.triggered, evidenceReportHash: r.reportHash,
      };
      const summary = `${cls.kind === 'deploy' ? 'DEPLOY ROUTE: ' : ''}${pr ? `Open PR ${a.branch} → ${pr.base}` : `Push ${r.candidateSha.slice(0, 12)} to ${a.branch}`} on ${project.id}. ${cls.reasons.join('; ')}. Tests: ${r.allTestsPassed ? 'passed (independent run)' : 'NOT passing'}.`;
      return propose(cls.kind, payload, summary, r.taskId, cls);
    },

    async proposeDeploy(a) {
      const project = o.projects.get(a.projectId);
      if (!project) return perr('not_found', `project ${a.projectId} not registered`);
      const target = o.projects.target(a.projectId, a.targetId);
      if (!target) return perr('not_found', `target ${a.targetId} not registered for ${a.projectId}`);
      if (!project.release) return perr('invalid_input', `project ${a.projectId} has no release configuration`);
      const report = a.report ?? null;
      if (!report && !a.allowWithoutEvidence) return perr('held', 'a deploy proposal needs an evidence report for the exact commit');
      if (report) {
        if (report.candidateSha !== a.commitSha) return perr('invalid_input', 'evidence is for a different commit; re-verify the exact commit to deploy');
        if (hasBlockers(report)) return perr('held', 'evidence has blocking risks; not proposing a deploy');
        const missing = report.releaseChecks.filter((c) => c.required && c.passed !== true).map((c) => c.id);
        if (missing.length) return perr('held', `required release checks did not pass: ${missing.join(', ')}`, { missing });
      }
      const head = await resolveHead(project.remoteUrl, target.sourceBranch);
      if (head !== a.commitSha) return perr('held', `${target.sourceBranch} on the remote is ${head ?? 'absent'}; only its current head can be deployed (merge first)`);
      const payload: ReleaseScriptPayload = {
        type: 'release_script', projectId: project.id, remoteUrl: project.remoteUrl, targetId: target.id, targetHash: o.projects.targetHash(project.id, target.id)!,
        sourceBranch: target.sourceBranch, commitSha: a.commitSha, artifact: a.artifact ?? null, releaseCommandsHash: releaseCommandsHash(project.release.commands),
        requiredChecks: report?.releaseChecks.map((c) => c.id) ?? [], evidenceReportHash: report?.reportHash ?? null,
      };
      const summary = `Deploy ${a.commitSha.slice(0, 12)} of ${project.id} to ${target.id} (${target.url}) with the repository release script.${payload.requiredChecks.length ? ` Release checks passed: ${payload.requiredChecks.join(', ')}.` : ''}`;
      return propose('deploy', payload, summary, report?.taskId ?? null, null);
    },

    async recheck(actionId) {
      const a = o.broker.getAction(actionId);
      if (!a) return perr('not_found', 'action not found');
      if (a.kind !== 'merge' && a.kind !== 'deploy') return perr('invalid_input', 'not a release action');
      const p = parseReleasePayload(a.payload);
      if (!p) return perr('invalid_input', 'not a release payload');
      const changed: string[] = [];
      const observed: Record<string, unknown> = {};
      const project = o.projects.get(p.projectId);
      try {
        if (!project) changed.push('project');
        else {
          if (project.remoteUrl !== p.remoteUrl) changed.push('remote');
          if (p.type === 'remote_push') {
            const head = await resolveHead(p.remoteUrl, p.branch);
            observed.remoteHead = head;
            if (head !== p.expectedRemoteHead) changed.push('remote_head');
            const tree = await gitOk(['rev-parse', `${p.commitSha}^{tree}`], { cwd: p.sourceRepo }).catch(() => null);
            if (tree !== p.treeSha) changed.push('commit');
            const cls = classifyRemoteOperation(project, p.pullRequest ? { type: 'pull_request', head: p.branch, base: p.pullRequest.base, changedFiles: p.changedFiles } : { type: 'push', branch: p.branch, changedFiles: p.changedFiles });
            observed.classification = cls.kind;
            if (cls.kind !== a.kind) changed.push('classification');
          } else {
            const head = await resolveHead(p.remoteUrl, p.sourceBranch);
            observed.sourceHead = head;
            if (head !== p.commitSha) changed.push('commit');
            const th = o.projects.targetHash(p.projectId, p.targetId);
            observed.targetHash = th ?? null;
            if (th !== p.targetHash) changed.push('target');
            if (!project.release || releaseCommandsHash(project.release.commands) !== p.releaseCommandsHash) changed.push('release_commands');
          }
        }
      } catch (e) {
        record(actionId, 'error', [], { error: (e as Error).message });
        return perr('internal', `release recheck failed: ${(e as Error).message}`);
      }
      if (!changed.length) {
        record(actionId, 'current', [], observed);
        return ok({ status: 'current' });
      }
      let cancelled = false;
      withTransaction(o.db, () => {
        record(actionId, 'stale', changed, observed);
        const c = o.broker.cancelAction(actionId, `release recheck: ${changed.join(', ')} changed since proposal`, actor);
        cancelled = c.ok;
      });
      return ok({ status: 'stale', changed, observed, cancelled });
    },

    async execute(actionId) {
      const r = await manager.recheck(actionId);
      if (!r.ok) return r;
      if (r.value.status === 'stale') return perr('approval_mismatch', `release is stale (${r.value.changed.join(', ')} changed); the approval was invalidated and the action cancelled`, { changed: r.value.changed });
      return o.broker.execute(actionId);
    },
  };
  return manager;
}
