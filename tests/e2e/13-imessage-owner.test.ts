import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {makeHome,startWorld,INGRESS_KEY} from './_harness.ts';
import {parsePluginConfig} from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';
import {createOwnerHandlers} from '../../integrations/openclaw/potts-broker-plugin/lib/owner.ts';
import {createReplayCache} from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
import {runCheck} from '../../src/daemon/check.ts';

test('configured iMessage owner controls and memory reach real daemon sockets',async()=>{
 const ownerId='+14165550123';const home=makeHome({potts(c){Object.assign(c.owner as object,{channel:'imessage',imessageOwnerId:ownerId});(c.monitoring as {enabled:boolean}).enabled=false;}});
 const w=await startWorld({home,start:'2026-10-20T14:00:00Z'});
 try{
  await w.d.start({timers:false});const parsed=parsePluginConfig({pottsHome:home,deliveryChannel:'imessage',deliveryTarget:ownerId,readSocket:join(home,'run/read.sock'),memoryControlSocket:join(home,'run/memory-control.sock')});assert.ok(parsed.ok);
  const caps=new Map(w.d.capabilities().map(c=>[c.id,c]));
  assert.equal(caps.get('imessage')?.label,'iMessage owner interface');
  assert.equal(caps.has('telegram'),false,'status must describe the configured owner channel');
  assert.match(caps.get('local-drafts')!.reason,/delegated worker file access is separate/);
  assert.equal(caps.get('memory')?.label,'Daemon fact memory');
  const h=createOwnerHandlers({cfg:parsed.value,secrets:{get:async()=>({ownerId,key:Buffer.from(INGRESS_KEY)})},replay:createReplayCache(),log(){},now:()=>w.clock.now()});
  const ctx={channel:'imessage',isAuthorizedSender:true,senderId:ownerId,from:`imessage:${ownerId}`,commandBody:'/pause',assertOwnerCurrent(){}};
  await h.handleCommand('pause',ctx);assert.equal(w.d.broker.controls().globalPaused,true);
  await h.handleCommand('resume',{...ctx,commandBody:'/resume'});assert.equal(w.d.broker.controls().globalPaused,false);
  const remembered=await h.handleCommand('potts',{...ctx,commandBody:'/potts remember Prefer concise updates.',args:'remember Prefer concise updates.'});
  assert.match(remembered.text,/remember/);
  assert.doesNotMatch(remembered.text,/invalid|malformed|wrong|unavailable|failed/i);
  assert.equal(w.keychainReads.includes('potts/telegram-owner-id'),false,'iMessage daemon does not require Telegram identity');
  await h.handleCommand('pause',{...ctx,senderId:'+14165550456'});assert.equal(w.d.broker.controls().globalPaused,false);
 }finally{await w.close();}
});

test('offline iMessage readiness uses configured owner identity without requiring Telegram secrets',async()=>{
 const home=makeHome({potts(c){Object.assign(c.owner as object,{channel:'imessage',imessageOwnerId:'+14165550123'});(c.monitoring as {enabled:boolean}).enabled=false;}});
 const w=await startWorld({home,start:'2026-10-20T14:00:00Z'});
 try{
  const reads:string[]=[];
  const check=await runCheck({home,clock:w.clock,secrets:{keychainLookup:async name=>{reads.push(name);if(name==='potts/ingress-hmac-key')return INGRESS_KEY;throw new Error('not configured');}}});
  assert.equal(reads.includes('potts/telegram-owner-id'),false);
  assert.match(check.text,/owner:imessage identity\s+OK/);
  assert.match(check.text,/iMessage owner interface/);
 }finally{await w.close();}
});
