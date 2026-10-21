import { PublicError } from './errors.ts';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Config } from './config.ts';
import { execute } from './process.ts';
export interface Request {version:1;id:string;message:string;context:string}
export async function askAgent(config:Config,request:Request,home:string,signal?:AbortSignal):Promise<string>{
  const agent=config.agent;if(agent.kind==='demo')return request.message.startsWith('remember:')?'Demo: preference captured locally.':request.context.includes('brief replies')?'Demo: I recall your preference for brief replies.':'Demo: no matching preference yet.';
  let argv:string[],input:string|undefined;
  if(agent.kind==='command'){argv=agent.argv;input=JSON.stringify(request)+'\n';}else{
    const transport=config.transport;
    const scope=createHash('sha256').update(JSON.stringify({home:realpathSync(home),transport:transport.kind,owner:transport.kind==='imsg'?transport.owner:null,chatId:transport.kind==='imsg'?transport.chatId:null})).digest('hex');
    argv=[agent.binary,...agent.profile?['--profile',agent.profile]:[],'agent','--agent',agent.agentId,'--session-key',`agent:${agent.agentId}:potts-public-${scope}`,'--message-file','/dev/stdin','--json'];
    input=`${request.context}\n\nCurrent owner request:\n${request.message}`;
  }
  const raw=await execute(argv,{input,timeoutMs:config.timeoutMs,envNames:agent.envNames,cwd:home,signal});let result:unknown;try{result=JSON.parse(raw);}catch{throw new PublicError('Agent returned invalid JSON');}
  if(!result||typeof result!=='object')throw new PublicError('Agent returned invalid response');const r=result as Record<string,unknown>;let text:unknown;
  if(agent.kind==='command'){if(r.version!==1||r.id!==request.id||Object.keys(r).some(k=>!['version','id','text'].includes(k)))throw new PublicError('Agent response protocol mismatch');text=r.text;}
  else{const body=(r.result&&typeof r.result==='object'?r.result:r) as Record<string,unknown>;if(r.status!==undefined&&r.status!=='ok')throw new PublicError('OpenClaw did not complete successfully');const payloads=body.payloads;if(!Array.isArray(payloads))throw new PublicError('OpenClaw response has no payloads');text=payloads.filter(p=>p&&typeof p.text==='string').map(p=>p.text).join('\n');}
  if(typeof text!=='string'||!text.trim()||text.length>12000)throw new PublicError('Agent response text is empty or too large');return text.trim();
}
