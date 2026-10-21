/**
 * Action catalog. The classification of each kind is HARD-CODED here, not in
 * the owner policy file: the policy file can tune parameters (TTL, support
 * channels) but can never turn an always-approval kind into an automatic one.
 * Adding a kind is a code change reviewed like any other security change.
 */
export const ACTION_CLASSES = ['scoped', 'always_approval', 'owner_alert', 'support_reply'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const ACTION_CATALOG = {
  // Preauthorized under the registered task/source scope.
  read: { class: 'scoped', write: false, needsDestination: false, description: 'Read an approved source' },
  monitor: { class: 'scoped', write: false, needsDestination: false, description: 'Monitor an approved source' },
  draft: { class: 'scoped', write: false, needsDestination: false, description: 'Prepare a local draft (never sent)' },
  prepare_fix: { class: 'scoped', write: false, needsDestination: false, description: 'Prepare and test a fix in an isolated working copy' },
  // Always require an explicit owner approval bound to the exact payload.
  send_message: { class: 'always_approval', write: true, needsDestination: true, description: 'Send a personal message or reply' },
  merge: { class: 'always_approval', write: true, needsDestination: true, description: 'Merge an exact commit into a target branch' },
  deploy: { class: 'always_approval', write: true, needsDestination: true, description: 'Deploy an exact artifact/commit to a target' },
  submit_application: { class: 'always_approval', write: true, needsDestination: true, description: 'Final job application submission' },
  delete_permanent: { class: 'always_approval', write: true, needsDestination: true, description: 'Permanently delete data' },
  account_security_change: { class: 'always_approval', write: true, needsDestination: true, description: 'Change account security settings' },
  purchase: { class: 'always_approval', write: true, needsDestination: true, description: 'Purchase, subscription, credits or extra paid usage' },
  call_third_party: { class: 'always_approval', write: true, needsDestination: true, description: 'Call someone other than the owner' },
  // Standing permission, subject to hooks (quiet hours, trigger verification, retry limits).
  call_owner_alert: { class: 'owner_alert', write: true, needsDestination: true, description: 'Alert call to the owner' },
  // Registered support channel + approved knowledge only; otherwise owner review.
  support_reply: { class: 'support_reply', write: true, needsDestination: true, description: 'Reply to a customer on a registered support channel' },
} as const satisfies Record<string, { class: ActionClass; write: boolean; needsDestination: boolean; description: string }>;

export type ActionKind = keyof typeof ACTION_CATALOG;
export const ACTION_KINDS = Object.keys(ACTION_CATALOG) as ActionKind[];
export const ALWAYS_APPROVAL_KINDS = ACTION_KINDS.filter((k) => ACTION_CATALOG[k].class === 'always_approval');

export function isActionKind(k: unknown): k is ActionKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(ACTION_CATALOG, k);
}
export function classOf(kind: string): ActionClass | 'unknown' {
  return isActionKind(kind) ? ACTION_CATALOG[kind].class : 'unknown';
}
