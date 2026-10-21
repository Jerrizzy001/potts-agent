import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerTools } from '../../integrations/openclaw/potts-broker-plugin/lib/worker-task.ts';
import { createClaudeTools, type Spawner } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-task.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
const request={worker:'sol',task:'Research this synthetic task',effort:'medium'};
const tick=()=>new Promise(r=>setImmediate(r));
const details=(r:{details:unknown})=>r.details as any;
const receipt=(aborted=false)=>JSON.stringify({status:'ok',result:{payloads:[{text:'Saved result'}],meta:{aborted,agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}});
function fixture() {
 const home=mkdtempSync(join(tmpdir(),'potts-lifecycle-'));const c=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(c.ok);
 return {home,cfg:c.value,close:()=>rmSync(home,{recursive:true,force:true})};
}

test('queued pause targets exact task, survives reconstruction, and does not pause active work',async()=>{
 const f=fixture();try {
  let launches=0;const opts={spawner:()=>{launches++;},controls:async()=>({paused:false})};
  const tools=createWorkerTools(f.cfg,{get:async()=>null},[],opts);
  const first=details(await tools[0]!.execute('1',request));
  const second=details(await tools[0]!.execute('2',{...request,task:'Research a different synthetic task'}));
  assert.equal(details(await tools[2]!.execute('p',{jobId:second.jobId,action:'pause'})).verified,true);
  const reopened=createWorkerTools(f.cfg,{get:async()=>null},[],opts);
  assert.equal(details(await reopened[1]!.execute('s',{jobId:second.jobId})).job.status,'paused');
  assert.equal(details(await reopened[1]!.execute('s',{jobId:first.jobId})).job.status,'running');
  assert.equal(details(await reopened[2]!.execute('p',{jobId:second.jobId,action:'pause'})).verified,true);
  assert.equal(details(await reopened[2]!.execute('r',{jobId:second.jobId,action:'resume'})).state,'queued');
  assert.equal(launches,1);
 } finally {f.close();}
});

test('Sol abort is exact, requires a terminal stop receipt, and resumes same session without replay',async()=>{
 const f=fixture();try {
  const launches:{args:string[];o:Parameters<Spawner>[2]}[]=[];
  let target='';const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{
   spawner:(_cmd,args,o)=>{launches.push({args,o});},controls:async()=>({paused:false}),sessionEffort:async()=> 'medium',
   abortSession:async key=>{target=key;return {ok:true,status:'aborted',abortedRunId:'run-fixture'};},
  });
  const id=details(await tools[0]!.execute('1',request)).jobId;
  const stop=details(await tools[2]!.execute('p',{jobId:id,action:'pause'}));
  assert.equal(target,`agent:main:potts-worker-${id}`);assert.equal(stop.verified,false);assert.equal(stop.state,'interrupt_pending');
  const run=launches[0]!;writeFileSync(run.o.outFile,receipt(true));run.o.onExit(0);await tick();
  let job=details(await tools[1]!.execute('s',{jobId:id})).job;
  assert.equal(job.status,'interrupted');assert.equal(job.resumeVerified,true);
  await tools[2]!.execute('r',{jobId:id,action:'resume'});assert.equal(launches.length,2);
  const resumed=launches[1]!;assert.equal(resumed.args[resumed.args.indexOf('--session-key')+1],target);
  assert.match(resumed.args.at(-1)!,/Continue from the saved conversation/);assert.ok(!resumed.args.at(-1)!.includes(request.task));
  run.o.onExit(0); // stale exit cannot finish the new attempt
  job=details(await tools[1]!.execute('s',{jobId:id})).job;assert.equal(job.status,'running');
  assert.equal(readFileSync(run.o.outFile,'utf8'),receipt(true),'old checkpoint retained');
 } finally {f.close();}
});

test('orphan without completion receipt is interrupted and blocks blind queue replay',async()=>{
 const f=fixture();try {
  const id='sol_20261020000000_12345678';const dir=join(f.home,'worker-jobs',id);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'job.json'),JSON.stringify({id,task:'uncertain task',worker:'sol',status:'running',startedAt:'2026-10-20',launcherPid:2147483647}));
  let launches=0;const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{spawner:()=>{launches++;},controls:async()=>({paused:false})});
  await Promise.all([tools.recover(),tools.recover()]);
  const job=details(await tools[1]!.execute('s',{jobId:id})).job;
  assert.equal(job.phase,'interrupted');assert.equal(job.executionUncertain,true);
  assert.equal(details(await tools[2]!.execute('r',{jobId:id,action:'resume'})).ok,false);
  await tools[0]!.execute('2',request);assert.equal(launches,0);
 } finally {f.close();}
});

