/** Writes reviewable named-tunnel files only; does not create DNS, expose ports or load launchd. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { xmlEscape } from '../../src/telephony/script.ts';
export function tunnelFiles(o:{domain:string;tunnelId:string;credentialsFile:string;directory:string;cloudflared?:string}) {
  if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(o.domain)||o.domain.endsWith('.trycloudflare.com'))throw new Error('A permanent hostname is required');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(o.tunnelId))throw new Error('Invalid tunnel UUID');
  if(!isAbsolute(o.credentialsFile)||!isAbsolute(o.directory))throw new Error('Paths must be absolute');
  const config=join(o.directory,'cloudflared.json');
  const bin=o.cloudflared??'/opt/homebrew/bin/cloudflared';if(!isAbsolute(bin))throw new Error('Binary must be absolute');
  const args=[bin,'--no-autoupdate','tunnel','--config',config,'run',o.tunnelId];
  return {config:JSON.stringify({tunnel:o.tunnelId,'credentials-file':o.credentialsFile,ingress:[{hostname:o.domain,path:'^/telephony/twilio/(status|gather|voice|verify|voice-status|relay)$',service:'http://127.0.0.1:8790'},{service:'http_status:404'}]},null,2)+'\n',
    plist:`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.potts.voice-tunnel</string><key>ProgramArguments</key><array>${args.map(a=>'<string>'+xmlEscape(a)+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xmlEscape(join(o.directory,'tunnel.out.log'))}</string><key>StandardErrorPath</key><string>${xmlEscape(join(o.directory,'tunnel.err.log'))}</string></dict></plist>\n`};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [domain,tunnelId,credentialsFile]=process.argv.slice(2);
  if(!domain||!tunnelId||!credentialsFile) {console.error('Usage: node scripts/voice/prepare-tunnel.ts HOSTNAME TUNNEL_UUID ABSOLUTE_CREDENTIALS_JSON_PATH');process.exitCode=1;}
  else {
    const directory=join(homedir(),'Library','Application Support','Potts','voice-deployment');
    const files=tunnelFiles({domain,tunnelId,credentialsFile,directory});
    mkdirSync(directory,{recursive:true,mode:0o700});
    writeFileSync(join(directory,'cloudflared.json'),files.config,{mode:0o600});
    writeFileSync(join(directory,'local.potts.voice-tunnel.plist'),files.plist,{mode:0o600});
    console.log('Prepared config and launch agent in '+directory+'. Nothing has been installed or started.');
  }
}
