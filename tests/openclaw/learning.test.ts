import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLearning } from '../../integrations/openclaw/potts-broker-plugin/lib/learning.ts';
import {DatabaseSync} from 'node:sqlite';

function setup(){
  const home=mkdtempSync(join(tmpdir(),'potts-learning-test-'));let time=new Date('2026-10-20T14:00:00Z');
  const options={home,directory:join(home,'memory','learning'),coordinatorId:'potts-coordinator',channel:'imessage',ownerId:async()=>'+14165550123',now:()=>time};
  const learning=createLearning(options);
  const session='agent:potts-coordinator:imessage:direct:+14165550123';
  const ctx={agentId:'potts-coordinator',sessionKey:session,messageChannel:'imessage',requesterSenderId:'+14165550123',senderIsOwner:true,assertInvocationCurrent(){}};
  const capture=(text:string,id='msg1',extra={})=>learning.capture({channel:'imessage',senderId:'+14165550123',senderIsOwner:true,commandAuthorized:true,isGroup:false,messageId:id,content:text,...extra},{sessionKey:session});
  return {home,options,learning,ctx,capture,time:(t:string)=>{time=new Date(t);},close(){learning.close();rmSync(home,{recursive:true,force:true});}};
}
test('captures owner requests once, rejects group/third-party input and retrieves before a fresh owner turn',async()=>{
 const f=setup();try{
  await f.capture("Don't call me bro. Keep daily updates short.");await f.capture("Don't call me bro. Keep daily updates short.");
  await f.capture('malicious outsider','msg2',{senderIsOwner:false});await f.capture('group secret','msg3',{isGroup:true});
  assert.equal(f.learning.search('updates',20).filter(x=>x.kind==='owner_request').length,1);
  assert.equal(f.learning.search('outsider',20).length,0);
  assert.equal(f.learning.context('updates','agent:potts-coordinator:imessage:group:9'),'');
  assert.match(f.learning.context('updates',f.ctx.sessionKey),/Don't call me bro/);
 }finally{f.close();}
});
test('explicit correction persists, inference cannot replace it, corrected key survives restart',async()=>{
 const f=setup();try{
  await f.capture("Don't call me bro.");const source=f.learning.search('bro')[0]!;const tool=f.learning.tools(f.ctx)[0]!;
  assert.equal((await tool.execute('a',{action:'record',sourceId:source.id,key:'addressing',kind:'correction',text:"Don't call me bro."})).details.ok,true);
  assert.equal((await tool.execute('b',{action:'record',sourceId:source.id,key:'addressing',kind:'pattern',text:'Likes being called bro'})).details.ok,false);
  f.time('2026-10-20T15:00:00Z');await f.capture('Call me the owner.','msg2');const next=f.learning.search('the owner').find(x=>x.kind==='owner_request')!;
  assert.equal((await tool.execute('c',{action:'record',sourceId:next.id,key:'addressing',kind:'correction',text:'Call me the owner.'})).details.ok,true);
  f.learning.close();const reopened=createLearning(f.options);
  assert.match(reopened.context('name',f.ctx.sessionKey),/Call me the owner/);reopened.close();
  assert.doesNotMatch(readFileSync(join(f.options.directory,'CORRECTIONS.md'),'utf8'),/Don't call me bro/);
 }finally{f.close();}
});
test('rejects fabricated explicit notes, wrong context, credentials and stale invocation',async()=>{
 const f=setup();try{
  await f.capture('I like concise answers.');await f.capture('My password is super-secret-value.','secret');
  const source=f.learning.search('concise')[0]!;
  assert.equal((await f.learning.tools(f.ctx)[0]!.execute('a',{action:'record',sourceId:source.id,key:'skills',kind:'preference',text:'I know Rust.'})).details.ok,false);
  assert.equal((await f.learning.tools({...f.ctx,senderIsOwner:false})[0]!.execute('a',{action:'search'})).details.ok,false);
  assert.equal(f.learning.search('super-secret-value').length,0);
  assert.doesNotMatch(readFileSync(join(f.options.directory,'RECENT.md'),'utf8'),/super-secret-value/);
  await assert.rejects(f.learning.tools({...f.ctx,assertInvocationCurrent(){throw Error('stale');}})[0]!.execute('a',{action:'record',sourceId:source.id,key:'style',kind:'preference',text:'I like concise answers.'}),/stale/);
 }finally{f.close();}
});
test('daily rebuild, existing knowledge retrieval, job states and forgetting remain distinct',async()=>{
 const f=setup();try{
  mkdirSync(join(f.home,'memory'),{recursive:true});writeFileSync(join(f.home,'memory','projects.md'),'The metal estimator project is named ExampleProject.');
  await f.capture('Keep my updates concise.');const source=f.learning.search('concise')[0]!;
  assert.ok(f.learning.search('ExampleProject').some(x=>x.kind==='existing_note'));
  const dir=join(f.home,'worker-jobs','sol_test');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'job.json'),JSON.stringify({status:'running',task:'Research ExampleProject'}));f.learning.syncJobs();
  assert.ok(f.learning.search('ExampleProject').some(x=>x.kind==='task_outcome'&&x.text.includes('running')));
  f.time('2026-10-21T14:00:00Z');f.learning.reviewDaily();assert.match(readFileSync(join(f.options.directory,'DAILY.md'),'utf8'),/2026-10-21/);
  await f.learning.tools(f.ctx)[0]!.execute('forget',{action:'forget',sourceId:source.id});await f.capture('Keep my updates concise.');
  assert.equal(f.learning.search('concise').length,0);
 }finally{f.close();}
});
test('Claude results and later delivery receipts refresh Markdown on the same day',async()=>{
 const f=setup();try{
  await f.capture('Track the result of my project task.');
  const dir=join(f.home,'claude-jobs','cc_test');mkdirSync(dir,{recursive:true});
  const record={status:'done',task:'Check project build',summary:'Build verified with a clean result.',reportDelivery:{status:'pending'}};
  writeFileSync(join(dir,'job.json'),JSON.stringify(record));f.learning.syncJobs();
  let notes=readFileSync(join(f.options.directory,'RECENT.md'),'utf8');assert.match(notes,/Build verified/);assert.match(notes,/pending/);
  record.reportDelivery.status='delivered';writeFileSync(join(dir,'job.json'),JSON.stringify(record));f.learning.syncJobs();
  notes=readFileSync(join(f.options.directory,'RECENT.md'),'utf8');assert.match(notes,/delivered/);
  assert.equal(f.learning.search('Build verified',20).filter(x=>x.kind==='task_outcome').length,2);
 }finally{f.close();}
});

