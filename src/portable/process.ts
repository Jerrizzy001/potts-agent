import { PublicError } from './errors.ts';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { childEnvironment } from './config.ts';
export function execute(argv:string[],options:{input?:string;timeoutMs?:number;envNames?:string[];cwd?:string;signal?:AbortSignal}={}):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(argv[0]!,argv.slice(1),{shell:false,stdio:['pipe','pipe','pipe'],env:childEnvironment(options.envNames),cwd:options.cwd});
    let output='',bytes=0,failed=false;
    const fail=()=>{failed=true;child.kill('SIGKILL');};
    const timer=setTimeout(fail,options.timeoutMs??10000);
    const abort=()=>fail();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)fail();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>1048576)fail();else output+=chunk;});
    // Never surface child stderr: it can contain prompts, credentials, or contact data.
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>{failed=true;});child.on('close',code=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(failed||code!==0)reject(new PublicError('Child command failed, timed out, or exceeded output limit'));else resolve(output);});
    child.stdin.end(options.input??'');
  });
}
export async function* jsonLines(stream:AsyncIterable<Buffer|string>){let buffer='';const decoder=new StringDecoder('utf8');for await(const chunk of stream){buffer+=typeof chunk==='string'?chunk:decoder.write(chunk);if(buffer.length>1048576)throw new PublicError('Transport line limit exceeded');let at:number;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.trim())yield JSON.parse(line);}}buffer+=decoder.end();if(buffer.trim())yield JSON.parse(buffer);}
