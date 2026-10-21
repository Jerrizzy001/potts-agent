/**
 * CI guard: classifies a remote repository operation using the project's
 * registered CI trigger notes. Any push / pull request / tag / dispatch /
 * publication that can trigger a deployment is a `deploy` (exact-change owner
 * approval); every other remote write is a `merge` (also always approval).
 * Unknown CI configuration fails closed to `deploy`.
 */
import { globToRegExp, matchesAny } from '../delegation/glob.ts';
import type { CiWorkflow, ProjectEntry } from '../delegation/projects.ts';

export type RemoteOperation =
  | { type: 'push'; branch: string; changedFiles?: readonly string[] }
  | { type: 'pull_request'; head: string; base: string; changedFiles?: readonly string[] }
  | { type: 'tag'; tag: string }
  | { type: 'workflow_dispatch'; workflowFile: string }
  | { type: 'delete_branch'; branch: string }
  | { type: 'publish_package' };

export interface Classification {
  kind: 'merge' | 'deploy';
  reasons: string[];
  /** Workflows the operation is expected to trigger. */
  triggered: string[];
}

const refMatches = (patterns: readonly string[] | undefined, name: string) => patterns === undefined || patterns.some((p) => globToRegExp(p).test(name));

function triggeredBy(wfs: readonly CiWorkflow[], pred: (w: CiWorkflow) => boolean): CiWorkflow[] {
  return wfs.filter(pred);
}

export function classifyRemoteOperation(project: Pick<ProjectEntry, 'ci' | 'defaultBranch' | 'deploymentTargets'>, op: RemoteOperation): Classification {
  const ci = project.ci;
  const reasons: string[] = [];
  const triggered = new Set<string>();
  let deploy = false;
  const mark = (wfs: CiWorkflow[], what: string) => {
    for (const w of wfs) {
      triggered.add(w.file);
      if (w.deploys) {
        deploy = true;
        reasons.push(`${what} triggers ${w.name ?? w.file}, which deploys`);
      } else reasons.push(`${what} triggers ${w.name ?? w.file} (CI only)`);
    }
  };
  if (!ci || (ci.provider !== 'none' && !Array.isArray(ci.workflows))) return { kind: 'deploy', reasons: ['CI configuration unknown: treated as a deploy route'], triggered: [] };
  const wfs = ci.provider === 'none' ? [] : ci.workflows;
  const wfGlobs = [...(ci.workflowPathPatterns ?? []), '.github/**'];
  const touchesCi = (files?: readonly string[]) => (files ?? []).filter((f) => matchesAny(f, wfGlobs));
  const pushTo = (branch: string, files?: readonly string[]) => {
    mark(triggeredBy(wfs, (w) => w.triggers.some((t) => t.event === 'push' && (t.tags === undefined || t.branches !== undefined) && refMatches(t.branches, branch))), `push to ${branch}`);
    const ciFiles = touchesCi(files);
    if (ciFiles.length) {
      deploy = true;
      reasons.push(`change edits CI configuration (${ciFiles.join(', ')}); workflows from a pushed branch can run with repository secrets`);
    }
    for (const t of project.deploymentTargets ?? []) if (t.sourceBranch === branch) {
      deploy = true;
      reasons.push(`${branch} is the release source branch of target ${t.id}`);
    }
  };
  switch (op.type) {
    case 'push':
      pushTo(op.branch, op.changedFiles);
      break;
    case 'pull_request':
      pushTo(op.head, op.changedFiles);
      mark(triggeredBy(wfs, (w) => w.triggers.some((t) => (t.event === 'pull_request' || t.event === 'pull_request_target') && refMatches(t.branches, op.base))), `pull request into ${op.base}`);
      break;
    case 'tag':
      mark(triggeredBy(wfs, (w) => w.triggers.some((t) => (t.event === 'push' && t.tags !== undefined && refMatches(t.tags, op.tag)) || t.event === 'tag' || t.event === 'release')), `tag ${op.tag}`);
      break;
    case 'workflow_dispatch': {
      const w = wfs.find((x) => x.file === op.workflowFile);
      if (!w) {
        deploy = true;
        reasons.push(`workflow ${op.workflowFile} is not registered: treated as a deploy`);
      } else mark([w], `dispatch of ${op.workflowFile}`);
      break;
    }
    case 'delete_branch':
      if (op.branch === project.defaultBranch || (project.deploymentTargets ?? []).some((t) => t.sourceBranch === op.branch)) {
        deploy = true;
        reasons.push(`deleting ${op.branch} changes a release source branch`);
      }
      mark(triggeredBy(wfs, (w) => w.triggers.some((t) => t.event === 'push' && refMatches(t.branches, op.branch))), `delete of ${op.branch}`);
      break;
    case 'publish_package':
      deploy = true;
      reasons.push('package publication is a release route');
      break;
  }
  if (!reasons.length) reasons.push('remote write with no deploying CI trigger (still needs owner approval)');
  return { kind: deploy ? 'deploy' : 'merge', reasons, triggered: [...triggered].sort() };
}
