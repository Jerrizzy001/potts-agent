import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshMemoryIndexes } from '../../scripts/coordinator/memory-index.ts';

const status = (agentId: string, identity = 'valid', provider = 'none') => JSON.stringify([
  { agentId, status: { provider, fts: { available: true }, custom: { indexIdentity: { status: identity } } } },
], null, 2);

test('coordinator setup verifies both independent indexes after migration despite CLI preamble', () => {
  const calls: string[][] = [];
  assert.deepEqual(refreshMemoryIndexes((args) => {
    calls.push(args);
    return `[state/agent-db] integrity gate\n${status(args[4]!)}\n`;
  }), [{ agentId: 'main', indexed: true }, { agentId: 'potts-coordinator', indexed: true }]);
  assert.deepEqual(calls.map((args) => args[4]), ['main', 'potts-coordinator']);
  assert.ok(calls.every((args) => args.includes('--index')));
});

test('a stale worker index prevents setup success but does not skip coordinator repair', () => {
  const seen: string[] = [];
  assert.throws(() => refreshMemoryIndexes((args) => {
    seen.push(args[4]!);
    return status(args[4]!, args[4] === 'main' ? 'mismatched' : 'valid');
  }), /not verified for: main\./);
  assert.deepEqual(seen, ['main', 'potts-coordinator']);
});

test('wrong agent, wrong provider and malformed output cannot count as repaired', () => {
  for (const output of [status('other'), status('main', 'valid', 'openai-compatible'), '[]', 'private snippet']) {
    assert.throws(() => refreshMemoryIndexes(() => output, ['main']), /not verified for: main\./);
  }
});

test('index command failures stay actionable without leaking subprocess content', () => {
  assert.throws(() => refreshMemoryIndexes(() => { throw new Error('PRIVATE CONTENT'); }, ['main']), (error: Error) => {
    assert.match(error.message, /Configuration was applied/);
    assert.doesNotMatch(error.message, /PRIVATE CONTENT/);
    return true;
  });
});
