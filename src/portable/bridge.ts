import { PublicError } from './errors.ts';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLearning } from '../../integrations/openclaw/potts-broker-plugin/lib/learning.ts';
import { type Config, childEnvironment } from './config.ts';
import { execute, jsonLines } from './process.ts';
import { askAgent } from './agent.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export interface Message {id:number;chat_id:number;sender:string;is_from_me:false;text:string;is_group:false;participants:string[];guid?:string}
export function admitted(value:unknown,config:Config):value is Message {
  if(config.transport.kind!=='imsg'||!value||typeof value!=='object')return false;
  const m=value as Record<string,unknown>,t=config.transport;
  return Number.isSafeInteger(m.id)&&Number(m.id)>0&&m.chat_id===t.chatId&&m.sender===t.owner&&m.is_from_me===false&&m.is_group===false&&Array.isArray(m.participants)&&m.participants.length===1&&m.participants[0]===t.owner&&typeof m.text==='string'&&m.text.trim().length>0&&m.text.length<=16000&&m.is_reaction!==true;
}
export async function verifyChat(config:Config,home:string){
  if(config.transport.kind!=='imsg')return;
  const t=config.transport;const raw=await execute([t.binary,'group','--chat-id',String(t.chatId),'--json'],{cwd:home});
  let c:Record<string,unknown>;try{c=JSON.parse(raw);}catch{throw new PublicError('Chat metadata is not valid JSON');}
  if(!c||c.id!==t.chatId||c.is_group!==false||c.service!=='iMessage'||!Array.isArray(c.participants)||c.participants.length!==1||c.participants[0]!==t.owner)throw new PublicError('Configured chat is not the verified owner direct iMessage conversation');
}
export function lockHome(home:string){
  const path=join(home,'bridge.lock');if(existsSync(path)){if(lstatSync(path).isSymbolicLink())throw new PublicError('Invalid runtime lock');let pid=Number.NaN;try{pid=Number(readFileSync(path,'utf8'));}catch{}if(!Number.isSafeInteger(pid)||pid<1)throw new PublicError('Invalid runtime lock; inspect it manually');let alive=true;try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}if(alive)throw new PublicError('A bridge already owns this runtime home');unlinkSync(path);}
  const fd=openSync(path,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);return ()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);}catch{}};
}
export function createBridge(config:Config,home:string,send:(text:string)=>Promise<void>,signal?:AbortSignal){
  const owner=config.transport.kind==='imsg'?config.transport.owner:'demo-owner';const session='agent:potts-public:owner';
  const learning=createLearning({home:join(home,'memory'),directory:join(home,'knowledge/learning'),coordinatorId:'potts-public',channel:'imessage',ownerId:async()=>owner,timezone:config.timezone});
  const path=join(home,'delivery.sqlite');if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new PublicError('Delivery ledger cannot be a symlink');const db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY,state TEXT NOT NULL,at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const identity=hash(JSON.stringify(config.transport.kind==='imsg'?{kind:'imsg',owner:config.transport.owner,chatId:config.transport.chatId}:{kind:'demo'}));
  const previous=db.prepare("SELECT value FROM settings WHERE key='runtime_identity'").get();
  if(previous&&previous.value!==identity){db.close();learning.close();throw new PublicError('This runtime home belongs to a different transport, owner, or chat. Create a new private runtime home; existing data has been retained.');}
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('runtime_identity',?)").run(identity);
  const context={agentId:'potts-public',sessionKey:session,messageChannel:'imessage',requesterSenderId:owner,senderIsOwner:true};
  const paused=()=>db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value==='1';
  const setState=(id:string,state:string)=>db.prepare('UPDATE delivery SET state=?,at=? WHERE id=?').run(state,new Date().toISOString(),id);
  return {
    learning,
    async handle(message:Message){
      if(config.transport.kind==='imsg'&&!admitted(message,config))return 'rejected';
      if(signal?.aborted)return 'stopped';
      const id=hash(`imessage:${message.chat_id}:${typeof message.guid==='string'&&message.guid?message.guid:message.id}`);
      // Reserve before side effects. Any crash/failure remains terminal: no automatic re-send.
      if(Number(db.prepare('INSERT OR IGNORE INTO delivery VALUES (?,?,?)').run(id,'processing',new Date().toISOString()).changes)===0)return 'duplicate';
      try{
        const text=message.text.trim();let reply:string;
        const isControl=/^\/(memory|forget|pause|resume|status)(?:\s|$)/.test(text);
        if(paused()&&!isControl){setState(id,'paused_skipped');return 'paused';}
        if(text==='/pause'){db.prepare("INSERT OR REPLACE INTO settings VALUES ('paused','1')").run();reply='Paused. Use /resume to continue. Memory commands remain available.';}
        else if(text==='/resume'){db.prepare("INSERT OR REPLACE INTO settings VALUES ('paused','0')").run();reply='Resumed.';}
        else if(text==='/status'){reply=`Potts bridge: ${paused()?'paused':'running'}. Local memory enabled. Replies are attempted once; messages received while offline are not replayed.`;}
        else if(/^\/memory(?:\s|$)/.test(text)){const query=text.slice(7).trim();const rows=learning.search(query,8);reply=rows.length?rows.map(x=>`${x.kind}: ${x.text}\nForget source: ${x.sourceId}`).join('\n\n'):'No saved memories match.';}
        else if(/^\/forget(?:\s|$)/.test(text)){
          const sourceId=text.slice(7).trim();if(!/^[a-f0-9]{64}$/.test(sourceId)){reply='Use /memory to find a source, then /forget <sourceId>.';}
          else{const result=await learning.tools(context)[0]!.execute('forget',{action:'forget',sourceId});reply=result.content[0]!.text;}
        }
        else if(isControl)reply='Commands: /memory [query], /forget <sourceId>, /pause, /resume, /status.';
        else{
          await learning.capture({senderIsOwner:true,commandAuthorized:true,isGroup:false,senderId:owner,channel:'imessage',messageId:id,content:text},{sessionKey:session});
          reply=await askAgent(config,{version:1,id,message:text,context:learning.context(text,session)},home,signal);
        }
        if(signal?.aborted){setState(id,'cancelled');return 'cancelled';}
        if(reply.length>12000)reply=reply.slice(0,11900)+'\n[More results remain in local memory.]';
        setState(id,'send_attempted');await send(reply);setState(id,'sent');return 'sent';
      }catch{setState(id,'failed_or_uncertain');return 'failed_or_uncertain';}
    },
    counts(){return db.prepare('SELECT state,count(*) AS count FROM delivery GROUP BY state').all();},
    close(){learning.close();db.close();},
  };
}
export async function runBridge(config:Config,home:string){
  if(config.transport.kind!=='imsg')throw new PublicError('Configure iMessage and an agent before running the live bridge');
  await verifyChat(config,home);const unlock=lockHome(home);const controller=new AbortController();const t=config.transport;
  const child=spawn(t.binary,['watch','--chat-id',String(t.chatId),'--json'],{shell:false,stdio:['ignore','pipe','pipe'],env:childEnvironment(),cwd:home});
  let childError=false;child.on('error',()=>{childError=true;});const exited=new Promise<number|null>(resolve=>child.on('close',code=>resolve(code)));child.stderr.on('data',()=>{});
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;controller.abort();child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),2000);force.unref();void exited.then(()=>clearTimeout(force));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let bridge:ReturnType<typeof createBridge>;try{bridge=createBridge(config,home,async text=>{await verifyChat(config,home);await execute([t.binary,'send','--chat-id',String(t.chatId),'--text',text],{cwd:home,timeoutMs:30000,signal:controller.signal});},controller.signal);}catch(error){stop();unlock();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);throw error;}
  const review=setInterval(()=>{try{bridge.learning.reviewDaily();}catch{console.error('Local memory review failed.');}},60000);review.unref();
  try{
    console.log('Potts bridge watching verified direct chat. No historical replay.');
    for await(const message of jsonLines(child.stdout)){if(controller.signal.aborted)break;if(!admitted(message,config))continue;const state=await bridge.handle(message);console.log(`Message processing: ${state}`);}
    const code=await exited;if(!controller.signal.aborted)throw new PublicError('Messages watcher stopped unexpectedly');
  }finally{stop();clearInterval(review);bridge.close();unlock();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
