/**
 * Handoff brief generator. Implements the spec's handoff requirements:
 * task objective, relevant source material only, permitted scope and
 * actions, expected result and validation, stop conditions.
 *
 * The brief is built ONLY from the task spec (validated, secret-scanned
 * inputs) and the project's registered commands. It never includes the
 * owner's repo path, profile, memory, policy, other tasks or credentials.
 */
import { hashCanonical } from '../core/hash.ts';
import type { ProjectEntry } from './projects.ts';
import type { PermittedAction, TaskSpec } from './task.ts';

export interface HandoffBrief {
  taskId: string;
  /** Plain-text brief handed to the worker (or to the owner for a manual handoff). */
  text: string;
  /** Structured form of the same content. */
  json: {
    taskId: string;
    parentId: string | null;
    project: { id: string; name: string } | null;
    objective: string;
    inputs: TaskSpec['inputs'];
    permittedActions: PermittedAction[];
    allowedCommands: { id: string; command: string }[];
    deadline: string;
    expectedEvidence: string[];
    stopConditions: string[];
    resultFormat: string;
  };
  sha256: string;
}

const ACTION_TEXT: Record<PermittedAction, string> = {
  read_repo: 'Read files in the working copy (the current directory).',
  edit_working_copy: 'Edit files in the working copy only.',
  run_registered_tests: 'Run the registered test commands listed below, exactly as written.',
  run_registered_build: 'Run the registered build commands listed below, exactly as written.',
  draft_text: 'Draft text for Potts to review; nothing is sent.',
};

export const RESULT_FORMAT =
  'End your final message with one fenced ```json block: {"summary": string, "filesChanged": string[], "testsRun": [{"command": string, "exitCode": number}], "testsPassed": boolean, "unfinished": string[]}';

export function allowedCommandsFor(spec: Pick<TaskSpec, 'permittedActions'>, project: ProjectEntry | null): { id: string; argv: string[] }[] {
  if (!project) return [];
  const out: { id: string; argv: string[] }[] = [];
  if (spec.permittedActions.includes('run_registered_tests')) out.push(...project.testCommands.map((c) => ({ id: c.id, argv: [...c.argv] })));
  if (spec.permittedActions.includes('run_registered_build')) out.push(...(project.buildCommands ?? []).map((c) => ({ id: c.id, argv: [...c.argv] })));
  return out;
}

const fence = (s: string) => {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${s}\n${f}`;
};

export function buildHandoffBrief(taskId: string, spec: TaskSpec, project: ProjectEntry | null): HandoffBrief {
  const cmds = allowedCommandsFor(spec, project).map((c) => ({ id: c.id, command: c.argv.join(' ') }));
  const json: HandoffBrief['json'] = {
    taskId,
    parentId: spec.parentId,
    project: project ? { id: project.id, name: project.displayName ?? project.id } : null,
    objective: spec.objective,
    inputs: spec.inputs,
    permittedActions: spec.permittedActions,
    allowedCommands: cmds,
    deadline: spec.deadline,
    expectedEvidence: spec.expectedEvidence,
    stopConditions: spec.stopConditions,
    resultFormat: RESULT_FORMAT,
  };
  const lines: string[] = [];
  lines.push(`# Potts delegation brief — task ${taskId}`);
  if (project) lines.push(`Project: ${json.project!.name} (${project.id}). You are in an isolated working copy with no git remotes. Deadline: ${spec.deadline}.`);
  else lines.push(`Deadline: ${spec.deadline}.`);
  lines.push('', '## Task objective', spec.objective);
  lines.push('', '## Relevant source material (only these were selected; do not go looking for credentials or personal data)');
  if (!spec.inputs.length) lines.push('- None beyond the objective.');
  for (const it of spec.inputs) {
    if (it.type === 'file') lines.push(`- File: ${it.path}${it.note ? ` — ${it.note}` : ''}`);
    else if (it.type === 'file_excerpt') lines.push(`- Excerpt of ${it.path} lines ${it.startLine}-${it.endLine}:`, fence(it.text));
    else lines.push(`- ${it.label}:`, fence(it.text));
  }
  lines.push('', '## Permitted scope and actions');
  for (const a of spec.permittedActions) lines.push(`- ${ACTION_TEXT[a]}`);
  if (cmds.length) {
    lines.push('Registered commands you may run:');
    for (const c of cmds) lines.push(`- ${c.command}`);
  }
  lines.push('Anything not listed here is not permitted.');
  lines.push('', '## Expected result and validation');
  for (const e of spec.expectedEvidence) lines.push(`- ${e}`);
  lines.push('- Potts will compute the diff and run the tests itself; your report is a claim, not evidence.');
  lines.push('', '## Stop conditions');
  for (const s of spec.stopConditions) lines.push(`- ${s}`);
  lines.push('', '## Result format', RESULT_FORMAT);
  const text = lines.join('\n') + '\n';
  return { taskId, text, json, sha256: hashCanonical({ text, json }) };
}
