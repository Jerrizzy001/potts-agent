import type { ActionKind } from '../policy/catalog.ts';
import { isActionKind } from '../policy/catalog.ts';
import type { AttachmentRef } from '../policy/action.ts';

/** Persisted before the provider is called; passed to execute() and lookup(). */
export interface DispatchIntent {
  dispatchId: string;
  actionId: string;
  attempt: number;
  kind: ActionKind;
  accountId: string | null;
  /** Exact account identity from the registry (e.g. sender address). */
  accountAddress: string | null;
  destination: string[];
  payload: unknown;
  payloadHash: string;
  attachments: AttachmentRef[];
  /**
   * Stable per ACTION (not per attempt). Executors must attach it to the
   * provider request where possible (Message-ID header, client token, call
   * metadata) so lookup() can find the original after a crash or timeout.
   */
  idempotencyKey: string;
  createdAt: string;
}

export interface ExecutorReceipt {
  providerOperationId: string;
  /** Optional small, non-secret detail recorded in the audit log. */
  detail?: Record<string, unknown>;
}

export type LookupResult =
  | { status: 'found'; providerOperationId: string; detail?: Record<string, unknown> }
  /** Provider confirms nothing was accepted for this idempotency key. */
  | { status: 'not_found' }
  /** Provider cannot answer (yet). The dispatch stays uncertain. */
  | { status: 'unknown'; reason?: string };

/**
 * Throw this from execute() ONLY when the provider definitively rejected the
 * request and nothing was sent. Any other error or timeout is treated as an
 * uncertain outcome that requires reconcile() before any retry.
 */
export class ExecutorRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorRejectedError';
  }
}

export interface Executor {
  readonly name: string;
  /** Integration name used for per-integration pause (e.g. "gmail", "github", "deploy"). */
  readonly integration: string;
  readonly kinds: readonly ActionKind[];
  /** Overrides the broker default timeout. */
  readonly timeoutMs?: number;
  execute(intent: Readonly<DispatchIntent>, signal: AbortSignal): Promise<ExecutorReceipt>;
  lookup(intent: Readonly<DispatchIntent>): Promise<LookupResult>;
}

/**
 * Executors are registered by trusted startup code, then the registry is
 * frozen when the broker is created. Nothing reachable from the model can
 * register an executor.
 */
export interface ExecutorRegistry {
  register(executor: Executor): void;
  forKind(kind: string): Executor | undefined;
  list(): readonly Executor[];
  freeze(): void;
  readonly frozen: boolean;
}

export function createExecutorRegistry(): ExecutorRegistry {
  const byKind = new Map<string, Executor>();
  const all: Executor[] = [];
  let frozen = false;
  return {
    register(ex) {
      if (frozen) throw new Error('executor registry is frozen');
      if (!ex.kinds.length) throw new Error(`executor ${ex.name} declares no kinds`);
      for (const k of ex.kinds) {
        if (!isActionKind(k)) throw new Error(`executor ${ex.name}: unknown action kind ${k}`);
        if (byKind.has(k)) throw new Error(`action kind ${k} already has executor ${byKind.get(k)!.name}`);
      }
      for (const k of ex.kinds) byKind.set(k, ex);
      all.push(ex);
    },
    forKind: (k) => byKind.get(k),
    list: () => [...all],
    freeze() {
      frozen = true;
    },
    get frozen() {
      return frozen;
    },
  };
}
