/**
 * Provider-agnostic telephony contracts.
 *
 * NOT AN EMERGENCY SERVICE. Owner alert calls are a convenience that depends
 * on this Mac being on and online, a paid provider account, carrier delivery
 * and quiet hours. They never call emergency services and must never be
 * relied on as a replacement for them.
 */

/** Agreed urgent-call triggers (operating spec). `test` is for owner-run verification calls. */
export const ALERT_TRIGGERS = ['website_outage', 'task_due', 'interview_invitation', 'business_opportunity', 'test'] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

/**
 * Quiet-hours / owner-notification rules (implemented by WP-5's notifications
 * module; WP-8 wires it). Evaluated at proposal AND at actual dispatch.
 */
export interface OwnerAlertDecider {
  evaluateCall(at: Date): { allowed: boolean; reason: string; nextAllowedAt?: string };
}

/** Re-validates the incident behind an alert right before each attempt (WP-5). Synchronous. */
export interface IncidentValidator {
  revalidate(incidentId: string): { active: boolean; reason: string };
}

export interface AlertScript {
  /** Spoken text (already sanitized; no personal profile data). */
  say: string;
  /** Absolute public URL for the DTMF <Gather> action. */
  gatherUrl: string;
  /** Absolute public URL for call status callbacks. */
  statusUrl: string;
}

export interface PlaceCallRequest {
  to: string;
  from: string;
  script: AlertScript;
  /** Ask the provider for answering-machine detection (informational only; never acknowledgement). */
  machineDetection: boolean;
  ringTimeoutSeconds: number;
  idempotencyKey: string;
}

export interface ProviderCall {
  providerCallId: string;
  to: string;
  from: string;
  status: string;
  createdAt: string;
  durationSeconds: number | null;
  price: string | null;
  priceUnit: string | null;
  answeredBy: string | null;
}

export interface TelephonyProvider {
  readonly name: string;
  /**
   * Places one call. Throws ExecutorRejectedError if the provider definitively
   * refused (nothing dialled); any other error means the outcome is unknown.
   */
  placeCall(req: PlaceCallRequest, signal: AbortSignal): Promise<{ providerCallId: string; status: string }>;
  /** Calls to `to` from `from` created at/after `since`. `complete` = no further pages. */
  findCalls(q: { to: string; from: string; since: string }): Promise<{ ok: true; calls: ProviderCall[]; complete: boolean } | { ok: false; reason: string }>;
  getCall(providerCallId: string): Promise<ProviderCall | undefined>;
}
