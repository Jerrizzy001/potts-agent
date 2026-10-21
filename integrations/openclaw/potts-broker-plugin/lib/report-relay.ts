/**
 * Worker report delivery (Claude and Sol jobs).
 *
 * Only the validated short owner update goes to the owner's configured chat through the gateway's own
 * `openclaw message send` (same adapter as every reply; owner id from the secret reference, no
 * recipient parameter). A short assistant note is then appended to the coordinator's session with
 * `chat.inject` (no model run, no channel delivery) so the coordinator can answer follow-ups.
 * The local coordinator no longer spends a full turn and its small context re-summarizing reports.
 *
 * "delivered" requires the CLI's `"ok": true` receipt. A failed delivery is never retried here.
 */
import { readFileSync } from 'node:fs';
import type { Spawner } from './claude-task.ts';
import { deliveryReceiptAccepted } from './delivery-receipt.ts';

/** Never truncate an owner update: that could remove its caveat. */
export const OWNER_REPORT_MAX = 500;
/** Kept small: the note sits in the coordinator's 32k-token context. */
export const COORDINATOR_NOTE_MAX = 900;

export type RelayStatus = 'delivered' | 'failed' | 'uncertain';

export interface RelayParams {
  spawner: Spawner;
  cli: string;
  cwd: string;
  relayLog: string;
  noteLog: string;
  ownerId: string;
  deliveryChannel?: 'telegram' | 'imessage';
  deliveryTarget?: string;
  coordinatorAgentId: string;
  /** e.g. "Sol job sol_..." */
  jobRef: string;
  /** Raw worker report envelope, never sent verbatim. */
  text: string;
  executionStatus?: 'done' | 'failed' | 'interrupted';
  onDelivery(status: RelayStatus): void;
}

const clip = (s: string, max: number, tail: string) => (s.length <= max ? s : `${s.slice(0, max - tail.length).trimEnd()}${tail}`);

export const WORKER_REPORT_INSTRUCTIONS = `Return your final result as one JSON object, without code fences: {"version":1,"outcome":"completed|partial|blocked","ownerMessage":"...","detailedReport":"..."}. outcome describes the requested work, not whether your process stopped. ownerMessage is a natural, casual update to the owner in 2–3 short sentences, at most 400 characters. State the actual result and every material unfinished item, blocker or action he needs to take. Do not claim success beyond verified evidence. Keep commands, internal tool/job IDs, file paths, test logs and housekeeping out of ownerMessage. Put exact commands, paths, test results, evidence, limitations and diagnostics in detailedReport (the activity record). A memory problem belongs in ownerMessage only when it materially affects this result; describe its effect in ordinary language, with repair commands in detailedReport. Even if the task asks for technical evidence, preserve that evidence in detailedReport, not the automatic message.`;

export type ReportedOutcome = 'completed' | 'partial' | 'blocked' | 'unknown';
export interface WorkerReport {
  ownerMessage: string;
  detailedReport: string;
  reportedOutcome: ReportedOutcome;
  reportFormat: 'structured' | 'fallback';
}
export const REPORT_FALLBACK = 'The task run ended, but I couldn’t prepare a clear update. I saved the details; completion still needs checking.';

/** Validate the whole envelope. Legacy/malformed output stays in the activity record. */
export function parseWorkerReport(raw: string): WorkerReport {
  const fallback: WorkerReport = { ownerMessage: REPORT_FALLBACK, detailedReport: raw, reportedOutcome: 'unknown', reportFormat: 'fallback' };
  try {
    const r = JSON.parse(raw);
    if (!r || r.version !== 1 || !['completed', 'partial', 'blocked'].includes(r.outcome) ||
      typeof r.ownerMessage !== 'string' || typeof r.detailedReport !== 'string' || !r.detailedReport.trim()) return fallback;
    const message = r.ownerMessage.trim();
    // These are activity-record syntax, not conversational owner updates.
    if (!message || message.length > 400 || /[\n\r`{}]|(?:^|\s)(?:\/Users\/|\/tmp\/|~\/|--[a-z])|\b(?:potts_[a-z_]+|sol_\d+|cc_\d+|openclaw memory|LOCAL-SETUP\.txt)\b/.test(message)) return fallback;
    const qualifier = r.outcome === 'partial' ? 'Some work is still unfinished. ' : r.outcome === 'blocked' ? 'I couldn’t finish this yet. ' : '';
    const ownerMessage = qualifier + message;
    if (ownerMessage.length > OWNER_REPORT_MAX) return fallback;
    return { ownerMessage, detailedReport: r.detailedReport, reportedOutcome: r.outcome, reportFormat: 'structured' };
  } catch { return fallback; }
}

export function ownerReportText(text: string, executionStatus: RelayParams['executionStatus'] = 'done'): string {
  // An execution failure overrides even a well-formed model claim of success.
  if (executionStatus === 'interrupted') return 'I couldn’t confirm that task finished. I saved the details and haven’t restarted it because it may still be running.';
  if (executionStatus === 'failed') return 'I couldn’t confirm that task finished correctly. I saved the details and haven’t retried it.';
  return parseWorkerReport(text).ownerMessage;
}

export function coordinatorNote(jobRef: string, status: RelayStatus, sent: string): string {
  return status === 'delivered'
    ? `Sent the owner the report from ${jobRef} (full text: potts_worker_status):\n${clip(sent, COORDINATOR_NOTE_MAX, ' …')}`
    : status === 'uncertain'
      ? `Delivery of the report from ${jobRef} is unconfirmed. It may already have reached the owner. The report is in potts_worker_status; do not resend it blindly.`
      : `Delivery of the report from ${jobRef} failed. The report is in potts_worker_status; do not resend it blindly.`;
}

export async function relayWorkerReport(p: RelayParams): Promise<void> {
  const text = ownerReportText(p.text, p.executionStatus);
  let settled = false;
  const channel = p.deliveryChannel ?? 'telegram';
  const target = p.deliveryTarget ?? p.ownerId;
  await p.spawner(p.cli, ['message', 'send', '--channel', channel, '--target', target, '-m', text, '--json'], {
    cwd: p.cwd, outFile: p.relayLog,
    onExit(code) {
      if (settled) return;
      settled = true;
      let status: RelayStatus = 'uncertain';
      try {
        const output = readFileSync(p.relayLog, 'utf8');
        if (code === 0 && deliveryReceiptAccepted(output, channel, target)) status='delivered';
        else if (JSON.parse(output).ok === false) status='failed';
      } catch { /* Missing or malformed acknowledgement does not prove non-delivery. */ }
      p.onDelivery(status);
      const params = { sessionKey: `agent:${p.coordinatorAgentId}:${channel}:direct:${target}`, message: coordinatorNote(p.jobRef, status, text), label: 'worker-report' };
      // Best effort: the report itself is already settled; a missing note only costs the coordinator context.
      void Promise.resolve()
        .then(() => p.spawner(p.cli, ['gateway', 'call', 'chat.inject', '--params', JSON.stringify(params), '--json'], { cwd: p.cwd, outFile: p.noteLog, onExit() {} }))
        .catch(() => {});
    },
  });
}
