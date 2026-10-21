import type { ControlSnapshot } from '../broker/broker.ts';
import type { Capability, CapabilityState } from './model.ts';

const LABEL: Record<CapabilityState, string> = {
  not_connected: 'not connected',
  read_only: 'read-only',
  draft_only: 'draft-only',
  approval_required: 'approval required',
  automatic: 'automatic',
  paused: 'PAUSED',
  stale: 'STALE',
  blocked: 'BLOCKED',
};

export function stateLabel(s: CapabilityState): string {
  return LABEL[s];
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** Fixed-width table for the terminal (`npm run status`). */
export function renderStatusTable(caps: readonly Capability[], controls?: ControlSnapshot | null): string {
  const w1 = Math.min(44, Math.max(10, ...caps.map((c) => c.label.length)));
  const w2 = Math.max(...caps.map((c) => LABEL[c.state].length), 5);
  const lines: string[] = [];
  if (controls) lines.push(renderControlsLine(controls), '');
  lines.push(`${pad('CAPABILITY', w1)}  ${pad('STATE', w2)}  REASON`);
  lines.push(`${'-'.repeat(w1)}  ${'-'.repeat(w2)}  ${'-'.repeat(40)}`);
  for (const c of caps) lines.push(`${pad(c.label.slice(0, w1), w1)}  ${pad(LABEL[c.state], w2)}  ${c.reason}`);
  return lines.join('\n');
}

export function renderControlsLine(c: ControlSnapshot): string {
  const parts = [`Global: ${c.globalPaused ? 'PAUSED' : 'running'}`];
  if (c.pausedIntegrations.length) parts.push(`paused: ${c.pausedIntegrations.join(', ')}`);
  if (c.revokedAccounts.length) parts.push(`revoked: ${c.revokedAccounts.join(', ')}`);
  return parts.join(' | ');
}

/** Compact text for Telegram /pstatus (plain text, short lines, no tables). */
export function renderStatusTelegram(caps: readonly Capability[], maxChars = 3000): string {
  const order: CapabilityState[] = ['blocked', 'stale', 'paused', 'approval_required', 'automatic', 'draft_only', 'read_only', 'not_connected'];
  const sorted = [...caps].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const lines = ['Capabilities:'];
  for (const c of sorted) {
    const reason = c.reason.length > 140 ? `${c.reason.slice(0, 137)}...` : c.reason;
    lines.push(`- ${c.label}: ${LABEL[c.state]}${c.state === 'not_connected' ? '' : ` (${reason})`}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n...(truncated)`;
  return text;
}
