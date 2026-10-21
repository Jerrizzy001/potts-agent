/**
 * /claude <task>: owner-only Telegram command that starts a Claude Code job directly (no local-model
 * routing). Optional first token picks the folder: a project alias (exampleapp, potts), a quoted path,
 * or an absolute/~ path without spaces. The task kind (effort) is inferred from the wording.
 */
import type { TaskKind } from './claude-task.ts';

export const PROJECT_ALIASES: Record<string, string> = {
  exampleapp: '/path/to/example-project',
  'example-app': '/path/to/example-project',
  potts: process.cwd(),
};

export function inferKind(task: string): TaskKind {
  if (/\b(debug|bug|broken|break(s|ing)?|fail(s|ed|ing|ure)?|error|crash(es|ed|ing)?|not working|doesn'?t work|fix|issue|wrong)\b/i.test(task)) return 'debugging';
  if (/\b(idea|ideas|brainstorm|plan|planning|design|strategy|think about|how should|options|approach)\b/i.test(task)) return 'brainstorming';
  return 'coding';
}

export function parseClaudeArgs(raw: string): { task: string; project?: string; kind: TaskKind } | { error: string } {
  let rest = raw.trim();
  if (!rest) return { error: 'Usage: /claude [exampleapp|potts|"/path"] <what you want done>' };
  let project: string | undefined;
  const quoted = /^"([^"]+)"\s+/.exec(rest);
  const first = rest.split(/\s+/, 1)[0]!;
  if (quoted) { project = quoted[1]; rest = rest.slice(quoted[0].length); }
  else if (PROJECT_ALIASES[first.toLowerCase()]) { project = PROJECT_ALIASES[first.toLowerCase()]; rest = rest.slice(first.length).trim(); }
  else if (/^(\/|~\/)/.test(first)) { project = first; rest = rest.slice(first.length).trim(); }
  if (rest.length < 10) return { error: 'Tell Claude a bit more about what you want (at least a sentence).' };
  return { task: rest, ...(project ? { project } : {}), kind: inferKind(rest) };
}
