/** Reversible presentation-only workaround for OpenClaw 2026.9.8 Telegram exec receipts.
 * Full pending command previews, approvals, binding checks and the audit store are untouched.
 * Re-run after an OpenClaw update only if this script still recognizes the formatter.
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const MARKER = '// Potts compact exec receipts: presentation only';
export function compactReceipts(source: string): string {
  if (source.includes(MARKER)) return source;
  const edits = [
    ['function buildTelegramNativeResolvedApprovalText(view) {', '\n\tif (view.approvalKind === "exec") return view.decision === "deny" ? "Not approved." : view.decision?.startsWith("allow-") ? "Approved." : "Request closed.";'],
    ['function buildTelegramNativeExpiredApprovalText(view) {', '\n\tif (view.approvalKind === "exec") return "That approval request expired.";'],
    ['function buildTelegramCanonicalApprovalTerminalText(params) {', '\n\tif (params.result.approval.presentation?.kind === "exec") {\n\t\tconst status = params.result.approval.status;\n\t\treturn status === "allowed" ? "Approved." : status === "denied" ? "Not approved." : status === "expired" ? "That approval request expired." : "Request closed.";\n\t}'],
  ];
  for (const [signature, addition] of edits) {
    if (source.split(signature!).length !== 2) throw new Error('Unrecognized OpenClaw receipt formatter; nothing changed');
    source = source.replace(signature!, signature! + addition!);
  }
  return `${MARKER}\n${source}`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = process.argv[2];
  if (!dist) throw new Error('Usage: node scripts/openclaw/compact-approval-receipts.ts <openclaw-dist> [--apply]');
  const files = readdirSync(dist).filter(f => /^approval-terminal-.*\.mjs$/.test(f)).filter(f => readFileSync(join(dist,f),'utf8').includes('function buildTelegramNativeResolvedApprovalText(view)'));
  if (files.length !== 1) throw new Error('Expected exactly one Telegram receipt formatter');
  const path=join(dist,files[0]!); const old=readFileSync(path,'utf8'); const updated=compactReceipts(old);
  if (old===updated) console.log('Compact receipts already installed.');
  else if (!process.argv.includes('--apply')) console.log(`Ready to update receipt presentation only: ${path}`);
  else { const backup=`${path}.potts-backup-${Date.now()}`; copyFileSync(path,backup); writeFileSync(path,updated); console.log(`Installed compact receipt labels. Backup: ${backup}`); }
}
