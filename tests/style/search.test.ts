import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatDb } from './chatdb-fixture.ts';
import { searchMessages } from '../../src/connectors/imessage/search.ts';

test('Messages search reads sent/received modern bodies, paginates, filters credentials and never modifies the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'potts-message-search-')), path = join(dir, 'chat.db');
  const db = createChatDb(path, [
    {chat:'work',fromMe:false,text:'Vector Institute interview tomorrow',bodyOnly:true},
    {chat:'work',fromMe:true,text:'Vector Institute sounds good'},
    {chat:'work',fromMe:false,text:'Vector Institute password: secret12345'},
    {chat:'work',fromMe:false,text:'Vector Institute',associatedType:2000},
  ]);
  db.close(); const before = readFileSync(path);
  try {
    const r = searchMessages(path, 'vector institute', {limit:1});
    assert.equal(r.matches.length,1); assert.equal(r.matches[0]!.direction,'sent'); assert.equal(r.withheld,1); assert.equal(r.hasMore,true);
    const next = searchMessages(path,'vector institute',{beforeRowid:r.nextBeforeRowid!});
    assert.equal(next.matches.length,1); assert.equal(next.matches[0]!.direction,'received'); assert.match(next.matches[0]!.text,/interview/);
    assert.equal(searchMessages(path,"' OR 1=1 --").matches.length,0);
    assert.deepEqual(readFileSync(path),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
