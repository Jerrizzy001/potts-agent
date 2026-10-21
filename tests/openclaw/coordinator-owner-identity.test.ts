import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureIMessageOwner} from '../../scripts/coordinator/owner-identity.ts';

test('iMessage migration aligns global owner authority with the routed owner and removes stale Telegram authority',()=>{
  const cfg={channels:{imessage:{allowFrom:['+14165550123']}},commands:{ownerAllowFrom:['telegram:123456'],otherSetting:true}};
  assert.equal(configureIMessageOwner(cfg),'+14165550123');
  assert.deepEqual(cfg.commands,{ownerAllowFrom:['imessage:+14165550123'],otherSetting:true});
  configureIMessageOwner(cfg);
  assert.deepEqual(cfg.commands.ownerAllowFrom,['imessage:+14165550123']);
});

test('invalid or ambiguous owners fail before altering owner authority',()=>{
  for(const allowFrom of [undefined,[],['*'],['+14165550123','+14165550456'],[12345],['imessage:+14165550123']]){
    const cfg={channels:{imessage:{allowFrom}},commands:{ownerAllowFrom:['telegram:123456']}};
    assert.throws(()=>configureIMessageOwner(cfg),/exactly one/);
    assert.deepEqual(cfg.commands.ownerAllowFrom,['telegram:123456']);
  }
});
