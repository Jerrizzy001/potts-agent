import { PublicError } from '../../src/portable/errors.ts';
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../../src/portable/process.ts';
import { checkedHome, defaultHome, readConfig, setup } from '../../src/portable/config.ts';
import { createBridge, lockHome, runBridge, verifyChat, type Message } from '../../src/portable/bridge.ts';
import { service } from '../../src/portable/service.ts';
function argumentsFor(argv:string[]){const command=argv.shift();let home=defaultHome(),apply=false,uninstall=false,homeProvided=false;while(argv.length){const flag=argv.shift();if(flag==='--home'){const value=argv.shift();if(!value||value.startsWith('--'))throw new PublicError('--home requires a path');home=value;homeProvided=true;}else if(flag==='--apply')apply=true;else if(flag==='--uninstall')uninstall=true;else throw new PublicError('Unknown CLI argument');}if(command!=='service'&&(apply||uninstall))throw new PublicError('Service flags require the service command');return {command,home:checkedHome(home),apply,uninstall,homeProvided};}
async function main(){const {command,home,apply,uninstall,homeProvided}=argumentsFor(process.argv.slice(2));
  if(command==='demo'&&!homeProvided){const temporary=mkdtempSync(join(realpathSync(tmpdir()),'potts-public-demo-'));const isolated=join(temporary,'runtime');try{setup(isolated);const output=await execute([process.execPath,'--disable-warning=ExperimentalWarning',join(import.meta.dirname,'cli.ts'),'demo','--home',isolated]);console.log(output.trim());}finally{rmSync(temporary,{recursive:true,force:true});}return;}
  if(command==='setup'){setup(home);console.log('Created private demo configuration. Next: public:demo and public:doctor with the same --home.');return;}
  const config=readConfig(home);
  if(command==='doctor'){
    if((lstatSync(home).mode&0o077)!==0||(lstatSync(join(home,'config.json')).mode&0o077)!==0)throw new PublicError('Runtime home and configuration must be private: chmod 700 home; chmod 600 config.json');
    const binaries=[...(config.transport.kind==='imsg'?[config.transport.binary]:[]),...(config.agent.kind==='command'?[config.agent.argv[0]!]:config.agent.kind==='openclaw'?[config.agent.binary]:[])];for(const path of binaries)accessSync(path,constants.X_OK);
    if(config.agent.kind!=='demo')for(const name of config.agent.envNames)if(!process.env[name])throw new PublicError('An explicitly required agent environment variable is missing');
    await verifyChat(config,home);console.log(`Configuration, private file modes, executables, and ${config.transport.kind==='imsg'?'direct-chat metadata':'demo configuration'} checked. Agent/provider calls, sending permission, and live delivery are not tested.`);return;
  }
  if(command==='demo'){
    if(config.transport.kind!=='demo'||config.agent.kind!=='demo')throw new PublicError('Demo requires a dedicated demo home; it never invokes live adapters');
    const unlock=lockHome(home);const replies:string[]=[];const send=async(text:string)=>{replies.push(text);};let bridge=createBridge(config,home,send);
    const base=Date.now();const message=(id:number,text:string):Message=>({id,chat_id:1,sender:'demo-owner',is_from_me:false,is_group:false,participants:['demo-owner'],text});
    try{
      if(await bridge.handle(message(base,'remember: I prefer brief replies.'))!=='sent')throw new PublicError('Demo capture failed');bridge.close();bridge=createBridge(config,home,send);
      if(await bridge.handle(message(base+1,'How should you answer me?'))!=='sent'||!replies.at(-1)?.includes('recall your preference'))throw new PublicError('Demo memory recall failed');
      console.log('Demo passed: captured a synthetic preference, closed/reopened the database, and recalled it in a later reply. No provider or Messages calls were made.');
    }finally{bridge.close();unlock();}return;
  }
  if(command==='run'){await runBridge(config,home);return;}
  if(command==='service'){if(apply&&!uninstall){if(config.transport.kind!=='imsg')throw new PublicError('Service requires live transport configuration');await verifyChat(config,home);}await service(home,apply,uninstall);return;}
  throw new PublicError('Usage: cli.ts setup|doctor|demo|run|service [--home PATH] [--apply] [--uninstall]');
}
main().catch(error=>{console.error(error instanceof PublicError?error.message:'Potts command failed while reading local configuration or state. Check paths, JSON syntax, private file modes, and dependency permissions. Raw diagnostics are suppressed to protect private data.');process.exitCode=1;});