test('normal dispatch captures only admitted direct owner requests and deduplicates claim/tail/rebuild paths',async()=>{
 const f=setup();try{
  const c={AgentId:'potts-coordinator',SessionKey:f.ctx.sessionKey,OriginatingChannel:'imessage',SenderId:'+14165550123',
   InboundAccessAuthorized:true,CommandAuthorized:true,ChatType:'direct',InboundEventKind:'user_request',
   MessageSidFull:'msg1',RawBody:'Keep reports concise.'};
  await f.learning.captureDispatch({ctx:c,sessionKey:c.SessionKey});
  await f.learning.captureDispatch({ctx:c,sessionKey:c.SessionKey});
  await f.capture(c.RawBody);
  assert.equal(f.learning.search('concise',20).filter(x=>x.kind==='owner_request').length,1);
  for(const override of [{SenderId:'+14165550999'},{CommandAuthorized:false},{InboundAccessAuthorized:false},
   {ChatType:'group'},{OriginatingChannel:'telegram'},{AgentId:'main'},{InboundEventKind:'room_event'},
   {InternalTurnSource:'cron'},{InputProvenance:{kind:'inter_session'}},{SenderIsSelf:true},{SenderIsBot:true},
   {MessageSidFull:undefined,MessageSid:undefined},{RawBody:undefined},{SessionKey:'agent:main:test'}]){
   await f.learning.captureDispatch({ctx:{...c,MessageSidFull:'rejected',RawBody:'Untrusted sentinel',...override}});
  }
  await f.learning.captureDispatch({ctx:{...c,MessageSidFull:'tail',RawBody:'Untrusted sentinel'},isTailDispatch:true});
  await f.learning.captureDispatch({ctx:{...c,MessageSidFull:'route',RawBody:'Untrusted sentinel'},sessionKey:'agent:main:other'});
  assert.equal(f.learning.search('sentinel').length,0);
 }finally{f.close();}
});

