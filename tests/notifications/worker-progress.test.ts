import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {workerBriefingItems} from '../../src/notifications/worker-progress.ts';
test('daily briefing includes both workers and preserves incomplete outcomes and uncertain delivery',()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-progress-'));
 try {
  const add=(folder:string,id:string,j:object)=>{const dir=join(home,folder,id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'job.json'),JSON.stringify({id,finishedAt:'2026-10-21T01:00:00Z',...j}));};
  add('worker-jobs','sol_1',{status:'done',reportedOutcome:'completed',ownerMessage:'Your draft is ready.',reportFormat:'structured',delivery:'delivered'});
  add('claude-jobs','cc_2',{status:'done',reportedOutcome:'partial',ownerMessage:'The upload still needs checking.',reportFormat:'structured',reportDelivery:{status:'uncertain'}});
  add('worker-jobs','sol_3',{status:'running'});
  add('worker-jobs','sol_4',{status:'done',finishedAt:'2026-10-01T00:00:00Z'});
  const progress=workerBriefingItems(home,'2026-10-20T13:00:00Z','progress');
  assert.equal(progress.length,1);assert.match(progress[0]!.text,/draft is ready/);
  const unfinished=workerBriefingItems(home,'2026-10-20T13:00:00Z','unfinished');
  assert.match(unfinished.map(x=>x.text).join(' '),/unfinished.*upload.*not been confirmed/s);
  assert.deepEqual(unfinished.map(x=>x.ref).sort(),['cc_2','sol_3']);
  assert.doesNotMatch(unfinished.map(x=>x.text).join(' '),/draft is ready/);
 }finally{rmSync(home,{recursive:true,force:true});}
});
