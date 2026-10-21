import type { ActionKind } from '../policy/catalog.ts';
import { ExecutorRejectedError, type DispatchIntent, type Executor, type ExecutorReceipt, type LookupResult } from './executor.ts';

/** Simulated remote provider. Share one between broker instances to simulate a crash/restart. */
export interface FakeProvider {
  readonly accepted: { providerOperationId: string; intent: DispatchIntent }[];
  countFor(actionId: string): number;
}
export function createFakeProvider(): FakeProvider {
  const accepted: FakeProvider['accepted'] = [];
  return { accepted, countFor: (id) => accepted.filter((a) => a.intent.actionId === id).length };
}

/**
 * ok: accept and return id · hang: never answer (broker timeout → uncertain)
 * accept_then_throw: accept, then lose the response (→ uncertain)
 * reject: definitive rejection, nothing sent · lookup_unknown: lookup() cannot answer
 */
export type FakeMode = 'ok' | 'hang' | 'accept_then_throw' | 'reject';

export interface FakeExecutor extends Executor {
  mode: FakeMode;
  lookupUnknown: boolean;
  readonly provider: FakeProvider;
  readonly calls: number;
}

export function createFakeExecutor(opts: { name?: string; integration?: string; kinds: ActionKind[]; provider?: FakeProvider; mode?: FakeMode; timeoutMs?: number }): FakeExecutor {
  const provider = opts.provider ?? createFakeProvider();
  let seq = 0;
  let calls = 0;
  const accept = (intent: DispatchIntent): ExecutorReceipt => {
    const providerOperationId = `fake-op-${++seq}-${intent.idempotencyKey}`;
    provider.accepted.push({ providerOperationId, intent: structuredClone(intent) });
    return { providerOperationId };
  };
  const ex: FakeExecutor = {
    name: opts.name ?? 'fake',
    integration: opts.integration ?? 'fake',
    kinds: opts.kinds,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    mode: opts.mode ?? 'ok',
    lookupUnknown: false,
    provider,
    get calls() {
      return calls;
    },
    async execute(intent, signal) {
      calls++;
      switch (ex.mode) {
        case 'ok':
          return accept(intent);
        case 'reject':
          throw new ExecutorRejectedError('fake provider rejected the request');
        case 'accept_then_throw':
          accept(intent);
          throw new Error('connection reset after provider accepted');
        case 'hang':
          return new Promise<ExecutorReceipt>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
    },
    async lookup(intent): Promise<LookupResult> {
      if (ex.lookupUnknown) return { status: 'unknown', reason: 'fake provider lookup unavailable' };
      const hit = provider.accepted.find((a) => a.intent.idempotencyKey === intent.idempotencyKey);
      return hit ? { status: 'found', providerOperationId: hit.providerOperationId } : { status: 'not_found' };
    },
  };
  return ex;
}
