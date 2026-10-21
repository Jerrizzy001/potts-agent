/**
 * Text rendering for owner-facing replies. Everything that came from the
 * proposer (summary, payload, destinations) is untrusted data: it is shown
 * inside fenced blocks with fences neutralised, never as instructions.
 */

/** Matches src/broker/owner.ts ApprovalPreview. */
export interface ApprovalPreview {
  approvalId: string;
  bindingHash: string;
  expiresAt: string;
  status: string;
  actionId: string;
  kind: string;
  summary: string | null;
  account: { id: string; address: string; kind: string } | null;
  destination: string[];
  payload: unknown;
  attachments: { name: string; sha256: string }[];
  policyVersion: string;
  proposedBy: string;
}

/** Matches src/broker/broker.ts ControlSnapshot. */
export interface ControlSnapshot {
  globalPaused: boolean;
  pausedIntegrations: string[];
  revokedAccounts: string[];
  runtime: { scope: string; state: string; reason: string | null; setBy: string; setAt: string }[];
}

export interface ActionStatusView {
  id: string;
  kind: string;
  accountId: string | null;
  destination: string[];
  status: string;
  decision: string;
  createdAt: string;
  approval: { id: string; status: string; expiresAt: string } | null;
}

/** Above this the preview is not shown in Telegram and approval from Telegram is disabled. */
export const MAX_PREVIEW_CHARS = 12_000;

export function untrusted(text: string): string {
  return String(text).replace(/```/g, "'''").replace(/\u0000/g, '');
}

export function fence(text: string): string {
  return '```\n' + untrusted(text) + '\n```';
}

function payloadText(p: unknown): string {
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.every((k) => typeof o[k] === 'string' || typeof o[k] === 'number' || typeof o[k] === 'boolean' || o[k] === null)) {
      return keys.map((k) => (typeof o[k] === 'string' && (o[k] as string).includes('\n') ? `${k}:\n${o[k] as string}` : `${k}: ${String(o[k])}`)).join('\n');
    }
  }
  return JSON.stringify(p, null, 2);
}

const KIND_WORDS: Record<string, string> = {
  send_message: 'send this message', merge: 'merge this code', deploy: 'deploy this', submit_application: 'submit this job application',
  delete_permanent: 'permanently delete this', account_security_change: 'change account security', purchase: 'make this purchase', call_third_party: 'make this call',
  call_owner_alert: 'call you', support_reply: 'send this support reply', draft: 'save this draft', read: 'read this', monitor: 'monitor this', prepare_fix: 'prepare this fix',
};

export function renderPreview(p: ApprovalPreview): { text: string; complete: boolean } {
  const via = p.account ? ` from ${untrusted(p.account.address)}` : '';
  const to = p.destination.length ? ` to ${untrusted(p.destination.join(', '))}` : '';
  const lines = [
    `Potts wants to ${KIND_WORDS[p.kind] ?? p.kind}${via}${to}. Exactly this:`,
    fence(payloadText(p.payload)),
  ];
  if (p.attachments.length) lines.push(`Attachments: ${p.attachments.map((a) => `${untrusted(a.name)} (sha256 ${a.sha256.slice(0, 12)}…)`).join(', ')}`);
  if (p.summary) lines.push(`Potts's note (not part of what gets approved): ${untrusted(p.summary).slice(0, 300)}`);
  lines.push(`Approve or deny below. Ref ${p.approvalId}, expires ${p.expiresAt}.`);
  const text = lines.join('\n');
  if (text.length > MAX_PREVIEW_CHARS) {
    return {
      text: [lines[0], `This is ${text.length} characters, too long to review safely here, so it cannot be approved from Telegram. Deny it, or review it on the Mac. Ref ${p.approvalId}.`].join('\n'),
      complete: false,
    };
  }
  return { text, complete: true };
}

export function renderControls(c: ControlSnapshot): string {
  const lines = [`Global: ${c.globalPaused ? 'PAUSED' : 'running'}`];
  lines.push(`Paused integrations: ${c.pausedIntegrations.length ? c.pausedIntegrations.join(', ') : 'none'}`);
  lines.push(`Revoked accounts: ${c.revokedAccounts.length ? c.revokedAccounts.join(', ') : 'none'}`);
  return lines.join('\n');
}

export function renderActionLine(a: ActionStatusView): string {
  const dest = a.destination.length ? ` → ${untrusted(a.destination.slice(0, 3).join(', '))}${a.destination.length > 3 ? '…' : ''}` : '';
  return `• ${a.kind} [${a.status}]${a.accountId ? ` via ${a.accountId}` : ''}${dest} (${a.id})`;
}

export function renderPendingLine(p: ApprovalPreview): string {
  const dest = p.destination.length ? ` → ${untrusted(p.destination.slice(0, 3).join(', '))}${p.destination.length > 3 ? '…' : ''}` : '';
  return `• ${p.kind}${p.account ? ` via ${p.account.id}` : ''}${dest}\n  /papprove ${p.approvalId}  (expires ${p.expiresAt})`;
}
