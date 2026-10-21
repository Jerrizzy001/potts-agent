/**
 * Delegation task model. A task carries everything a worker may know: the
 * objective, explicitly selected inputs (file paths / excerpts / snippets
 * only — never "the whole repo" or a mailbox), permitted actions, deadline,
 * expected evidence and stop conditions. Inputs are validated so secrets,
 * credential files and owner state cannot be forwarded.
 */
import { posix } from 'node:path';
import { hashCanonical } from '../core/hash.ts';
import { redact } from '../core/log.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { matchesAny } from './glob.ts';
import { DEFAULT_WORKING_COPY_EXCLUDES, EXAMPLE_FILE_RE } from './projects.ts';

export const PERMITTED_ACTIONS = ['read_repo', 'edit_working_copy', 'run_registered_tests', 'run_registered_build', 'draft_text'] as const;
export type PermittedAction = (typeof PERMITTED_ACTIONS)[number];

export const TASK_KINDS = ['code_change', 'investigation', 'text'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskInputItem =
  | { type: 'file'; path: string; note?: string }
  | { type: 'file_excerpt'; path: string; startLine: number; endLine: number; text: string }
  | { type: 'snippet'; label: string; text: string };

export interface TaskInput {
  parentId?: string | null;
  projectId?: string | null;
  kind: TaskKind;
  objective: string;
  inputs: TaskInputItem[];
  permittedActions: PermittedAction[];
  /** UTC ISO instant. Defaults to now + defaultDeadlineMinutes. */
  deadline?: string;
  expectedEvidence: string[];
  stopConditions: string[];
}

export interface TaskSpec extends Omit<TaskInput, 'deadline' | 'parentId' | 'projectId'> {
  parentId: string | null;
  projectId: string | null;
  deadline: string;
}

/** Always appended; a task cannot remove them. */
export const MANDATORY_STOP_CONDITIONS = [
  'Stop and report instead of pushing, merging, deploying, publishing, opening pull requests or contacting anyone.',
  'Stop and report if the work needs credentials, tokens, network access beyond package installation, or files outside the working copy.',
  'Do not start, delegate to or message any other agent or service.',
  'Stop at the deadline and report what is unfinished.',
] as const;

export const MANDATORY_EVIDENCE = [
  'The change exists only as edits in the provided working copy (no commits are required; Potts computes the diff itself).',
  'List every command you ran and its exit code. Claims of passing tests are re-checked independently.',
] as const;

export const TASK_LIMITS = {
  maxObjectiveChars: 4000,
  maxInputs: 30,
  maxSnippetChars: 20_000,
  maxTotalInputChars: 100_000,
  maxListItems: 20,
  maxListItemChars: 500,
} as const;

const SECRET_TEXT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{6,}/i, /\bAKIA[0-9A-Z]{16}\b/];

/** True when a text contains something credential-shaped. */
export function containsSecret(text: string): boolean {
  return redact(text) !== text || SECRET_TEXT.some((re) => re.test(text));
}

/** Repo-relative path that stays inside the repo and is not a credential/owner-state file. */
export function validateRepoPath(p: string, extraExcludes: readonly string[] = []): string | null {
  if (typeof p !== 'string' || !p || p.length > 1000 || p.includes('\0') || p.includes('\\')) return null;
  if (p.startsWith('/') || p.startsWith('~')) return null;
  const n = posix.normalize(p);
  if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').includes('..')) return null;
  if (n === '.git' || n.startsWith('.git/') || n.includes('/.git/')) return null;
  if (!EXAMPLE_FILE_RE.test(n) && matchesAny(n, [...DEFAULT_WORKING_COPY_EXCLUDES, ...extraExcludes])) return null;
  return n;
}

const nonEmptyList = (v: unknown, name: string, required: boolean): Result<string[]> => {
  if (v === undefined && !required) return ok([]);
  if (!Array.isArray(v) || (required && v.length === 0)) return perr('invalid_input', `${name} must be a non-empty array`);
  if (v.length > TASK_LIMITS.maxListItems) return perr('invalid_input', `${name}: too many items`);
  for (const x of v) if (typeof x !== 'string' || !x.trim() || x.length > TASK_LIMITS.maxListItemChars) return perr('invalid_input', `${name}: items must be short non-empty strings`);
  if (v.some((x) => containsSecret(x as string))) return perr('invalid_input', `${name}: contains credential-shaped text`);
  return ok(v as string[]);
};

