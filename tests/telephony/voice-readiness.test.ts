import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessVoiceReadiness} from '../../scripts/voice/preflight.ts';
import {tunnelFiles} from '../../scripts/voice/prepare-tunnel.ts';
test('preflight never confuses staged config with real telephone proof',()=>{
 const ready=assessVoiceReadiness({modelAvailable:true,credentialsPresent:true,stableOrigin:true,accountPaid:true,incomingNumberMatches:true,voiceEnabled:true,paused:false});
 assert.equal(ready.configReady,true);assert.equal(ready.phoneDeliveryVerified,false);
 const trial=assessVoiceReadiness({modelAvailable:true,credentialsPresent:true,stableOrigin:false,accountPaid:false,incomingNumberMatches:false,voiceEnabled:false,paused:true});
 assert.equal(trial.configReady,false);assert.equal(trial.blockers.length,5);
});
test('named tunnel exposes only exact voice paths; startup contains no credential value',()=>{
 const files=tunnelFiles({domain:'potts-calls.example.test',tunnelId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',credentialsFile:'/private/voice/credentials.json',directory:'/private/voice'});
 const c=JSON.parse(files.config);assert.equal(c.ingress.length,2);assert.equal(c.ingress[1].service,'http_status:404');assert.equal(c.ingress[0].service,'http://127.0.0.1:8790');
 const allowed=new RegExp(c.ingress[0].path);
 for(const p of ['status','gather','voice','verify','voice-status','relay'])assert.ok(allowed.test('/telephony/twilio/'+p));
 for(const p of ['/','/telephony/twilio/voice/anything','/dashboard','/v1/chat/completions'])assert.equal(allowed.test(p),false);
 assert.match(files.plist,/KeepAlive/);assert.doesNotMatch(files.plist,/--token/);
 assert.throws(()=>tunnelFiles({domain:'x.trycloudflare.com',tunnelId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',credentialsFile:'/a',directory:'/b'}),/permanent/);
});
