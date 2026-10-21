import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLearning} from '../../integrations/openclaw/potts-broker-plugin/lib/learning.ts';
import {groundOwnerProjectRequest,opinionProjectReference} from '../../integrations/openclaw/potts-broker-plugin/lib/request-grounding.ts';
import plugin from '../../integrations/openclaw/potts-broker-plugin/index.ts';

const owner='+14165550123',session=`agent:potts-coordinator:imessage:direct:${owner}`;
const request='So I wanna post this project on my LinkedIn\nprojects/potts-agent\nWhat do you think ?';
const ctx={agentId:'potts-coordinator',senderId:owner,channel:'imessage',sessionKey:session,runId:'run-1'};
const dispatch=(text=request,id='msg-1',runId='run-1')=>({runId,sessionKey:session,ctx:{AgentId:ctx.agentId,SessionKey:session,OriginatingChannel:'imessage',SenderId:owner,
  InboundAccessAuthorized:true,CommandAuthorized:true,ChatType:'direct',InboundEventKind:'user_request',MessageSidFull:id,RawBody:text}});

test('explicit project opinions are recognized without turning desire to post into drafting',()=>{
 assert.equal(opinionProjectReference(request),'projects/potts-agent');
 assert.equal(opinionProjectReference('What do you think of https://github.com/me/potts-agent?'),null);
 assert.equal(opinionProjectReference('What do you think?'),null);
 assert.equal(opinionProjectReference('Read\nprojects/potts-agent'),null);
 assert.equal(opinionProjectReference('Your thoughts?\nprojects/one\nprojects/two'),null);
});

test('fresh admission is required; stale, excluded, internal and mismatched turns never inspect',async()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-ground-'));let at=new Date('2026-10-21T14:00:00Z');let reads=0;
 const learning=createLearning({home,directory:join(home,'notes'),coordinatorId:ctx.agentId,channel:'imessage',ownerId:async()=>owner,now:()=>at});
 const options={coordinatorId:ctx.agentId,ownerId:owner,channel:'imessage',pottsHome:home,ctx,currentUserMessage:request,latestOwnerRequest:learning.latestOwnerRequest,
  inspect:async()=>{reads++;return {state:'inspected',matches:[]};}};
 try{
  assert.equal(await groundOwnerProjectRequest(options),'');
  await learning.captureDispatch(dispatch());
  const result=await groundOwnerProjectRequest(options);assert.match(result,/sourceId/);assert.match(result,/Do not turn this into drafting/);assert.equal(reads,1);
  // Message identity can correlate a host without a dispatch run ID. Neither
  // arbitrary history nor a near-matching message body substitutes for it.
  assert.equal(learning.latestOwnerRequest(session,{currentUserMessageId:'msg-1'})?.text,request);
  assert.equal(learning.latestOwnerRequest(session,{currentUserMessageId:'old-msg',currentUserMessage:request}),null);
  assert.equal(learning.latestOwnerRequest(session,{currentUserMessage:request+' quoted'}),null);
  for(const altered of [{...ctx,senderId:'stranger'},{...ctx,runId:'other-run'},{...ctx,channel:'telegram'},{...ctx,inputProvenance:{kind:'internal_system'}}])assert.equal(await groundOwnerProjectRequest({...options,ctx:altered}),'');
  at=new Date(at.getTime()+301_000);assert.equal(await groundOwnerProjectRequest(options),'');assert.equal(reads,1);
  // A replay does not refresh the persisted source's timestamp.
  await learning.captureDispatch(dispatch());assert.equal(await groundOwnerProjectRequest(options),'');
  await learning.captureDispatch(dispatch(request+'\npassword: example','msg-2'));
  assert.equal(await groundOwnerProjectRequest(options),'');assert.equal(reads,1);
 }finally{learning.close();rmSync(home,{recursive:true,force:true});}
});

test('a later admitted correction invalidates inspection already in progress',async()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-ground-race-'));
 const learning=createLearning({home,directory:join(home,'notes'),coordinatorId:ctx.agentId,channel:'imessage',ownerId:async()=>owner});
 try{
  await learning.captureDispatch(dispatch());
  const result=await groundOwnerProjectRequest({coordinatorId:ctx.agentId,ownerId:owner,channel:'imessage',pottsHome:home,ctx,currentUserMessage:request,latestOwnerRequest:learning.latestOwnerRequest,
   inspect:async()=>{await learning.captureDispatch(dispatch('Forget that project','msg-2','run-2'));return {state:'inspected',matches:[]};}});
  assert.equal(result,'');
 }finally{learning.close();rmSync(home,{recursive:true,force:true});}
});

test('registered before-prompt hook reads a uniquely named repository before the model sees the opinion request',async()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-ground-plugin-'));const repo=join(home,'potts-public');
 mkdirSync(join(repo,'.git'),{recursive:true});writeFileSync(join(repo,'.git','config'),'[remote "origin"]\n url = https://github.com/example/potts-grounding-fixture.git\n');
 writeFileSync(join(repo,'README.md'),'# Potts\nEvidence fixture: local task coordinator.');
 writeFileSync(join(home,'projects.json'),JSON.stringify({projects:[{repoPath:repo}]}));
 const hooks=new Map<string,Function>(),services:{stop?:(ctx:unknown)=>void|Promise<void>}[]=[];
 process.env.POTTS_GROUND_TEST_KEY='x'.repeat(40);
 try{
  plugin.register({pluginConfig:{pottsHome:home,learningEnabled:true,coordinatorEnabled:true,coordinatorAgentId:ctx.agentId,deliveryChannel:'imessage',deliveryTarget:owner,ingressKeyRef:'env:POTTS_GROUND_TEST_KEY'},
   logger:{info(){},warn(){},error(){}},on(name,fn){hooks.set(name,fn);},registerTool(){},registerCommand(){},registerService(s){services.push(s);}});
  const fixtureRequest=request.replace('potts-agent','potts-grounding-fixture');
  await hooks.get('reply_dispatch')!(dispatch(fixtureRequest),{});
  const result=await hooks.get('before_prompt_build')!({currentUserMessage:fixtureRequest,messages:[]},ctx);
  assert.match(result.appendContext,/pre-read project evidence/);assert.match(result.appendContext,/Evidence fixture/);assert.match(result.appendContext,/repository-name/);
  const internal=await hooks.get('before_prompt_build')!({currentUserMessage:fixtureRequest,messages:[]},{...ctx,inputProvenance:{kind:'internal_system'}});
  assert.doesNotMatch(internal.appendContext,/pre-read project evidence/);
 }finally{for(const service of services)await service.stop?.({});delete process.env.POTTS_GROUND_TEST_KEY;rmSync(home,{recursive:true,force:true});}
});
