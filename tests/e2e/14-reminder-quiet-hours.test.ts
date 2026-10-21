import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, startWorld, INGRESS_KEY } from './_harness.ts';
import { createOwnerReminderTools } from '../../integrations/openclaw/potts-broker-plugin/lib/owner-reminders.ts';
test('owner reminder tool → persistent database → actual daemon schedule → overnight hold → next-morning delivery once',async()=>{
 const ownerId='+14165550123';
 const home=makeHome({potts(c){Object.assign(c.owner as object,{channel:'imessage',imessageOwnerId:ownerId});(c.monitoring as {enabled:boolean}).enabled=false;c.briefings=[];}});
 const w=await startWorld({home,start:'2026-10-22T02:58:00Z'});
 try{
  const [tool]=createOwnerReminderTools({get:async()=>({ownerId,key:Buffer.from(INGRESS_KEY)})} as never,{home,deliveryChannel:'imessage',deliveryTarget:ownerId,now:w.clock.nowMs});
  const saved=await tool!.execute('owner-request',{action:'add',text:'Take a break',at:'1m'});
  assert.equal((saved.details as {ok:boolean}).ok,true);
  w.clock.set('2026-10-22T03:01:00Z');await w.d.tick();await w.d.tick();
  assert.equal(w.channel.sent.length,0);
  assert.equal(w.d.outbox.list().filter(n=>n.eventRef?.startsWith('reminder:')).length,1);
  await w.restart();w.clock.set('2026-10-22T12:00:00Z');await w.d.tick();await w.advance(60_000);
  assert.deepEqual(w.channel.sent.filter(m=>m.type==='text').map(m=>m.text),['Take a break']);
  await w.advance(60_000);assert.equal(w.channel.sent.length,1);
 }finally{await w.close();}
});
