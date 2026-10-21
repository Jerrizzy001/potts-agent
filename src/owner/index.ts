/**
 * WP-2 owner integration entry module.
 *
 * - OwnerChannel: daemon → owner notifications through the gateway's existing
 *   Telegram bot (never a second bot consumer).
 * - Owner-control verification for non-broker owner commands (memory forget).
 * - Re-exports of the plugin's pure helpers that the daemon needs (approval
 *   codes / callback data), so there is one implementation.
 *
 * The trusted Telegram ingress itself runs inside the OpenClaw gateway as the
 * potts-broker plugin (integrations/openclaw/potts-broker-plugin).
 */
export * from './owner-channel.ts';
export * from './owner-control.ts';
export { approvalCode, verifyApprovalCode, callbackData, parseCallbackPayload, CALLBACK_NAMESPACE, APPROVAL_ID_PATTERN, ACTION_ID_PATTERN } from '../../integrations/openclaw/potts-broker-plugin/lib/nonce.ts';
export { checkOwnerCommand, checkOwnerCallback } from '../../integrations/openclaw/potts-broker-plugin/lib/guard.ts';
export { PAYLOAD_SCHEMAS, ACTION_KINDS as AGENT_TOOL_ACTION_KINDS } from '../../integrations/openclaw/potts-broker-plugin/lib/tools.ts';
