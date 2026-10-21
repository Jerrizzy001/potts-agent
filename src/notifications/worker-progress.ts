/** Read the plugin workers' durable records without treating a stopped run as completed work. */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BriefingItem } from './briefings.ts';

interface Job { id:string; status:string; finishedAt?:string; startedAt?:string; reportedOutcome?:string; ownerMessage?:string; reportFormat?:string; delivery?:string; reportDelivery?:string|{status?:string} }
export function workerBriefingItems(home:string, sinceIso:string, view:'progress'|'unfinished'): BriefingItem[] {
  const jobs:Job[]=[];
  for(const folder of ['worker-jobs','claude-jobs']) {
    const dir=join(home,folder);
    let entries:string[];
    try { if(lstatSync(dir).isSymbolicLink()) throw new Error('Worker activity directory is not a regular directory'); entries=readdirSync(dir); }
    catch(e){ if((e as NodeJS.ErrnoException).code==='ENOENT')continue; throw e; }
    for(const id of entries.filter(x=>/^(sol|cc)_[A-Za-z0-9_]+$/.test(x)).sort().reverse().slice(0,500)) {
      const parent=join(dir,id), path=join(parent,'job.json');
      if(lstatSync(parent).isSymbolicLink())continue;
      try {
        const stat=lstatSync(path);if(!stat.isFile()||stat.size>2_000_000)continue;
        const j=JSON.parse(readFileSync(path,'utf8')) as Job;
        if(j.id===id && typeof j.status==='string')jobs.push(j);
      } catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
    }
  }
  const since=Date.parse(sinceIso);
  const progress=jobs.filter(j=>j.status==='done'&&j.reportedOutcome==='completed'&&Date.parse(j.finishedAt??'')>=since);
  const unfinished=jobs.filter(j=>['queued','running','verifying','paused','interrupted'].includes(j.status)||(['failed','done'].includes(j.status)&&Date.parse(j.finishedAt??j.startedAt??'')>=since&&(j.status==='failed'||j.reportedOutcome!=='completed')));
  const selected=view==='progress'?progress:unfinished;
  return selected.sort((a,b)=>(b.finishedAt??b.startedAt??'').localeCompare(a.finishedAt??a.startedAt??'')).map(j=>{
    let text:string;
    if(j.status==='done')text=j.reportedOutcome==='completed'?'A delegated task finished.':j.reportedOutcome==='partial'?'A delegated task ended with some work unfinished.':j.reportedOutcome==='blocked'?'A delegated task is blocked.':'A delegated task run ended, but completion still needs checking.';
    else text=({queued:'A delegated task is waiting to start.',running:'A delegated task is still running.',verifying:'A delegated task is being checked.',paused:'A delegated task is paused.',interrupted:'A delegated task was interrupted and needs checking.',failed:'A delegated task failed.'} as Record<string,string>)[j.status]??'A delegated task needs checking.';
    if(j.status==='done'&&j.reportFormat==='structured'&&typeof j.ownerMessage==='string'&&j.ownerMessage.length<=500)text+=' '+j.ownerMessage;
    const delivery=j.delivery??(typeof j.reportDelivery==='string'?j.reportDelivery:j.reportDelivery?.status);
    if(delivery==='failed'||delivery==='uncertain')text+=' Its update has not been confirmed as delivered.';
    return {text,ref:j.id};
  });
}
