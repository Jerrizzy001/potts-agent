import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentTool } from '../../integrations/openclaw/potts-broker-plugin/lib/environment.ts';
import { parsePluginConfig } from '../../integrations/openclaw/potts-broker-plugin/lib/config.ts';

test('environment discovery exposes relevant access metadata but excludes credentials and browser data', async () => {
  const cfg=parsePluginConfig({pottsHome:'/tmp/potts-environment'});assert.ok(cfg.ok);
  const tool=createEnvironmentTool(cfg.value,{
    home:'/tmp/owner',
    read:path=>path.endsWith('projects.json')?{projects:[{id:'demo',repoPath:'/tmp/demo',urls:['https://example.com'],release:{credentialEnv:{TOKEN:'secret-value'}}}]}:{agents:{defaults:{workspace:'/tmp/workspace'},entries:{main:{model:{primary:'openai/gpt-6.1-sol'}}}},channels:{telegram:{botToken:'secret-value'}}},
    query:async args=>args[0]==='nodes'?{nodes:[{displayName:'Mac',connected:true,caps:['computer'],pathEnv:'private-env',permissions:{screenRecording:true}}]}:{profiles:[{name:'user',driver:'existing-session',running:true,tabCount:0,cookies:'secret-value'}]},
  });
  const r=await tool.execute();assert.equal(r.details.environment.projects[0].path,'/tmp/demo');
  assert.equal(r.details.environment.browsers[0].tabCount,0);
  assert.doesNotMatch(JSON.stringify(r),/secret-value|private-env|botToken|credentialEnv/);
  assert.match(r.content[0]!.text,/not proof of a usable page connection/);
});

test('failed environment probes remain unknown, not a claim that computer access is denied',async()=>{
  const cfg=parsePluginConfig({pottsHome:'/tmp/potts-environment'});assert.ok(cfg.ok);
  const r=await createEnvironmentTool(cfg.value,{read:()=>null,query:async()=>null}).execute();
  assert.deepEqual(r.details.environment.computer,{state:'probe_failed'});
  assert.deepEqual(r.details.environment.browsers,{state:'probe_failed'});
});


test('messaging readiness is independent of Mac, browser and External connectivity', async () => {
  const cfg = parsePluginConfig({pottsHome:'/tmp/potts-environment',deliveryChannel:'imessage',deliveryTarget:'+14165550123'}); assert.ok(cfg.ok);
  const r = await createEnvironmentTool(cfg.value, {read:()=>({mcp:{servers:{external:{enabled:true,auth:{token:'secret-value'}}}}}), query:async args=> {
    if(args[0]==='channels') return {channels:{imessage:{configured:true,running:true,connected:true}}};
    if(args[0]==='nodes') throw new Error('offline');
    return {profiles:[{name:'user',running:true}]};
  }}).execute();
  assert.equal(r.details.environment.connections.messaging.state,'connected');
  assert.equal(r.details.environment.connections.localComputer.state,'unknown');
  assert.equal(r.details.environment.connections.browser.state,'running_unverified');
  assert.equal(r.details.environment.connections.external.state,'unverified');
  assert.equal(r.details.environment.connections.external.configured,true);
  assert.doesNotMatch(JSON.stringify(r),/secret-value/);
});

test('no connected node does not falsely deny the separately configured native desktop route',async()=>{
 const cfg=parsePluginConfig({pottsHome:'/tmp/potts-environment'});assert.ok(cfg.ok);
 const r=await createEnvironmentTool(cfg.value,{read:()=>({plugins:{entries:{codex:{config:{computerUse:{enabled:true}}}}}}),query:async()=>({nodes:[]})}).execute();
 assert.equal(r.details.environment.connections.localComputer.state,'unknown');
 assert.equal(r.details.environment.connections.localComputer.nodeConnection,'disconnected');
 assert.equal(r.details.environment.connections.localComputer.nativeComputerConfigured,true);
 assert.equal(r.details.environment.connections.localComputer.controlVerified,false);
});
