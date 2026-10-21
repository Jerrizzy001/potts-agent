// Count occurrences of live secret values in a directory tree; prints counts only.
import {readFileSync, readdirSync, statSync} from 'node:fs'; import {join} from 'node:path';
const home=process.env.HOME; const dir=process.argv[2];
const secrets=[];
const cfg=JSON.parse(readFileSync(`${home}/.openclaw/openclaw.json`,'utf8'));
const walk=(o)=>{ if(o&&typeof o==='object') for(const [k,v] of Object.entries(o)){ if(typeof v==='string'&&/token|key|secret|password/i.test(k)&&v.length>=8&&!v.startsWith('/')) secrets.push(v); else walk(v);} }; walk(cfg);
for (const f of ['credentials/telegram-bot-token','credentials/browser-extension-relay.secret','mac-control.token']) { try { const s=readFileSync(`${home}/.openclaw/${f}`,'utf8').trim(); if (s.length>=8) secrets.push(s);} catch {} }
try { const s=JSON.parse(readFileSync(`${home}/.lmstudio/settings.json`,'utf8')); for (const k of ['hfDownloadToken','hfSearchToken']) if (typeof s[k]==='string'&&s[k].length>=8) secrets.push(s[k]); } catch {}
let hits=0, files=0;
const scan=(p)=>{ for(const e of readdirSync(p)){ const q=join(p,e); const st=statSync(q); if(st.isDirectory()) scan(q); else { files++; const c=readFileSync(q,'latin1'); for(const s of secrets) if(c.includes(s)) { hits++; console.log('LEAK in', q); } } } };
scan(dir); console.log(`checked ${secrets.length} secret values across ${files} files: ${hits} leaks`);