test('Claude confirms interruption with matching saved session and uses --resume; stale exit ignored',async()=>{
 const f=fixture();try {
  const cli=join(f.home,'claude');writeFileSync(cli,'fixture');const launches:{args:string[];o:Parameters<Spawner>[2]}[]=[];
  let signals=0;
  const tools=createClaudeTools(f.cfg,{get:async()=>null},{claudeCli:cli,controls:async()=>({paused:false}),interruptChild:()=>{signals++;},spawner:(_cmd,args,o)=>{launches.push({args,o});o.onSpawn?.(12345);}});
  const id=details(await tools[0]!.execute('1',{task:'Fix the synthetic fixture',kind:'coding',project:f.home})).jobId;
  assert.equal(details(await tools.control({jobId:id,action:'pause'})).verified,false);assert.equal(signals,1);
  const first=launches[0]!;const sid=first.args[first.args.indexOf('--session-id')+1];
  writeFileSync(first.o.outFile,JSON.stringify({result:'Stopped with partial work saved.',is_error:true,session_id:sid}));first.o.onExit(130);await tick();
  assert.equal(details(await tools[1]!.execute('s',{jobId:id})).job.resumeVerified,true);
  await tools.control({jobId:id,action:'resume'});assert.equal(launches.length,2);
  assert.equal(launches[1]!.args[launches[1]!.args.indexOf('--resume')+1],sid);
  first.o.onExit(130);assert.equal(details(await tools[1]!.execute('s',{jobId:id})).job.status,'running');
 } finally {f.close();}
});

test('Claude restart recovery retains uncertain delivery and never restarts orphan work',async()=>{
 const f=fixture();try {
  const id='cc_20261020000000_12345678';const dir=join(f.home,'claude-jobs',id);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'job.json'),JSON.stringify({id,task:'old task',project:f.home,status:'done',startedAt:'2026-10-20',launcherPid:2147483647,reportDelivery:{status:'pending',updatedAt:'2026-10-20'}}));
  let sends=0;const tools=createClaudeTools(f.cfg,{get:async()=>null},{spawner:()=>{sends++;},controls:async()=>({paused:false})});
  await Promise.all([tools.recover(),tools.recover()]);
  assert.equal(details(await tools[1]!.execute('s',{jobId:id})).job.reportDelivery.status,'uncertain');assert.equal(sends,0);
 } finally {f.close();}
});

test('concurrent Claude admission admits an exact brief once and preserves lifecycle evidence',async()=>{
 const f=fixture();try {
  const cli=join(f.home,'claude');writeFileSync(cli,'fixture');let launches=0;
  const tools=createClaudeTools(f.cfg,{get:async()=>null},{claudeCli:cli,controls:async()=>({paused:false}),spawner:()=>{launches++;}});
  const req={task:'Fix the same synthetic fixture',kind:'coding',project:f.home};
  const results=await Promise.all([tools[0]!.execute('1',req),tools[0]!.execute('2',req)]);
  assert.equal(results.filter(r=>details(r).ok).length,1);assert.equal(launches,1);
  const id=details(results.find(r=>details(r).ok)!).jobId;
  const job=details(await tools[1]!.execute('s',{jobId:id})).job;
  assert.deepEqual(job.activity.map((e:any)=>e.phase),['queued','running']);
  assert.equal(job.phase,'running');assert.equal(job.reportDelivery,undefined,'an acknowledgement is not completion or report delivery');
 } finally {f.close();}
});

test('Claude missing saved-session receipt cannot be resumed after a stop signal',async()=>{
 const f=fixture();try {
  const cli=join(f.home,'claude');writeFileSync(cli,'fixture');let completion=()=>{};let launches=0;
  const tools=createClaudeTools(f.cfg,{get:async()=>null},{claudeCli:cli,controls:async()=>({paused:false}),interruptChild:()=>{},spawner:(_c,_a,o)=>{launches++;o.onSpawn?.(12345);completion=()=>o.onExit(130);}});
  const id=details(await tools[0]!.execute('1',{task:'Fix this synthetic fixture',kind:'coding',project:f.home})).jobId;
  await tools.control({jobId:id,action:'pause'});completion();await tick();
  assert.equal(details(await tools[1]!.execute('s',{jobId:id})).job.executionUncertain,true);
  assert.equal(details(await tools.control({jobId:id,action:'resume'})).ok,false);assert.equal(launches,1);
 } finally {f.close();}
});

