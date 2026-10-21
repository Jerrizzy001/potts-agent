/** A provider change is incomplete until each agent's derived index matches it. */
export function refreshMemoryIndexes(
  run: (args: string[]) => string,
  agents: readonly string[] = ['main', 'potts-coordinator'],
): { agentId: string; indexed: true }[] {
  const repaired: { agentId: string; indexed: true }[] = [];
  const failed: string[] = [];
  for (const agentId of agents) {
    try {
      const output = run(['memory', 'status', '--index', '--agent', agentId, '--json']);
      // The CLI can emit informational lines before its JSON array.
      const start = output.search(/^\s*\[\s*$/m);
      if (start < 0) throw new Error('missing status');
      const rows: unknown = JSON.parse(output.slice(start));
      if (!Array.isArray(rows)) throw new Error('invalid status');
      const row = rows.find((x) => x?.agentId === agentId);
      if (row?.status?.custom?.indexIdentity?.status !== 'valid'
        || row?.status?.fts?.available !== true
        || row?.status?.provider !== 'none') throw new Error('index not ready');
      repaired.push({ agentId, indexed: true });
    } catch {
      // Do not print raw CLI output; it can contain private memory snippets.
      failed.push(agentId);
    }
  }
  if (failed.length) throw new Error(`Configuration was applied, but memory indexing was not verified for: ${failed.join(', ')}. Run openclaw memory status --index --agent <id> and verify indexIdentity is valid before declaring setup complete.`);
  return repaired;
}