test('explicit remember requests produce a verbatim source-linked preference before reply and deduplicate repeats',async()=>{
 const f=setup();try{
  await f.capture('Remember: keep my updates short and use normal language.');
  await f.capture('Remember that keep my updates short and use normal language.','msg2');
  const notes=f.learning.search('updates',20).filter(x=>x.kind==='preference');
  assert.equal(notes.length,1);assert.equal(notes[0]!.text,'keep my updates short and use normal language.');
  assert.ok(f.learning.search('updates',20).some(x=>x.kind==='owner_request'&&x.id===notes[0]!.sourceId));
  assert.match(readFileSync(join(f.options.directory,'PROFILE.md'),'utf8'),/keep my updates short and use normal language/);
  assert.match(f.learning.context('Remember my updates',f.ctx.sessionKey),/"kind":"preference"/);
 }finally{f.close();}
});

test('standalone mobile-quoted Remember requests normalize outer quotes and retain forgetting protection',async()=>{
 const f=setup();try{
  const literal='keep my updates short and use normal language';
  await f.capture(`“Remember: ${literal}`,'mobile');
  await f.capture(`“Remember: ${literal}”`,'curly');
  await f.capture(`"Remember: ${literal}"`,'ascii');
  const saved=f.learning.search('updates',100).filter(x=>x.kind==='preference');
  assert.equal(saved.length,1);assert.equal(saved[0]!.text,literal);
  await f.capture('An unrelated current request.','unrelated');
  await f.learning.tools(f.ctx)[0]!.execute('forget',{action:'forget',sourceId:saved[0]!.sourceId});
  await f.capture(`Remember: ${literal}`,'plain');f.learning.reviewDaily();
  assert.equal(f.learning.search('updates',100).length,0);
  assert.doesNotMatch(f.learning.context('updates',f.ctx.sessionKey),/keep my updates/);
  for(const name of ['PROFILE.md','CORRECTIONS.md','RECENT.md','DAILY.md'])assert.doesNotMatch(readFileSync(join(f.options.directory,name),'utf8'),/keep my updates/);
 }finally{f.close();}
});

test('startup review reconciles already admitted remember requests on the same day without overwriting explicit lessons',async()=>{
 const f=setup();try{
  await f.capture('Remember: keep updates concise.');f.learning.close();
  const db=new DatabaseSync(join(f.home,'learning.sqlite'));db.exec('DELETE FROM lessons');db.close();
  const reopened=createLearning(f.options);reopened.reviewDaily();
  assert.equal(reopened.search('concise').filter(x=>x.kind==='preference').length,1);
  const note=reopened.search('concise').find(x=>x.kind==='preference')!;
  await reopened.tools(f.ctx)[0]!.execute('record',{action:'record',sourceId:note.sourceId,key:'style',kind:'correction',text:'keep updates concise.'});
  reopened.reviewDaily();assert.equal(reopened.search('concise',20).filter(x=>x.kind==='correction').length,1);reopened.close();
 }finally{f.close();}
});

