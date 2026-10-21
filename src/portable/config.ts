import { PublicError } from './errors.ts';
import { homedir } from 'node:os';
import { resolve, isAbsolute, join, relative } from 'node:path';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
export type Agent = {kind:'demo'} | {kind:'command';argv:string[];envNames:string[]} | {kind:'openclaw';binary:string;agentId:string;profile?:string;envNames:string[]};
export type Config = {version:1;timezone:string;timeoutMs:number;transport:{kind:'demo'}|{kind:'imsg';binary:string;chatId:number;owner:string};agent:Agent};
export const repository = resolve(import.meta.dirname,'../..');
export function defaultHome() { return process.platform==='darwin'?join(homedir(),'Library/Application Support/PottsPublic'):join(homedir(),'.local/share/potts-public'); }
export function checkedHome(path:string) {
  const home=resolve(path);const rel=relative(repository,home);
  if(!rel || (!rel.startsWith('..'+ '/') && rel!=='..' && !isAbsolute(rel)))throw new PublicError('Runtime home must be outside the repository');
  // Reject symlinks in every existing path component, not only the leaf.
  let cursor=home;while(true){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new PublicError('Runtime home must not contain symlinks');const parent=resolve(cursor,'..');if(parent===cursor)break;cursor=parent;}
  return home;
}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new PublicError('Invalid configuration object');return v as Record<string,unknown>;}
function only(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))throw new PublicError('Unknown configuration field');}
function string(v:unknown,max=4096):string{if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw new PublicError('Invalid configuration string');return v;}
function binary(v:unknown){const s=string(v);if(!isAbsolute(s))throw new PublicError('Executable paths must be absolute');return s;}
function envNames(v:unknown):string[]{if(!Array.isArray(v)||v.length>30||v.some(x=>typeof x!=='string'||!/^[A-Z_][A-Z0-9_]*$/.test(x)||/^(NODE_OPTIONS|LD_|DYLD_)/.test(x)))throw new PublicError('Invalid environment variable allowlist');return v;}
export function validateConfig(input:unknown):Config {
  const v=object(input);only(v,['version','timezone','timeoutMs','transport','agent']);if(v.version!==1)throw new PublicError('Unsupported configuration version');
  const timezone=string(v.timezone,100);try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw new PublicError('Invalid timezone');}
  const timeoutMs=v.timeoutMs;if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<1000||Number(timeoutMs)>600000)throw new PublicError('Timeout must be between 1000 and 600000 milliseconds');
  const t=object(v.transport);let transport:Config['transport'];
  if(t.kind==='demo'){only(t,['kind']);transport={kind:'demo'};}else if(t.kind==='imsg'){
    only(t,['kind','binary','chatId','owner']);if(!Number.isSafeInteger(t.chatId)||Number(t.chatId)<1)throw new PublicError('Chat ID must be a positive integer');
    transport={kind:'imsg',binary:binary(t.binary),chatId:Number(t.chatId),owner:string(t.owner,320)};
  }else throw new PublicError('Unsupported transport');
  const a=object(v.agent);let agent:Agent;
  if(a.kind==='demo'){only(a,['kind']);agent={kind:'demo'};}else if(a.kind==='command'){
    only(a,['kind','argv','envNames']);if(!Array.isArray(a.argv)||!a.argv.length||a.argv.length>40)throw new PublicError('Agent argv is required');
    const argv=a.argv.map(x=>string(x));binary(argv[0]);agent={kind:'command',argv,envNames:envNames(a.envNames)};
  }else if(a.kind==='openclaw'){
    only(a,['kind','binary','agentId','profile','envNames']);const agentId=string(a.agentId,80);if(!/^[a-zA-Z0-9_-]+$/.test(agentId))throw new PublicError('Invalid agent ID');
    const profile=a.profile===undefined?undefined:string(a.profile,80);if(profile&&!/^[a-zA-Z0-9_-]+$/.test(profile))throw new PublicError('Invalid profile');
    agent={kind:'openclaw',binary:binary(a.binary),agentId,profile,envNames:envNames(a.envNames)};
  }else throw new PublicError('Unsupported agent');
  if(transport.kind==='imsg'&&agent.kind==='demo')throw new PublicError('Select a real agent before enabling iMessage');
  return {version:1,timezone,timeoutMs:Number(timeoutMs),transport,agent};
}
export function setup(home:string){home=checkedHome(home);if(existsSync(home))throw new PublicError('Setup refuses to overwrite an existing runtime home');mkdirSync(home,{recursive:true,mode:0o700});chmodSync(home,0o700);writeFileSync(join(home,'config.json'),JSON.stringify({version:1,timezone:'UTC',timeoutMs:120000,transport:{kind:'demo'},agent:{kind:'demo'}},null,2)+'\n',{mode:0o600});}
export function readConfig(home:string){home=checkedHome(home);const path=join(home,'config.json');if(lstatSync(path).isSymbolicLink())throw new PublicError('Configuration must not be a symlink');if((lstatSync(home).mode&0o077)!==0||(lstatSync(path).mode&0o077)!==0)throw new PublicError('Runtime home and configuration must be private: chmod 700 home; chmod 600 config.json');return validateConfig(JSON.parse(readFileSync(path,'utf8')));}
export function childEnvironment(names:string[]=[]){const result:NodeJS.ProcessEnv={};for(const key of ['HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL',...names])if(process.env[key]!==undefined)result[key]=process.env[key];return result;}
