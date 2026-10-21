/** Read-only readiness checks. Never dials, buys, upgrades, enables, or changes config. */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSecretRef } from '../../src/core/secrets.ts';
import type { TelephonyConfig } from '../../src/telephony/config.ts';
export interface VoiceFacts { modelAvailable: boolean; credentialsPresent: boolean; stableOrigin: boolean; accountPaid: boolean | null; incomingNumberMatches: boolean | null; voiceEnabled: boolean; paused: boolean; }
export function assessVoiceReadiness(f: VoiceFacts) {
  const blockers: string[] = [];
  if (!f.modelAvailable) blockers.push('Local model unavailable');
  if (!f.credentialsPresent) blockers.push('Twilio credentials unavailable');
  if (!f.stableOrigin) blockers.push('Permanent callback domain/tunnel not configured');
  if (f.accountPaid !== true) blockers.push(f.accountPaid === null ? 'Paid account status not checked' : 'Twilio account is still a trial');
  if (f.incomingNumberMatches !== true) blockers.push('Configured caller is not a verified owned incoming voice number');
  if (!f.voiceEnabled) blockers.push('Conversation feature disabled');
  if (f.paused) blockers.push('Telephony remains paused');
  return { configReady: blockers.length === 0, phoneDeliveryVerified: false, blockers, reminder: 'Even when configReady is true, provider terms, public signed callbacks and real phone delivery require verification.' };
}
export async function preflight(home: string, provider = false) {
  const c = JSON.parse(readFileSync(join(home,'potts.json'),'utf8')) as { telephony?: TelephonyConfig; integrations?: {pauseAll?:boolean;paused?:Record<string,boolean>} };
  if (!c.telephony) throw new Error('Telephony is not configured');
  const t = c.telephony;
  const refs = [t.twilio.accountSidRef,t.twilio.authTokenRef,t.twilio.apiKeySidRef,t.twilio.apiKeySecretRef].filter((v):v is string=>!!v);
  const results = await Promise.all(refs.map(ref=>resolveSecretRef(ref)));
  const secrets = new Map(refs.map((ref,i)=>[ref,results[i]!]));
  const get = (ref: string) => {const r=secrets.get(ref);if(!r?.ok)throw new Error('Credential unavailable');return r.value;};
  let modelAvailable = false;
  try {
    const base=t.conversation?.baseUrl??'http://127.0.0.1:1234';const u=new URL(base);
    if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.protocol!=='http:')throw new Error('Nonlocal model URL');
    const r=await fetch(base+'/v1/models',{signal:AbortSignal.timeout(5000),redirect:'error'});
    const j=await r.json() as {data?:{id:string}[]};modelAvailable=r.ok&&!!j.data?.some(m=>m.id===(t.conversation?.model??'qwen/qwen3.5-9b'));
  }catch{/* absence is reported without leaking request details */}
  let accountPaid:boolean|null=null,incomingNumberMatches:boolean|null=null;
  if(provider && results.every(r=>r.ok)) {
    const sid=get(t.twilio.accountSidRef),token=get(t.twilio.authTokenRef);
    if(!/^AC[a-f0-9]{32}$/.test(sid))throw new Error('Invalid account SID');
    const headers={authorization:'Basic '+Buffer.from(sid+':'+token).toString('base64')};
    const api='https://api.twilio.com/2010-04-01/Accounts/'+sid;
    const accounts=JSON.parse(readFileSync(join(home,'accounts.json'),'utf8'));
    const list=Array.isArray(accounts)?accounts:accounts.accounts;
    const number=(list as {id:string;address:string}[]).find(a=>a.id===t.accountId)?.address;
    const [ar,nr]=await Promise.all([
      fetch(api+'.json',{headers,signal:AbortSignal.timeout(15000),redirect:'error'}),
      fetch(api+'/IncomingPhoneNumbers.json?'+new URLSearchParams({PhoneNumber:number??'',PageSize:'20'}),{headers,signal:AbortSignal.timeout(15000),redirect:'error'}),
    ]);
    if(ar.ok){const a=await ar.json() as {type:string;status:string};accountPaid=a.type==='Full'&&a.status==='active';}
    if(nr.ok){const n=await nr.json() as {incoming_phone_numbers:{phone_number:string;capabilities:{voice:boolean}}[]};incomingNumberMatches=n.incoming_phone_numbers.some(x=>x.phone_number===number&&x.capabilities.voice);}
  }
  const origin=new URL(t.publicBaseUrl);
  const facts:VoiceFacts={modelAvailable,credentialsPresent:results.every(r=>r.ok),stableOrigin:origin.protocol==='https:'&&!origin.hostname.endsWith('.trycloudflare.com')&&!origin.hostname.includes('example.')&&!origin.hostname.endsWith('.test'),accountPaid,incomingNumberMatches,voiceEnabled:t.enabled&&t.conversation?.enabled===true,paused:c.integrations?.pauseAll===true||c.integrations?.paused?.telephony===true};
  return {checkedAt:new Date().toISOString(),facts,...assessVoiceReadiness(facts),daemonSocketPresent:existsSync(join(home,'run','broker.sock')),mutationPerformed:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const home=process.env.POTTS_HOME??join(homedir(),'Library','Application Support','Potts');
  try{console.log(JSON.stringify(await preflight(home,process.argv.includes('--provider')),null,2));}
  catch{console.error('Voice preflight could not complete. Check config, account access and connectivity; no changes were made.');process.exitCode=1;}
}
