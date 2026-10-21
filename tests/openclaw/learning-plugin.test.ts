import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import plugin from '../../integrations/openclaw/potts-broker-plugin/index.ts';

test('registered owner inbound hook captures correction and enriches only the owner turn',async()=>{
 const home=mkdtempSync(join(tmpdir(),'potts-learning-plugin-'));
 const hooks=new Map<string,Function>();const services:{stop?:(ctx:unknown)=>void|Promise<void>}[]=[];
 process.env.POTTS_LEARNING_TEST_KEY='x'.repeat(40);
 try{
  plugin.register({pluginConfig:{pottsHome:home,learningEnabled:true,coordinatorEnabled:true,coordinatorAgentId:'potts-coordinator',deliveryChannel:'imessage',deliveryTarget:'+14165550123',ingressKeyRef:'env:POTTS_LEARNING_TEST_KEY'},
   logger:{info(){},warn(){},error(){}},on(name:string,fn:Function){hooks.set(name,fn);},registerTool(){},registerCommand(){},registerService(s){services.push(s);}});
  const sessionKey='agent:potts-coordinator:imessage:direct:+14165550123';
  // Host reply_dispatch contract from the installed normal iMessage route.
  // Unlike a plugin-owned binding, this route never fires inbound_claim.
  const admitted={AgentId:'potts-coordinator',SessionKey:sessionKey,OriginatingChannel:'imessage',SenderId:'+14165550123',
   InboundAccessAuthorized:true,CommandAuthorized:true,ChatType:'direct',InboundEventKind:'user_request',
   MessageSidFull:'synthetic-1',RawBody:"Don't call me bro.",Body:'Untrusted quoted material must not become owner memory.'};
  assert.equal(await hooks.get('reply_dispatch')!({ctx:admitted,sessionKey},{}),undefined);
  await hooks.get('reply_dispatch')!({ctx:admitted,sessionKey},{});
  const ctx={agentId:'potts-coordinator',sessionKey,senderId:'+14165550123',channel:'imessage'};
  const owner=await hooks.get('before_prompt_build')!({currentUserMessage:'what should you call me?',messages:[]},ctx);
  assert.match(owner.appendContext,/Don't call me bro/);
  assert.doesNotMatch(owner.appendContext,/Untrusted quoted material/);
  const other=await hooks.get('before_prompt_build')!({currentUserMessage:'what do you know?',messages:[]},{...ctx,senderId:'+14165550456'});
  assert.equal(other.appendContext,undefined);
 }finally{for(const s of services)await s.stop?.({});delete process.env.POTTS_LEARNING_TEST_KEY;rmSync(home,{recursive:true,force:true});}
});
