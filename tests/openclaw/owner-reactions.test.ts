import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerReactions, type ReactionContext } from '../../integrations/openclaw/potts-broker-plugin/lib/owner-reactions.ts';
const owner = '+14165550199';
const ctx: ReactionContext = { messageChannel: 'imessage', requesterSenderId: owner, senderIsOwner: true, nativeChannelId: '123', assertInvocationCurrent() {} };
const target = { conversationId: '123', messageId: '12345678-1234-1234-1234-123456789abc', reaction: 'like' as const };
test('precise reactions persist uncertainty, reconcile, deduplicate and remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reactions-')); const path = join(dir, 'state.db');
  let present = false, calls = 0, fail = true;
  const adapter = { ready: async () => true, inspect: async () => ({ ownerId: owner, isGroup: false, isForwarded: false, present }), set: async (_: unknown, desired: boolean) => { calls++; if (fail) throw new Error('timeout'); present = desired; } };
  let service = createOwnerReactions(path, adapter);
  try {
    assert.equal((await service.set(ctx, owner, target, true)).status, 'uncertain');
    service.close(); service = createOwnerReactions(path, adapter);
    assert.equal((await service.set(ctx, owner, target, true)).status, 'uncertain'); assert.equal(calls, 1);
    present = true; fail = false;
    assert.equal((await service.set(ctx, owner, target, true)).status, 'unchanged');
    assert.equal((await service.set(ctx, owner, target, false)).status, 'applied'); assert.equal(calls, 2);
    assert.equal((await service.set(ctx, owner, target, false)).status, 'unchanged');
    assert.equal((await service.set({ ...ctx, requesterSenderId: 'other' }, owner, target, true)).status, 'rejected');
    assert.equal((await service.set(ctx, owner, { ...target, conversationId: 'other' }, true)).status, 'rejected');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('unavailable precise transport never dispatches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reactions-')); const service = createOwnerReactions(join(dir, 'state.db'));
  try { assert.equal((await service.set(ctx, owner, target, true)).status, 'unavailable'); } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('concurrent clicks and invalid target metadata never duplicate a dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reactions-'));
  let release!: () => void, calls = 0, present = false, group = false, forwarded = false;
  const barrier = new Promise<void>(r => { release = r; });
  const service = createOwnerReactions(join(dir, 'state.db'), {
    ready: async () => true,
    inspect: async () => ({ ownerId: owner, isGroup: group, isForwarded: forwarded, present }),
    set: async (_target, desired) => { calls++; await barrier; present = desired; },
  });
  try {
    const first = service.set(ctx, owner, target, true);
    await new Promise<void>(r => setImmediate(r));
    assert.equal((await service.set(ctx, owner, target, true)).status, 'uncertain');
    release(); assert.equal((await first).status, 'applied'); assert.equal(calls, 1);
    group = true; assert.equal((await service.set(ctx, owner, target, false)).status, 'rejected');
    group = false; forwarded = true; assert.equal((await service.set(ctx, owner, target, false)).status, 'rejected');
    assert.equal(calls, 1);
  } finally { release(); service.close(); rmSync(dir, { recursive: true, force: true }); }
});
