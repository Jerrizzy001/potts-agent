// Usage: node merge-section.ts <agents|user> <existingFile|-> <sectionFile>
// Prints the merged file to stdout. Reads only; never writes.
import { existsSync, readFileSync } from 'node:fs';
import { mergeAgentsSection, mergeUserSection } from '../../src/memory/identity.ts';

const [kind, existingPath, sectionPath] = process.argv.slice(2);
if (!kind || !existingPath || !sectionPath || (kind !== 'agents' && kind !== 'user')) {
  process.stderr.write('usage: merge-section.ts <agents|user> <existingFile|-> <sectionFile>\n');
  process.exit(2);
}
const existing = existingPath !== '-' && existsSync(existingPath) ? readFileSync(existingPath, 'utf8') : '';
const section = readFileSync(sectionPath, 'utf8');
process.stdout.write(kind === 'agents' ? mergeAgentsSection(existing, section) : mergeUserSection(existing, section));
