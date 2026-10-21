/** Discriminated Result type used across public APIs instead of throwing for expected failures. */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = PottsError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Stable machine-readable error codes. Add new codes; never repurpose old ones. */
export type ErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'config_invalid'
  | 'policy_invalid'
  | 'policy_file_insecure'
  | 'secret_unresolved'
  | 'ingress_invalid'
  | 'ingress_replayed'
  | 'ingress_expired'
  | 'ingress_wrong_sender'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_used'
  | 'approval_mismatch'
  | 'approval_not_pending'
  | 'action_state'
  | 'held'
  | 'denied'
  | 'paused'
  | 'revoked'
  | 'no_executor'
  | 'in_flight'
  | 'uncertain_requires_reconcile'
  | 'migration_failed'
  | 'internal';

export class PottsError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PottsError';
    this.code = code;
    this.details = details;
  }
  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export const perr = (code: ErrorCode, message: string, details?: Record<string, unknown>): Err<PottsError> =>
  err(new PottsError(code, message, details));
