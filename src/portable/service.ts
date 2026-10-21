import { PublicError } from './errors.ts';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execute } from './process.ts';
import { repository } from './config.ts';
export const label='local.potts.public.bridge';
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export function plist(home:string){const args=[process.execPath,'--disable-warning=ExperimentalWarning',join(repository,'scripts/public/cli.ts'),'run','--home',home];return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(s=>`<string>${xml(s)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(repository)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([dirname(process.execPath),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'))}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(home,'bridge.log'))}</string><key>StandardErrorPath</key><string>${xml(join(home,'bridge-error.log'))}</string></dict></plist>\n`;}
export async function service(home:string,apply:boolean,uninstall:boolean){
  const path=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
  if(!apply){console.log(uninstall?'Dry run: remove only the Potts public launch agent; retain runtime data.':plist(home));return;}
  if(process.platform!=='darwin')throw new PublicError('launchd service installation requires macOS');
  const uid=process.getuid?.();if(uid===undefined)throw new PublicError('Cannot identify current login user');
  if(uninstall){if(!existsSync(path))throw new PublicError('Public launch agent is not installed');if(readFileSync(path,'utf8')!==plist(home))throw new PublicError('Service differs from this checkout/home; inspect it manually');await execute(['/bin/launchctl','bootout',`gui/${uid}`,path]);unlinkSync(path);console.log('Public launch agent removed. Runtime data retained.');return;}
  if(existsSync(path))throw new PublicError('Refusing to overwrite an existing launch agent');
  mkdirSync(join(homedir(),'Library/LaunchAgents'),{recursive:true,mode:0o700});writeFileSync(path,plist(home),{mode:0o600});
  try{await execute(['/bin/launchctl','bootstrap',`gui/${uid}`,path]);}catch{unlinkSync(path);throw new PublicError('Public launch agent could not be loaded');}console.log('Public launch agent installed for this login user.');
}