test('queued Sol launch rejection stays terminal, reports once, and advances to next task once',async()=>{
 const f=fixture();try {
  let attempts=0;let time=0;let completion=()=>{};
  const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{
   now:()=>new Date(Date.UTC(2026,9,20,0,0,time++)),controls:async()=>({paused:false}),sessionEffort:async()=> 'medium',
   spawner:(_cmd,args,o)=>{
    assert.equal(args[0],'agent');attempts++;
    if(attempts===2) throw new Error('synthetic queued spawn rejection');
    if(attempts>3) throw new Error('unexpected replay');
    completion=()=>{writeFileSync(o.outFile,receipt());o.onExit(0);};
   },
  });
  await tools[0]!.execute('1',request);
  const failed=details(await tools[0]!.execute('2',{...request,task:'The queued task whose launch will fail'})).jobId;
  const next=details(await tools[0]!.execute('3',{...request,task:'The queued task after the failed launch'})).jobId;
  completion();await tick();await tick();
  assert.equal(attempts,3);
  const job=details(await tools[1]!.execute('s',{jobId:failed})).job;
  assert.equal(job.status,'failed');assert.equal(job.phase,'failure');assert.equal(job.delivery,'unavailable');
  assert.equal(job.activity.filter((e:any)=>e.phase==='failure').length,1);
  assert.equal(details(await tools[1]!.execute('s',{jobId:next})).job.status,'running');
  await tools.recover();assert.equal(attempts,3,'recovery must not replay rejected launch');
 } finally {f.close();}
});

test('Sol CLI exit without an authoritative terminal receipt blocks its queued successor',async()=>{
 for(const output of ['', '{malformed', JSON.stringify({status:'error',error:'CLI timed out'})]) {
  const f=fixture();try {
   let launches=0;let finish=()=>{};
   const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{controls:async()=>({paused:false}),spawner:(_c,_a,o)=>{launches++;finish=()=>{writeFileSync(o.outFile,output);o.onExit(1);};}});
   const id=details(await tools[0]!.execute('1',request)).jobId;
   const next=details(await tools[0]!.execute('2',{...request,task:'Do the following synthetic task'})).jobId;
   finish();await tick();await tick();
   const job=details(await tools[1]!.execute('s',{jobId:id})).job;
   assert.equal(job.status,'interrupted');assert.equal(job.executionUncertain,true);assert.equal(job.finishedAt,undefined);
   assert.equal(details(await tools[1]!.execute('s',{jobId:next})).job.status,'queued');
   await tools.recover();assert.equal(launches,1,'CLI disconnect must not start overlapping work');
  } finally {f.close();}
 }
});

test('Sol pause does not mistake an uncertain CLI disconnect for a verified stop',async()=>{
 const f=fixture();try {
  let finish=()=>{};
  const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{
   controls:async()=>({paused:false}),
   spawner:(_c,_a,o)=>{finish=()=>{writeFileSync(o.outFile,JSON.stringify({status:'error',error:'connection lost'}));o.onExit(1);};},
   abortSession:async()=>{finish();await tick();return {ok:true,status:'aborted',abortedRunId:'run-fixture'};},
  });
  const id=details(await tools[0]!.execute('1',request)).jobId;
  const stop=await tools[2]!.execute('p',{jobId:id,action:'pause'});
  const job=details(await tools[1]!.execute('s',{jobId:id})).job;
  assert.equal(job.status,'interrupted');assert.equal(job.executionUncertain,true);
  assert.equal(details(stop).verified,false);assert.equal(details(stop).ok,false);
  assert.doesNotMatch(stop.content[0]!.text,/Stopped\. Your progress is saved/);
  assert.equal(details(await tools[2]!.execute('r',{jobId:id,action:'resume'})).ok,false);
 } finally {f.close();}
});

