/** Typed release preparation. Workers request; only the broker consumes owner approval. */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectRegistry } from '../delegation/projects.ts';
import type { EvidenceReport, CommandEvidence } from '../delegation/evidence.ts';
import { requiredReleaseChecks } from '../delegation/evidence.ts';
import { gitOk, remoteBranchHead } from '../delegation/git.ts';
import { cloneDetached } from '../delegation/workspace.ts';
import { buildWorkerEnv, spawnBounded } from '../delegation/runner.ts';
import { hashCanonical, sha256Hex } from '../core/hash.ts';
import { ok, perr } from '../core/result.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import type { ReleaseManager } from './manager.ts';

type Request = { projectId: string; operation: 'merge' | 'deploy'; commit: string; branch?: string; targetId?: string };
type Review = { id: string; request: Request; state: 'preparing' | 'awaiting_approval' | 'held' | 'failed'; actionId?: string; error?: string; report?: EvidenceReport };
export function createReleaseRequests(o: { root: string; projects: ProjectRegistry; manager: ReleaseManager; paused: () => boolean; clock?: Clock; notifyFailure?: (id: string, error: string) => void }) {
  const clock = o.clock ?? systemClock;
  mkdirSync(o.root, { recursive: true, mode: 0o700 });
  const jobs = new Map<string, Review>();
  const save = (j: Review) => { const f=join(o.root,`${j.id}.json`);writeFileSync(`${f}.tmp`,JSON.stringify(j,null,2),{mode:0o600});renameSync(`${f}.tmp`,f); };
  for (const f of readdirSync(o.root).filter(f=>/^rel_[\w-]+\.json$/.test(f))) {
    try { const j=JSON.parse(readFileSync(join(o.root,f),'utf8')) as Review; if(j.state==='preparing'){j.state='failed';j.error='Preparation interrupted; no release was executed. Request a fresh review.';save(j);}jobs.set(j.id,j); } catch { /* incomplete record is not executable */ }
  }
  async function prepare(j: Review) {
    try {
      const r=j.request, p=o.projects.get(r.projectId)!;
      const base=await remoteBranchHead(p.remoteUrl,r.operation==='merge'?r.branch!:o.projects.target(p.id,r.targetId!)!.sourceBranch);
      if(!base) throw new Error('Remote branch is absent; register and review a branch creation separately.');
      if(r.operation==='deploy' && base!==r.commit) throw new Error('Deploy commit must equal the current remote source branch head.');
      const repo=join(o.root,j.id);
      await cloneDetached({source:p.repoPath,dest:repo,sha:r.commit,branch:`review/${j.id}`});
      const tree=await gitOk(['rev-parse',`${r.commit}^{tree}`],{cwd:repo});
      // Deployment reviews run all registered release checks; a same-head diff must not skip them.
      const paths=(await gitOk(['diff','--name-only',base,r.commit,'--'],{cwd:repo})).split('\n').filter(Boolean);
      const patch=await gitOk(['diff','--binary',base,r.commit,'--'],{cwd:repo});
      const checks=r.operation==='deploy'?(p.releaseChecks??[]):requiredReleaseChecks(p,paths);
      const commands:CommandEvidence[]=[];
      const plan=[...(p.setupCommands??[]).map(c=>({c,group:'setup' as const})),...p.testCommands.map(c=>({c,group:'test' as const})),...checks.flatMap(x=>x.commands.map(c=>({c,group:`release_check:${x.id}` as const})))];
      if(!p.testCommands.length) throw new Error('No independent test commands registered.');
      for(const {c,group} of plan){
        if(o.paused()) throw new Error('Release preparation paused.');
        const run=await spawnBounded({spec:{argv:c.argv,cwd:repo,env:{PATH:process.env.PATH??'/usr/bin:/bin',...buildWorkerEnv(p.worker.envAllowlist,process.env,p.worker.env??{})},network:{mode:'allowlist',hosts:['*']},timeoutMs:(c.timeoutSeconds??900)*1000,label:`release-review:${c.id}`},enforcement:{osUser:null,filesystem:false,network:false}});
        commands.push({id:c.id,group,command:c.argv.join(' '),exitCode:run.exitCode,passed:run.exitCode===0&&!run.timedOut&&!run.spawnError,timedOut:run.timedOut,durationMs:run.durationMs,outputTail:''});
        if(!commands.at(-1)!.passed) throw new Error(`Independent check ${c.id} failed; no approval or release created.`);
      }
      if(await gitOk(['rev-parse','HEAD'],{cwd:repo})!==r.commit || await gitOk(['status','--porcelain','--untracked-files=no'],{cwd:repo})!=='') throw new Error('Checks changed the reviewed commit or tracked files.');
      const body:Omit<EvidenceReport,'reportHash'>={taskId:j.id,projectId:p.id,baseSha:base,candidateSha:r.commit,candidateTree:tree,evidenceRepo:repo,patchSha256:sha256Hex(patch),patchBytes:Buffer.byteLength(patch),filesChanged:paths.map(path=>({path,status:'M',added:null,deleted:null})),diffstat:{files:paths.length,insertions:0,deletions:0},commands,testsRan:true,allTestsPassed:true,releaseChecks:checks.map(c=>({id:c.id,required:true,passed:true,runbook:c.runbook??null})),worker:{status:'independent-commit-review',claimedTestsPassed:null,claimedSummary:null,claimVerified:null,sessionId:null,numTurns:null},isolation:{runner:'local-release-review',osUser:null,network:false,filesystem:false},risks:[{level:'info',code:'local_review',message:'Registered checks ran locally without OS isolation; diff line counts are not collected.'}],createdAt:clock.nowIso()};
      j.report={...body,reportHash:hashCanonical(body)};
      if(o.paused()) throw new Error('Release preparation paused.');
      const proposal=r.operation==='merge'?await o.manager.proposeRemotePush({report:j.report,branch:r.branch!}):await o.manager.proposeDeploy({projectId:p.id,targetId:r.targetId!,commitSha:r.commit,report:j.report});
      if(!proposal.ok) throw new Error(proposal.error.message);
      j.actionId=proposal.value.actionId;j.state=proposal.value.status==='awaiting_approval'?'awaiting_approval':'held';
    } catch(e){j.state='failed';j.error=(e as Error).message.slice(0,500);}
    save(j);
    if(j.state==='failed') o.notifyFailure?.(j.id,j.error??'Release preparation failed.');
  }
  return {
    status: (p:Record<string,unknown>) => p.reviewId===undefined ? ok({projects:o.projects.list().map(x=>({projectId:x.id,repoPath:x.repoPath,defaultBranch:x.defaultBranch,enabled:x.release?.enabled===true,targets:(x.deploymentTargets??[]).map(t=>({targetId:t.id,url:t.url,sourceBranch:t.sourceBranch}))}))}) : typeof p.reviewId==='string'&&jobs.has(p.reviewId)?ok(jobs.get(p.reviewId)!):perr('not_found','Release review not found.'),
    request: (p:Record<string,unknown>) => {
      if(Object.keys(p).some(k=>!['projectId','operation','commit','branch','targetId'].includes(k)) || typeof p.projectId!=='string' || !['merge','deploy'].includes(String(p.operation)) || typeof p.commit!=='string'||!/^[0-9a-f]{40}$/.test(p.commit)) return perr('invalid_input','Use projectId, operation merge/deploy and the full commit SHA.');
      const project=o.projects.get(p.projectId);
      if(!project) return perr('not_found','Project is not registered. List potts_release_status without reviewId for available targets.');
      if(!project.release?.enabled) return perr('held','Release is not enabled for this registered project; no approval was requested.');
      if(o.paused()) return perr('paused','Releases are paused.');
      if(p.operation==='merge'&&(typeof p.branch!=='string'||!/^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/.test(p.branch)||p.targetId!==undefined))return perr('invalid_input','Merge requires an exact existing branch and no targetId; it is a fast-forward push, not a GitHub PR merge.');
      if(p.operation==='deploy'&&(typeof p.targetId!=='string'||!o.projects.target(project.id,p.targetId)||p.branch!==undefined))return perr('invalid_input','Deploy requires a registered targetId and no branch.');
      const existing=[...jobs.values()].find(j=>hashCanonical(j.request)===hashCanonical(p)&&['preparing','awaiting_approval','held'].includes(j.state));
      if(existing)return ok({reviewId:existing.id,state:existing.state,actionId:existing.actionId});
      if([...jobs.values()].some(j=>j.state==='preparing'))return perr('in_flight','A release review is already preparing.');
      const j:Review={id:`rel_${randomUUID()}`,request:p as Request,state:'preparing'};jobs.set(j.id,j);save(j);void prepare(j);
      return ok({reviewId:j.id,state:j.state,note:'Independent checks are running. No merge/deploy has occurred. Check release status; approval is requested only after checks pass.'});
    },
  };
}
