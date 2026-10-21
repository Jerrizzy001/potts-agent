/** Worker-facing proposer only. No approve/execute method or ingress credentials. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rpcCall } from '../../integrations/openclaw/potts-broker-plugin/lib/rpc.ts';
const [operation, raw] = process.argv.slice(2);
if (!['request','status','action'].includes(operation ?? '') || !raw) {
  console.error('Usage: node release.ts request|status|action JSON');process.exit(2);
}
try {
  const params=JSON.parse(raw);
  if(!params || typeof params!=='object' || Array.isArray(params))throw new Error('JSON object required');
  const method=operation==='action'?'status':`release.${operation}`;
  const response=await rpcCall(join(homedir(),'Library/Application Support/Potts/run/broker.sock'),method,params,{timeoutMs:10000});
  console.log(JSON.stringify(response));if(!response.ok)process.exitCode=1;
}catch(e){console.error((e as Error).message);process.exitCode=2;}
