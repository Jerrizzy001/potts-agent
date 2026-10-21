/**
 * Test harness for the broker. Imported by tests (this and other work
 * packages); never used by production wiring. Uses a fake clock, a temp or
 * in-memory DB, a random ingress key and fake executors.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock, type FakeClock } from '../core/clock.ts';
import { createAccountRegistry, type AccountEntry } from '../core/config.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { migrate } from '../store/migrate.ts';
import { buildPolicy, DEFAULT_POLICY, type LoadedPolicy, type PolicyDocument } from '../policy/document.ts';
import type { PolicyHooks } from '../policy/decide.ts';
import { createIngressVerifier, signOwnerIngress, type OwnerIngressFields, type OwnerIngressProof, type OwnerIntent } from '../approvals/ingress.ts';
import { createExecutorRegistry, type Executor } from './executor.ts';
import { createFakeExecutor, createFakeProvider, type FakeExecutor, type FakeProvider } from './fake-executor.ts';
import { createBroker, type Broker, type BrokerOptions } from './broker.ts';
import { createOwnerControls, type OwnerControls } from './owner.ts';

export const TEST_OWNER_ID = '424242';

export const TEST_ACCOUNTS: AccountEntry[] = [
  { id: 'gmail-personal', kind: 'gmail', address: 'owner@example.com', mode: 'approval_required', purpose: 'personal' },
  { id: 'gmail-work', kind: 'gmail', address: 'work@example.com', mode: 'approval_required', purpose: 'personal' },
  { id: 'outlook-work', kind: 'outlook', address: 'student@example.edu', mode: 'read_only', purpose: 'personal' },
  { id: 'gmail-drafts', kind: 'gmail', address: 'drafts@example.com', mode: 'draft_only', purpose: 'personal' },
  { id: 'gmail-off', kind: 'gmail', address: 'off@example.com', mode: 'not_connected' },
  { id: 'support-desk', kind: 'gmail', address: 'support@example.com', mode: 'automatic', purpose: 'support' },
  { id: 'telephony-alerts', kind: 'telephony', address: '+15550000000', mode: 'approval_required', purpose: 'owner_alert' },
];

export interface TestHarness {
  db: Db;
  dbPath: string;
  dir: string;
  clock: FakeClock;
  broker: Broker;
  owner: OwnerControls;
  key: Buffer;
  provider: FakeProvider;
  /** Handles send_message, support_reply (integration "mail"). */
  mailExec: FakeExecutor;
  /** Handles merge, deploy (integration "deploy"). */
  deployExec: FakeExecutor;
  /** Handles every other kind (integration "misc"). */
  miscExec: FakeExecutor;
  policy: { current: LoadedPolicy };
  setPolicy(doc: Partial<PolicyDocument>): void;
  /** Signs an owner intent as the trusted ingress would. */
  sign(intent: OwnerIntent, overrides?: Partial<OwnerIngressFields>): OwnerIngressProof;
  /** Owner approves the live approval of an action exactly as previewed. */
  approve(actionId: string): ReturnType<OwnerControls['handle']>;
  /** Close DB and reopen a fresh broker on the same file (crash/restart simulation). */
  reopen(extra?: Partial<BrokerOptions>): TestHarness;
  close(): void;
}

export interface HarnessOptions {
  accounts?: AccountEntry[];
  policy?: Partial<PolicyDocument>;
  hooks?: PolicyHooks;
  brokerOptions?: Partial<BrokerOptions>;
  executorTimeoutMs?: number;
  /** Reuse state (for reopen). */
  reuse?: { dir: string; dbPath: string; clock: FakeClock; key: Buffer; provider: FakeProvider; policy: { current: LoadedPolicy }; updateSeq: { n: number } };
}

export function createTestHarness(o: HarnessOptions = {}): TestHarness {
  const dir = o.reuse?.dir ?? mkdtempSync(join(tmpdir(), 'potts-test-'));
  const dbPath = o.reuse?.dbPath ?? join(dir, 'potts.db');
  const clock = o.reuse?.clock ?? createFakeClock('2026-10-06T14:00:00.000Z');
  const key = o.reuse?.key ?? randomBytes(32);
  const provider = o.reuse?.provider ?? createFakeProvider();
  const updateSeq = o.reuse?.updateSeq ?? { n: 1000 };
  const mk = (doc: Partial<PolicyDocument>) => {
    const r = buildPolicy({ ...DEFAULT_POLICY, ...doc });
    if (!r.ok) throw r.error;
    return r.value;
  };
  const policy = o.reuse?.policy ?? { current: mk(o.policy ?? {}) };
  const db = openDatabase(dbPath);
  migrate(db, { clock });
  const accounts = createAccountRegistry(o.accounts ?? TEST_ACCOUNTS);
  const registry = createExecutorRegistry();
  const t = o.executorTimeoutMs ? { timeoutMs: o.executorTimeoutMs } : {};
  const mailExec = createFakeExecutor({ name: 'fake-mail', integration: 'mail', kinds: ['send_message', 'support_reply'], provider, ...t });
  const deployExec = createFakeExecutor({ name: 'fake-deploy', integration: 'deploy', kinds: ['merge', 'deploy'], provider, ...t });
  const miscExec = createFakeExecutor({
    name: 'fake-misc', integration: 'misc', provider, ...t,
    kinds: ['read', 'monitor', 'draft', 'prepare_fix', 'submit_application', 'delete_permanent', 'account_security_change', 'purchase', 'call_third_party', 'call_owner_alert'],
  });
  for (const e of [mailExec, deployExec, miscExec] as Executor[]) registry.register(e);
  const broker = createBroker({
    db, clock, accounts, executors: registry, policy: () => policy.current,
    hooks: { scoped: () => ({ outcome: 'allow', reasons: ['synthetic test task authorized by the test harness'] }), ...o.hooks },
    ...o.brokerOptions,
  });
  const verifier = createIngressVerifier({ key, ownerSenderId: TEST_OWNER_ID, clock });
  const owner = createOwnerControls(broker, verifier, accounts);
  const sign = (intent: OwnerIntent, ov: Partial<OwnerIngressFields> = {}) =>
    signOwnerIngress(key, {
      source: 'telegram', senderId: TEST_OWNER_ID, chatId: TEST_OWNER_ID, chatType: 'private', updateId: String(++updateSeq.n),
      receivedAt: clock.nowIso(), intent, ...ov,
    });
  const h: TestHarness = {
    db, dbPath, dir, clock, broker, owner, key, provider, mailExec, deployExec, miscExec, policy,
    setPolicy(doc) {
      policy.current = mk({ ...policy.current.doc, ...doc });
    },
    sign,
    approve(actionId) {
      const live = broker.approvals.live(actionId);
      if (!live) throw new Error(`no live approval for ${actionId}`);
      return owner.handle(sign({ type: 'approve', approvalId: live.id, bindingHash: live.bindingHash }));
    },
    reopen(extra = {}) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      return createTestHarness({ ...o, brokerOptions: { ...o.brokerOptions, testHooks: {}, ...extra }, reuse: { dir, dbPath, clock, key, provider, policy, updateSeq } });
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