/** Validates a task input; returns the normalized spec (deadline resolved by the caller). */
export function validateTaskInput(input: unknown, opts: { now: number; defaultDeadlineMinutes: number; extraExcludes?: readonly string[] }): Result<TaskSpec> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return perr('invalid_input', 'task must be an object');
  const i = input as Record<string, unknown>;
  const allowed = new Set(['parentId', 'projectId', 'kind', 'objective', 'inputs', 'permittedActions', 'deadline', 'expectedEvidence', 'stopConditions']);
  for (const k of Object.keys(i)) if (!allowed.has(k)) return perr('invalid_input', `unknown task field "${k}"`);
  if (!TASK_KINDS.includes(i.kind as TaskKind)) return perr('invalid_input', `kind must be one of ${TASK_KINDS.join(', ')}`);
  if (typeof i.objective !== 'string' || !i.objective.trim() || i.objective.length > TASK_LIMITS.maxObjectiveChars) return perr('invalid_input', 'objective must be a non-empty string ≤ 4000 chars');
  if (containsSecret(i.objective)) return perr('invalid_input', 'objective contains credential-shaped text');
  const parentId = i.parentId ?? null;
  if (parentId !== null && (typeof parentId !== 'string' || !parentId)) return perr('invalid_input', 'parentId must be a task id');
  const projectId = i.projectId ?? null;
  if (projectId !== null && (typeof projectId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectId))) return perr('invalid_input', 'projectId must be a registered project id');
  if (!Array.isArray(i.permittedActions) || !i.permittedActions.length || !i.permittedActions.every((a) => PERMITTED_ACTIONS.includes(a as PermittedAction)))
    return perr('invalid_input', `permittedActions must be a non-empty subset of ${PERMITTED_ACTIONS.join(', ')}`);
  const permittedActions = [...new Set(i.permittedActions as PermittedAction[])].sort();
  if (i.kind !== 'text' && projectId === null) return perr('invalid_input', `${String(i.kind)} tasks need a registered projectId`);
  if (projectId === null && permittedActions.some((a) => a !== 'draft_text')) return perr('invalid_input', 'tasks without a project may only draft text');
  const ev = nonEmptyList(i.expectedEvidence, 'expectedEvidence', true);
  if (!ev.ok) return ev;
  const sc = nonEmptyList(i.stopConditions, 'stopConditions', false);
  if (!sc.ok) return sc;
  if (!Array.isArray(i.inputs) || i.inputs.length > TASK_LIMITS.maxInputs) return perr('invalid_input', `inputs must be an array of at most ${TASK_LIMITS.maxInputs}`);
  const inputs: TaskInputItem[] = [];
  let total = 0;
  for (const [n, raw] of (i.inputs as unknown[]).entries()) {
    const it = raw as Record<string, unknown>;
    if (!it || typeof it !== 'object') return perr('invalid_input', `inputs[${n}] must be an object`);
    if (it.type === 'file') {
      if (Object.keys(it).some((k) => !['type', 'path', 'note'].includes(k))) return perr('invalid_input', `inputs[${n}]: unknown field`);
      const path = validateRepoPath(it.path as string, opts.extraExcludes);
      if (!path) return perr('invalid_input', `inputs[${n}]: path is not an allowed repository-relative file`);
      if (it.note !== undefined && (typeof it.note !== 'string' || it.note.length > 500 || containsSecret(it.note))) return perr('invalid_input', `inputs[${n}]: bad note`);
      inputs.push(it.note ? { type: 'file', path, note: it.note as string } : { type: 'file', path });
    } else if (it.type === 'file_excerpt') {
      if (Object.keys(it).some((k) => !['type', 'path', 'startLine', 'endLine', 'text'].includes(k))) return perr('invalid_input', `inputs[${n}]: unknown field`);
      const path = validateRepoPath(it.path as string, opts.extraExcludes);
      if (!path) return perr('invalid_input', `inputs[${n}]: path is not an allowed repository-relative file`);
      const s = it.startLine, e = it.endLine;
      if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < 1 || (e as number) < (s as number)) return perr('invalid_input', `inputs[${n}]: bad line range`);
      if (typeof it.text !== 'string' || it.text.length > TASK_LIMITS.maxSnippetChars) return perr('invalid_input', `inputs[${n}]: text too long`);
      if (containsSecret(it.text)) return perr('invalid_input', `inputs[${n}]: excerpt contains credential-shaped text`);
      total += it.text.length;
      inputs.push({ type: 'file_excerpt', path, startLine: s as number, endLine: e as number, text: it.text });
    } else if (it.type === 'snippet') {
      if (Object.keys(it).some((k) => !['type', 'label', 'text'].includes(k))) return perr('invalid_input', `inputs[${n}]: unknown field`);
      if (typeof it.label !== 'string' || !it.label.trim() || it.label.length > 200) return perr('invalid_input', `inputs[${n}]: label required`);
      if (typeof it.text !== 'string' || it.text.length > TASK_LIMITS.maxSnippetChars) return perr('invalid_input', `inputs[${n}]: text too long`);
      if (containsSecret(it.text) || containsSecret(it.label)) return perr('invalid_input', `inputs[${n}]: snippet contains credential-shaped text`);
      total += it.text.length;
      inputs.push({ type: 'snippet', label: it.label, text: it.text });
    } else return perr('invalid_input', `inputs[${n}]: type must be file, file_excerpt or snippet`);
  }
  if (total > TASK_LIMITS.maxTotalInputChars) return perr('invalid_input', 'inputs exceed the total size limit');
  let deadline: string;
  if (i.deadline === undefined) deadline = new Date(opts.now + opts.defaultDeadlineMinutes * 60_000).toISOString();
  else {
    const t = typeof i.deadline === 'string' ? Date.parse(i.deadline) : NaN;
    if (Number.isNaN(t)) return perr('invalid_input', 'deadline must be an ISO instant');
    if (t <= opts.now) return perr('invalid_input', 'deadline is in the past');
    deadline = new Date(t).toISOString();
  }
  const stopConditions = [...sc.value, ...MANDATORY_STOP_CONDITIONS.filter((m) => !sc.value.includes(m))];
  const expectedEvidence = [...ev.value, ...MANDATORY_EVIDENCE.filter((m) => !ev.value.includes(m))];
  return ok({
    parentId: parentId as string | null, projectId: projectId as string | null, kind: i.kind as TaskKind, objective: i.objective.trim(), inputs,
    permittedActions, deadline, expectedEvidence, stopConditions,
  });
}

/** Normalized objective + project scope; equal fingerprints in one ancestry = a delegation cycle. */
export function objectiveFingerprint(spec: Pick<TaskSpec, 'objective' | 'projectId' | 'kind'>): string {
  return hashCanonical({ o: spec.objective.toLowerCase().replace(/\s+/g, ' ').trim(), p: spec.projectId, k: spec.kind });
}
