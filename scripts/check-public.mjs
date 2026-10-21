/** Repository hygiene check. Optional private search terms stay outside the repository. */
import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {resolve,relative,dirname,extname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const skip=new Set(['.git','node_modules']);const files=[];
function walk(dir){for(const name of readdirSync(dir)){if(skip.has(name))continue;const path=resolve(dir,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw Error(`Symlink in release tree: ${relative(root,path)}`);if(stat.isDirectory())walk(path);else files.push(path);}}
walk(root);
const findings=[];const privateTerms=process.env.POTTS_PRIVATE_TERMS_FILE?JSON.parse(readFileSync(process.env.POTTS_PRIVATE_TERMS_FILE,'utf8')):[];
if(!Array.isArray(privateTerms)||privateTerms.some(x=>typeof x!=='string'||!x))throw Error('Private terms must be a JSON string array');
const artifact=/\.(?:db|sqlite3?|log|pem|key|p12|tgz|zip|tar|gz)(?:-|$)/i;
for(const path of files){const rel=relative(root,path);if(artifact.test(rel)||/(^|\/)(?:\.env(?:\.|$)|config\/(?:potts|accounts|projects|policy)\.json$|backups|snapshots|outputs)(?:\/|$)/.test(rel))findings.push(`${rel}: excluded runtime/secret/archive artifact`);
 const body=readFileSync(path,'utf8');if(body.includes('\0'))findings.push(`${rel}: binary content requires separate review`);
 for(const [i,line] of body.split('\n').entries()){
  if(privateTerms.some(term=>line.toLowerCase().includes(term.toLowerCase())))findings.push(`${rel}:${i+1}: private-term match (value suppressed)`);
 }
 if(extname(path)==='.md')for(const match of body.matchAll(/\]\(([^)]+)\)/g)){let target=match[1].split(/\s+["']/)[0].replace(/^<|>$/g,'');if(!target||/^(https?:|mailto:|#)/.test(target))continue;target=target.split('#')[0];try{lstatSync(resolve(dirname(path),decodeURIComponent(target)));}catch{findings.push(`${rel}: missing relative documentation target ${target}`);}}
}
if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}else console.log(`Public hygiene: ${files.length} files checked; no excluded artifacts, private-term matches, or broken relative Markdown links. This is not a guarantee of secret-free content; independent review is still required.`);