test('Sol RPC abort joins matching run receipts in either order and rejects incomplete or mismatched evidence',async()=>{
 for(const mode of ['exit-first','ack-first','mismatch','timeout','missing-ack'] as const) {
  const f=fixture();try {
   let complete=()=>{};let launches=0;
   const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{
    controls:async()=>({paused:false}),spawner:(_c,_a,o)=>{launches++;complete=()=>{writeFileSync(o.outFile,JSON.stringify(mode==='timeout'?{runId:'run-one',status:'timeout'}:{runId:'run-one',status:'timeout',summary:'aborted',stopReason:'rpc'}));o.onExit(1);};},
    abortSession:async()=>{if(mode!=='ack-first'){complete();await tick();}if(mode==='missing-ack')throw Error('ack lost');return {ok:true,status:'aborted',abortedRunId:mode==='mismatch'?'other-run':'run-one'};},
   });
   const id=details(await tools[0]!.execute('1',request)).jobId;
   await tools[2]!.execute('p',{jobId:id,action:'pause'});
   if(mode==='ack-first'){complete();await tick();}
   const job=details(await tools[1]!.execute('s',{jobId:id})).job;
   const expected=mode==='ack-first'||mode==='exit-first';
   assert.equal(job.status,'interrupted',mode);assert.equal(job.resumeVerified===true,expected,mode);assert.equal(job.executionUncertain,!expected,mode);
   assert.notEqual(job.modelVerified,true,'abort evidence does not establish model identity');
   const resumed=details(await tools[2]!.execute('r',{jobId:id,action:'resume'}));
   assert.equal(resumed.ok,expected,mode);assert.equal(launches,expected?2:1,mode);
   if(expected){const current=details(await tools[1]!.execute('s',{jobId:id})).job;assert.equal(current.controlReceipt,undefined);assert.equal(current.abortReceipt,undefined);}
  }finally{f.close();}
 }
});

test('Sol and Claude resume do not claim success when the resumed launch fails',async()=>{
 for(const kind of ['sol','claude'] as const)for(const state of ['paused','interrupted'] as const){
  const f=fixture();try{
   const id=kind==='sol'?'sol_20261020000000_12345678':'cc_20261020000000_12345678';
   const dir=join(f.home,kind==='sol'?'worker-jobs':'claude-jobs',id);mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'job.json'),JSON.stringify({id,worker:kind,task:'Synthetic resumable task',project:f.home,effort:'medium',status:state,startedAt:'2026-10-20',resumeVerified:state==='interrupted',executionUncertain:false,sessionId:'fixture-session'}));
   const opts={controls:async()=>({paused:false}),spawner:()=>{throw Error('launch unavailable');}};
   let r;
   if(kind==='sol'){const tools=createWorkerTools(f.cfg,{get:async()=>null},[],opts);r=await tools[2]!.execute('resume',{jobId:id,action:'resume'});}
   else{const tools=createClaudeTools(f.cfg,{get:async()=>null},opts);r=await tools.control({jobId:id,action:'resume'});}
   assert.equal(details(r).ok,false,`${kind} ${state}`);assert.equal(details(r).verified,false);assert.equal(details(r).state,'failed');
   assert.doesNotMatch(r.content[0]!.text,/^Resumed/);
  }finally{f.close();}
 }
});

test('Sol restart recovery reconciles only matching persisted RPC interruption receipts',async()=>{
 for(const matching of [true,false]){
  const f=fixture();try{
   const id='sol_20261020000000_12345678';const dir=join(f.home,'worker-jobs',id);mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'job.json'),JSON.stringify({id,worker:'sol',task:'Synthetic interrupted task',effort:'medium',status:'running',startedAt:'2026-10-20',launcherPid:2147483647,interruptRequested:true,controlReceipt:{ok:true,status:'aborted',abortedRunId:matching?'same-run':'another-run'}}));
   writeFileSync(join(dir,'output.json'),JSON.stringify({runId:'same-run',status:'timeout',summary:'aborted',stopReason:'rpc'}));
   let launches=0;const tools=createWorkerTools(f.cfg,{get:async()=>null},[],{controls:async()=>({paused:false}),spawner:()=>{launches++;}});
   await tools.recover();const job=details(await tools[1]!.execute('s',{jobId:id})).job;
   assert.equal(job.status,'interrupted');assert.equal(job.resumeVerified===true,matching);assert.equal(job.executionUncertain,!matching);
   assert.equal(launches,0,'recovery alone never resumes a task');
  }finally{f.close();}
 }
});
