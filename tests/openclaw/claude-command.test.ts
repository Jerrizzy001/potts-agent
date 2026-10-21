import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferKind, parseClaudeArgs } from '../../integrations/openclaw/potts-broker-plugin/lib/claude-command.ts';

test('/claude parsing: aliases, quoted and bare paths, effort kind', () => {
  assert.deepEqual(parseClaudeArgs('exampleapp why is the build failing on main'), { task: 'why is the build failing on main', project: '/path/to/example-project', kind: 'debugging' });
  assert.deepEqual(parseClaudeArgs('"/Users/x/My App" add a dark mode toggle'), { task: 'add a dark mode toggle', project: '/Users/x/My App', kind: 'coding' });
  assert.deepEqual(parseClaudeArgs('/tmp/proj write a csv parser module'), { task: 'write a csv parser module', project: '/tmp/proj', kind: 'coding' });
  assert.equal((parseClaudeArgs('give me ideas for the landing page') as { kind: string }).kind, 'brainstorming');
  assert.ok('error' in parseClaudeArgs(''));
  assert.ok('error' in parseClaudeArgs('potts hi'));
  assert.equal(inferKind('the login page crashes'), 'debugging');
});
