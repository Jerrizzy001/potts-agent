import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerTools } from '../../integrations/openclaw/potts-broker-plugin/lib/worker-task.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import { coordinatorPrompt, COORDINATOR_PROMPT } from '../../integrations/openclaw/potts-broker-plugin/lib/worker-policy.ts';
import type { Spawner } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-task.ts';
const request = { worker:'sol', task:'Compute a synthetic arithmetic result', effort:'medium', reason:'Reasoning task', acceptanceCriteria:'Give the exact result' };

test('coordinator prefix is static, scoped and contains no direct execution/delegation bypass',()=>{
  assert.equal(coordinatorPrompt('main','potts-coordinator'),undefined);
  const a=coordinatorPrompt('potts-coordinator','potts-coordinator')!;
  assert.equal(a.systemPrompt,COORDINATOR_PROMPT);
  assert.ok(a.systemPrompt.length<4000);
  for(const n of ['exec','browser','message','sessions_spawn'])assert.ok(!a.toolsAllow.includes(n));
});

test('worker and effort choices are validated; External is never silently replaced by Sol; pause fails closed',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-routing-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    let launches=0,claudeEffort='';
    const fake=[{execute:async(_id:string,p:Record<string,unknown>)=>{claudeEffort=String(p.effort);return {content:[{type:'text' as const,text:'started'}],details:{ok:true}};}}];
    const t=createWorkerTools(cfg.value,{get:async()=>null},fake,{spawner:()=>{launches++;},controls:async()=>({paused:false})})[0]!;
    assert.equal(((await t.execute('x',{...request,effort:'off'})).details as {ok:boolean}).ok,false);assert.equal(launches,0);
    const external=await t.execute('x',{...request,worker:'external'});
    assert.equal((external.details as {automated:boolean}).automated,false);assert.equal(launches,0);
    await t.execute('x',{...request,worker:'claude',kind:'debugging',effort:'xhigh'});assert.equal(claudeEffort,'xhigh');
    await t.execute('x',{worker:'claude',task:request.task,effort:'low'});assert.equal(claudeEffort,'low');
    const unavailable=createWorkerTools(cfg.value,{get:async()=>null},fake,{spawner:()=>{launches++;},controls:async()=>{throw new Error('offline');}})[0]!;
    assert.equal(((await unavailable.execute('x',request)).details as {ok:boolean}).ok,false);assert.equal(launches,0);
    const paused=createWorkerTools(cfg.value,{get:async()=>null},fake,{spawner:()=>{launches++;},controls:async()=>({paused:true})})[0]!;
    assert.equal((await paused.execute('x',request)).content[0]!.text,'Delegation is paused.');assert.equal(launches,0);
    await t.execute('x',{...request,task:'Use api_key=sk-abcdefghijklmnopqrstuv to access this account'});assert.equal(launches,0);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('Sol runs explicitly choose model/effort; duplicate completion is ignored; wrong-model receipts fail',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-sol-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    let done:()=>void=()=>{};let args:string[]=[];
    const spawn:Spawner=(_cmd,a,o)=>{args=a;done=()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:'42'}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'lmstudio',model:'wrong'}}}}}}));o.onExit(0);};};
    const tools=createWorkerTools(cfg.value,{get:async()=>null},[],{spawner:spawn,controls:async()=>({paused:false})});
    const r=await tools[0]!.execute('x',request);const id=(r.details as {jobId:string}).jobId;
    assert.equal(args[args.indexOf('--model')+1],'openai/gpt-6.1-sol');assert.equal(args[args.indexOf('--thinking')+1],'medium');assert.ok(!args.includes('--deliver'));
    done();done();await new Promise(resolve=>setImmediate(resolve));
    const s=await tools[1]!.execute('x',{jobId:id});assert.equal((s.details as {job:{status:string}}).job.status,'failed');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('a successful Sol report verifies requested effort and preserves unavailable delivery separately',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-sol-verified-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    let done=()=>{};
    const spawn:Spawner=(_cmd,_a,o)=>{done=()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:'1572'}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));o.onExit(0);};};
    const t=createWorkerTools(cfg.value,{get:async()=>null},[],{spawner:spawn,controls:async()=>({paused:false}),sessionEffort:async()=> 'medium'});
    const r=await t[0]!.execute('x',request);done();await new Promise(resolve=>setImmediate(resolve));
    const s=await t[1]!.execute('x',{jobId:(r.details as {jobId:string}).jobId});const j=(s.details as {job:{status:string;effortVerified:boolean;delivery:string}}).job;
    assert.equal(j.status,'done');assert.equal(j.effortVerified,true);assert.equal(j.delivery,'unavailable');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('restart recovery collects a terminal receipt once and never replays an uncertain owner relay',async()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-sol-recover-'));
 try{
  const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
  const id='sol_20261007120000_12345678', dir=join(home,'worker-jobs',id);mkdirSync(dir,{recursive:true});
  const file=join(dir,'job.json');writeFileSync(file,JSON.stringify({id,worker:'sol',task:'Synthetic test',effort:'medium',model:'openai/gpt-6.1-sol',status:'running',startedAt:'2026-10-07T12:00:00Z',launcherPid:2147483647}));
  writeFileSync(join(dir,'output.json'),JSON.stringify({status:'ok',result:{payloads:[{text:'1572'}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));
  let spawns=0;const t=createWorkerTools(cfg.value,{get:async()=>null},[],{spawner:()=>{spawns++;},sessionEffort:async()=> 'medium'});
  await Promise.all([t.recover(),t.recover()]);let j=JSON.parse(readFileSync(file,'utf8'));assert.equal(j.status,'done');assert.equal(j.recovered,true);assert.equal(spawns,0);
  j.delivery='pending';j.launcherPid=2147483647;writeFileSync(file,JSON.stringify(j));await t.recover();j=JSON.parse(readFileSync(file,'utf8'));assert.equal(j.delivery,'uncertain');assert.equal(spawns,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('a finished Sol report goes straight to the owner chat and leaves a note for the coordinator, with no coordinator model turn',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-sol-relay-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242',coordinatorAgentId:'potts-coordinator'});assert.ok(cfg.ok);
    const ownerMessage='The basic checks passed. The full setup still needs testing.';
    const detailedReport='1572; '+ 'EVIDENCE '.repeat(2000);
    const rawReport=JSON.stringify({version:1,outcome:'partial',ownerMessage,detailedReport});
    let done=()=>{};const calls:string[][]=[];
    const spawn:Spawner=(_cmd,a,o)=>{calls.push(a);
      if(a[0]==='agent')done=()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:rawReport}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));o.onExit(0);};
      else if(a[0]==='message'){writeFileSync(o.outFile,'{"ok": true}');o.onExit(0);} else o.onExit(0);};
    const t=createWorkerTools(cfg.value,{get:async()=>({ownerId:'424242',key:Buffer.alloc(32)})} as never,[],{spawner:spawn,controls:async()=>({paused:false}),sessionEffort:async()=> 'medium'});
    const r=await t[0]!.execute('x',request);done();await new Promise(resolve=>setTimeout(resolve,20));
    const send=calls.find(c=>c[0]==='message')!;assert.equal(send[send.indexOf('-m')+1], 'Some work is still unfinished. '+ownerMessage);
    const note=calls.find(c=>c[2]==='chat.inject')!;assert.equal(JSON.parse(note[4]!).sessionKey,'agent:potts-coordinator:telegram:direct:424242');
    assert.equal(calls.filter(c=>c[0]==='agent').length,1,'only the Sol worker run itself');
    const j=(await t[1]!.execute('x',{jobId:(r.details as {jobId:string}).jobId})).details as {job:{delivery:string;status:string;reportedOutcome:string;report:string;rawReport:string}};assert.equal(j.job.delivery,'delivered');
    assert.equal(j.job.status,'done', 'terminal execution is separate from partial task outcome');
    assert.equal(j.job.reportedOutcome,'partial');assert.equal(j.job.report,detailedReport);assert.equal(j.job.rawReport,rawReport);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('credentials in worker briefs are rejected',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-sol-cred-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    let launches=0;const t=createWorkerTools(cfg.value,{get:async()=>null},[],{spawner:()=>{launches++;},controls:async()=>({paused:false})})[0]!;
    assert.equal(((await t.execute('x',{...request,task:'Sign in using: email owner@example.com, password Example-001. Then fill the form.'})).details as {ok:boolean}).ok,false);
    assert.equal(launches,0);
    for(const task of ['Call the API with token: ghp_abcdefghijklmnopqrstuvwx and report','Use Bearer abcdefghijklmnop1234 for the request']){
      assert.equal(((await t.execute('x',{...request,task})).details as {ok:boolean}).ok,false,task);}
    assert.equal(launches,0);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('a Sol job requested while one runs is queued, not refused, and starts when the running one finishes',async()=>{
  const home=mkdtempSync(join(tmpdir(),'potts-sol-queue-'));
  try{
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    const finishers:(()=>void)[]=[];const launched:string[]=[];
    const spawn:Spawner=(_cmd,a,o)=>{if(a[0]!=='agent')return;launched.push(a[a.indexOf('--message')+1]!);
      finishers.push(()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:'ok'}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));o.onExit(0);});};
    let n=0;const t=createWorkerTools(cfg.value,{get:async()=>null},[],{spawner:spawn,controls:async()=>({paused:false}),sessionEffort:async()=> 'medium',now:()=>new Date(Date.UTC(2026,9,8,2,0,n++))});
    await t[0]!.execute('x',{...request,task:'First job: fill the Info-Tech form'});
    const q=await t[0]!.execute('x',{...request,task:'Second job: add the street address 151 Example Blvd'});
    assert.equal((q.details as {state:string;position:number}).state,'queued');assert.match(q.content[0]!.text,/Queued behind the running Sol job \(position 1\)/);
    assert.equal(((await t[0]!.execute('x',{...request,task:'Second job: add the street address 151 Example Blvd'})).details as {state:string}).state,'duplicate');
    assert.equal(launched.length,1);
    finishers[0]!();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(launched.length,2,'queued job started after the first finished');assert.match(launched[1]!,/Second job/);
    const s=(await t[1]!.execute('x',{jobId:(q.details as {jobId:string}).jobId})).details as {job:{status:string}};assert.equal(s.job.status,'running');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('Sol mixed commentary and report payloads preserve raw evidence and deliver an honest fallback', async () => {
  const home=mkdtempSync(join(tmpdir(),'potts-sol-mixed-report-'));
  try {
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    const envelope=JSON.stringify({version:1,outcome:'completed',ownerMessage:'Everything is ready. The checks passed.',detailedReport:'FULL_MODEL_EVIDENCE'});
    const rawReport='Commentary with a material caveat.\n'+envelope;
    let done=()=>{};let sent='';
    const spawn:Spawner=(_cmd,a,o)=>{
      if(a[0]==='agent') done=()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:'Commentary with a material caveat.'},{text:envelope}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));o.onExit(0);};
      else {if(a[0]==='message'){sent=a[a.indexOf('-m')+1]!;writeFileSync(o.outFile,'{"ok":true}');}o.onExit(0);}
    };
    const t=createWorkerTools(cfg.value,{get:async()=>({ownerId:'424242',key:Buffer.alloc(32)})} as never,[],{spawner:spawn,controls:async()=>({paused:false}),sessionEffort:async()=> 'medium'});
    const result=await t[0]!.execute('x',request);done();await new Promise(resolve=>setTimeout(resolve,20));
    const {job}=(await t[1]!.execute('x',{jobId:(result.details as {jobId:string}).jobId})).details as {job:{status:string;ownerMessage:string;rawReport:string;report:string;reportedOutcome:string;delivery:string}};
    assert.equal(job.rawReport,rawReport);assert.equal(job.report,rawReport);assert.equal(job.reportedOutcome,'unknown');
    assert.equal(job.ownerMessage,sent);assert.match(sent,/completion still needs checking/);assert.ok(!sent.includes('Everything is ready'));
    assert.equal(job.status,'done');assert.equal(job.delivery,'delivered');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('failed Sol execution stores the exact selected notification without claiming the model result', async () => {
  const home=mkdtempSync(join(tmpdir(),'potts-sol-failed-report-'));
  try {
    const cfg=parsePluginConfig({pottsHome:home,ownerTelegramId:'424242'});assert.ok(cfg.ok);
    const rawReport=JSON.stringify({version:1,outcome:'completed',ownerMessage:'Everything is ready. The checks passed.',detailedReport:'FULL_MODEL_EVIDENCE'});
    let done=()=>{};let sent='';
    const spawn:Spawner=(_cmd,a,o)=>{
      if(a[0]==='agent')done=()=>{writeFileSync(o.outFile,JSON.stringify({status:'ok',result:{payloads:[{text:rawReport}],meta:{agentMeta:{terminalReceipt:{effective:{provider:'openai',model:'gpt-6.1-sol'}}}}}}));o.onExit(1);};
      else {if(a[0]==='message'){sent=a[a.indexOf('-m')+1]!;writeFileSync(o.outFile,'{"ok":true}');}o.onExit(0);}
    };
    const t=createWorkerTools(cfg.value,{get:async()=>({ownerId:'424242',key:Buffer.alloc(32)})} as never,[],{spawner:spawn,controls:async()=>({paused:false}),sessionEffort:async()=> 'medium'});
    const result=await t[0]!.execute('x',request);done();await new Promise(resolve=>setTimeout(resolve,20));
    const id=(result.details as {jobId:string}).jobId;
    const {job}=(await t[1]!.execute('x',{jobId:id})).details as {job:{status:string;ownerMessage:string;delivery:string}};
    assert.equal(job.status,'failed');assert.equal(job.delivery,'delivered');assert.equal(job.ownerMessage,sent);
    assert.match(sent,/couldn’t confirm/);assert.ok(!sent.includes('Everything is ready'));
    assert.equal(JSON.parse(readFileSync(join(home,'worker-jobs',id,'output.json'),'utf8')).result.payloads[0].text,rawReport,'raw provider evidence survives execution failure');
  }finally{rmSync(home,{recursive:true,force:true});}
});
