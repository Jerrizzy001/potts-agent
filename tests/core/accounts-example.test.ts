/**
 * WP-9: config/accounts.example.json secretRefs must point at the places the
 * code actually reads/writes those secrets, and validate with the schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../../src/core/config.ts';
import { isSecretRef } from '../../src/core/secrets.ts';
import { credentialIdFor } from '../../src/connectors/oauth/types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const load = (f: string) => JSON.parse(readFileSync(join(ROOT, 'config', f), 'utf8')) as Record<string, any>;

test('accounts.example.json validates and its secretRefs match the real storage locations', () => {
  const cfg = load('potts.example.json');
  const accounts = load('accounts.example.json');
  const v = validateConfig(cfg, accounts);
  assert.ok(v.ok, JSON.stringify(!v.ok && v.error));
  const svc = cfg.connectors.tokenStore.keychainService as string;
  for (const a of accounts.accounts as { id: string; kind: string; secretRefs?: Record<string, string> }[]) {
    const refs = a.secretRefs ?? {};
    for (const r of Object.values(refs)) assert.ok(isSecretRef(r), `${a.id}: ${r} is a reference`);
    switch (a.kind) {
      case 'gmail':
      case 'outlook':
        assert.deepEqual(refs, { oauthTokens: `keychain:${svc}/${credentialIdFor(a.id, 'read')}`, oauthSendTokens: `keychain:${svc}/${credentialIdFor(a.id, 'send')}` }, a.id);
        break;
      case 'telephony':
        assert.equal(cfg.telephony.accountId, a.id);
        assert.deepEqual(refs, { accountSid: cfg.telephony.twilio.accountSidRef, authToken: cfg.telephony.twilio.authTokenRef });
        break;
      default:
        // telegram (OpenClaw owns the bot token) and imessage (no secret) carry no references.
        assert.deepEqual(refs, {}, `${a.id} should not declare unused secret references`);
    }
  }
});
