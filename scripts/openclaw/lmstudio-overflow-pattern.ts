/** Reversible OpenClaw 2026.9.8 patch: teach the context-overflow matcher LM Studio's wording.
 * LM Studio (contextOverflowPolicy=stopAtLimit) answers an oversized prompt with
 * "Input does not fit in context length. The input has N tokens, but the context length only supports M tokens."
 * OpenClaw's tables do not recognize that, so compaction/truncation recovery never runs and the turn
 * fails with "Agent couldn't generate a response". This adds the phrase to CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE,
 * which is already listed in both the assistant-error and failover-explicit scopes. Classification only.
 * Re-run after an OpenClaw update; it refuses unrecognized shapes.
 *   node --disable-warning=ExperimentalWarning scripts/openclaw/lmstudio-overflow-pattern.ts <openclaw-package-root> [--apply]
 * The live table is in node_modules/@openclaw/ai/dist/internal/runtime.mjs under the OpenClaw package root.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const MARKER = '/* Potts: LM Studio overflow wording */';
const ORIGINAL = 'CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE = /prompt has [\\d,]+ tokens?, but the configured context size is [\\d,]+ tokens?/i;';
const PATCHED = `CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE = ${MARKER} /(?:prompt has [\\d,]+ tokens?, but the configured context size is [\\d,]+ tokens?|input does not fit in context length)/i;`;
export function patchOverflowPattern(source: string): string {
  if (source.includes(MARKER)) return source;
  if (source.split(ORIGINAL).length !== 2) throw new Error('Unrecognized OpenClaw overflow pattern; nothing changed');
  return source.replace(ORIGINAL, PATCHED);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw new Error('Usage: node scripts/openclaw/lmstudio-overflow-pattern.ts <openclaw-package-root> [--apply]');
  const path = join(root, 'node_modules', '@openclaw', 'ai', 'dist', 'internal', 'runtime.mjs'); const old = readFileSync(path, 'utf8'); const updated = patchOverflowPattern(old);
  if (old === updated) console.log('LM Studio overflow wording already installed.');
  else if (!process.argv.includes('--apply')) console.log(`Ready to update the overflow classifier: ${path}`);
  else { const backup = `${path}.potts-backup-${Date.now()}`; copyFileSync(path, backup); writeFileSync(path, updated); console.log(`Installed. Backup: ${backup}`); }
}
