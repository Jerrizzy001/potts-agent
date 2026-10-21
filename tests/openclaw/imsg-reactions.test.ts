import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImsgReactionAdapter } from '../../integrations/openclaw/potts-broker-plugin/lib/imsg-reactions.ts';
const owner = '+14165550199';
const target = { conversationId: '7', messageId: '12345678-1234-1234-1234-123456789abc', reaction: 'like' as const };
test('concrete adapter checks precise availability, message ownership and add/remove receipts through subprocess', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'imsg-adapter-')); const cli = join(dir, 'fake-imsg'); const state = join(dir, 'state.json'); const log = join(dir, 'calls.jsonl');
 writeFileSync(state, JSON.stringify({ ready: true, present: false, group: false, sender: owner }));
 writeFileSync(cli, `#!${process.execPath}\nconst fs = require('node:fs'); const args=process.argv.slice(2); const state=${JSON.stringify(state)}, log=${JSON.stringify(log)}; const s=JSON.parse(fs.readFileSync(state)); fs.appendFileSync(log,JSON.stringify(args)+'\\n'); const owner=${JSON.stringify(owner)}; const guid=${JSON.stringify(target.messageId)}; let out;
 switch(args[0]) { case 'status': out={advanced_features:s.ready};break;
 case 'group':out={id:7,identifier:owner,guid:'iMessage;-;'+owner,service:'iMessage',is_group:s.group,participants:[owner]};break;
 case 'history':out={chat_id:7,guid,sender:s.sender,is_from_me:false,reactions:s.present?[{is_from_me:true,type:'like'}]:[]};break;
 case 'tapback':s.present=!args.includes('--remove');fs.writeFileSync(state,JSON.stringify(s));out={ok:true};break;default:process.exit(1); } console.log(JSON.stringify(out));`, { mode: 0o700 });
 const adapter = createImsgReactionAdapter({ cliPath: cli, ownerId: owner });
 try {
  assert.equal(await adapter.ready(), true); assert.equal((await adapter.inspect(target))?.present, false);
  await adapter.set(target, true, () => {}); assert.equal((await adapter.inspect(target))?.present, true);
  await adapter.set(target, false, () => {}); assert.equal((await adapter.inspect(target))?.present, false);
  let calls = readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x) as string[]); const writes=calls.filter(c=>c[0]==='tapback');
  assert.equal(writes.length,2); assert.ok(writes[0]?.includes(target.messageId)); assert.ok(writes[1]?.includes('--remove')); assert.ok(!calls.some(c=>c[0]==='react'));
  writeFileSync(state, JSON.stringify({ ready:false,present:false,group:false,sender:owner })); assert.equal(await adapter.ready(),false); await assert.rejects(adapter.set(target,true));
  writeFileSync(state, JSON.stringify({ ready:true,present:false,group:true,sender:owner })); assert.equal(await adapter.inspect(target),null);
  writeFileSync(state, JSON.stringify({ ready:true,present:false,group:false,sender:'+14165550198' })); assert.equal(await adapter.inspect(target),null);
  assert.equal(await adapter.inspect({...target,messageId:'different-guid-000000'}),null);
  calls=readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x) as string[]); assert.equal(calls.filter(c=>c[0]==='tapback').length,2);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