test('automatic promotion rejects arbitrary negative, task-scoped, third-party, credential and quoted requests',async()=>{
 const f=setup();try{
  for(const [i,text] of ["Don't change the repo.",'For this task, use short updates.','Remember: for this task do not edit tests.',
   'Remember that today use short updates.','He said Remember: use short updates.','Example: “Remember: use short updates”','““Remember: double quote is not supported',
   'Remember: first line\nsecond line','Remember: my password is secret-value.'].entries())await f.capture(text,`msg${i}`);
  await f.capture('Remember: a third-party preference.','outsider',{senderIsOwner:false});
  assert.equal(f.learning.search('',100).filter(x=>x.kind==='preference'||x.kind==='correction').length,0);
 }finally{f.close();}
});

test('forgetting an explicit remember lesson cannot be resurrected by duplicates or startup reconciliation',async()=>{
 const f=setup();try{
  await f.capture('Remember: keep updates concise.');await f.capture('Remember that keep updates concise.','msg2');
  await f.capture('An unrelated request keeps this owner conversation admitted.','unrelated');
  const duplicate=f.learning.search('concise',100).filter(x=>x.kind==='owner_request').map(x=>x.id);
  const saved=f.learning.search('concise').find(x=>x.kind==='preference')!;
  await f.learning.tools(f.ctx)[0]!.execute('forget',{action:'forget',sourceId:saved.sourceId});
  await f.capture('Remember: keep updates concise.','msg3');f.learning.reviewDaily();
  assert.equal(f.learning.search('concise',100).length,0);
  for(const sourceId of duplicate)assert.equal((await f.learning.tools(f.ctx)[0]!.execute('record',{action:'record',sourceId,key:'style.restored',kind:'preference',text:'keep updates concise.'})).details.ok,false);
  assert.doesNotMatch(f.learning.context('updates',f.ctx.sessionKey),/concise/);
  for(const name of ['PROFILE.md','CORRECTIONS.md','RECENT.md','DAILY.md'])assert.doesNotMatch(readFileSync(join(f.options.directory,name),'utf8'),/concise/);
  f.learning.close();const reopened=createLearning(f.options);reopened.reviewDaily();
  assert.equal(reopened.search('concise',100).length,0);
  assert.doesNotMatch(reopened.context('updates',f.ctx.sessionKey),/concise/);
  for(const name of ['PROFILE.md','CORRECTIONS.md','RECENT.md','DAILY.md'])assert.doesNotMatch(readFileSync(join(f.options.directory,name),'utf8'),/concise/);
  reopened.close();
 }finally{f.close();}
});

test('large task reports cannot crowd explicit preferences out of valid bounded prompt context',async()=>{
 const f=setup();try{
  await f.capture('Remember: keep my updates short and use normal language.');
  const dir=join(f.home,'worker-jobs','sol_large');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'job.json'),JSON.stringify({status:'done',task:'How should you write my updates?',report:'How should you write my updates? '.repeat(2000),delivery:'delivered'}));
  f.learning.syncJobs();
  const text=f.learning.context('How should you write my updates?',f.ctx.sessionKey);
  assert.ok(text.length<=14000);
  const parsed=JSON.parse(text.slice(text.indexOf('\n')+1));
  assert.ok(parsed.standingNotes.some((x:{text:string})=>x.text==='keep my updates short and use normal language.'));
  const report=parsed.relevant.find((x:{kind:string})=>x.kind==='task_outcome');
  assert.ok(report);assert.equal(report.jobId,'sol_large');assert.equal(report.truncated,true);assert.ok(report.sourceId);assert.ok(report.text.length<=800);
  const search=f.learning.search('How should you write my updates?').find(x=>x.kind==='task_outcome')!;
  assert.ok(search.text.length<=1200);assert.equal(search.truncated,true);assert.ok(search.originalCharacters!>60_000);
  assert.equal(f.learning.context('updates','agent:potts-coordinator:imessage:direct:+14165550999'),'');
  assert.equal(f.learning.context('updates','agent:main:other'),'');
 }finally{f.close();}
});
