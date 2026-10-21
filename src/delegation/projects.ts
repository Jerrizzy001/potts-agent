/**
 * Project registry: maps an approved URL to its repository, test/build
 * commands, deployment targets, release script and CI trigger notes. Only
 * explicitly registered projects can be delegated or released; a URL that is
 * not registered resolves to nothing (never "closest match").
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadSchema } from '../core/config.ts';
import { hashCanonical } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import { validateSchema } from '../core/schema.ts';
import { isSecretRef } from '../core/secrets.ts';

export interface CommandSpec {
  id: string;
  argv: string[];
  timeoutSeconds?: number;
  description?: string;
  /** Release commands only: `pre` runs before anything is deployed, `release` deploys. */
  phase?: 'pre' | 'release';
}

export type DeployCheck =
  | { type: 'http'; url: string; expectStatus?: number; expectJson?: Record<string, unknown>; bodyIncludes?: string; timeoutSeconds?: number; description?: string }
  | { type: 'http_header'; url: string; header: string; timeoutSeconds?: number; description?: string }
  | { type: 'http_json'; url: string; field: string; timeoutSeconds?: number; description?: string }
  | { type: 'command'; argv: string[]; timeoutSeconds?: number; description?: string };

export interface DeploymentTarget {
  id: string;
  kind: 'cloudflare_workers' | 'static_site' | 'other';
  url: string;
  /** Branch whose head must equal the released commit (e.g. main). */
  sourceBranch: string;
  workers?: string[];
  description?: string;
  identityChecks?: DeployCheck[];
  liveChecks?: DeployCheck[];
}

export interface CiTrigger {
  event: 'push' | 'pull_request' | 'pull_request_target' | 'workflow_dispatch' | 'schedule' | 'release' | 'tag';
  branches?: string[];
  tags?: string[];
}

export interface CiWorkflow {
  file: string;
  name?: string;
  triggers: CiTrigger[];
  deploys: boolean;
  usesSecrets?: boolean;
  notes?: string;
}

export interface ReleaseCheck {
  id: string;
  description?: string;
  pathPatterns: string[];
  commands: CommandSpec[];
  runbook?: string;
}

export interface ProjectRelease {
  enabled: boolean;
  commands: CommandSpec[];
  /** NAME → secret reference, resolved only inside the release executor. */
  credentialEnv?: Record<string, string>;
  envAllowlist?: string[];
  env?: Record<string, string>;
  allowSshAgent?: boolean;
  notes?: string;
}

export interface ProjectEntry {
  id: string;
  displayName?: string;
  urls: string[];
  repoPath: string;
  remoteUrl: string;
  defaultBranch: string;
  setupCommands?: CommandSpec[];
  testCommands: CommandSpec[];
  buildCommands?: CommandSpec[];
  releaseChecks?: ReleaseCheck[];
  deploymentTargets?: DeploymentTarget[];
  release?: ProjectRelease;
  ci: { provider: 'github_actions' | 'none'; workflows: CiWorkflow[]; workflowPathPatterns?: string[]; notes?: string };
  worker: { envAllowlist: string[]; env?: Record<string, string>; setupNetwork?: string[]; testNetwork?: string[] };
  workingCopy?: { excludePatterns?: string[] };
  notes?: string;
}

export interface ProjectsDocument {
  schemaVersion: 1;
  projects: ProjectEntry[];
}

export interface ProjectRegistry {
  get(id: string): ProjectEntry | undefined;
  /** Exact origin match against a registered URL; unregistered URLs resolve to undefined. */
  resolveUrl(url: string): ProjectEntry | undefined;
  list(): readonly ProjectEntry[];
  target(projectId: string, targetId: string): DeploymentTarget | undefined;
  /** Hash of a target's full descriptor; bound into deploy approvals. */
  targetHash(projectId: string, targetId: string): string | undefined;
}

/** Default exclusions for worker working copies (never copied/present). */
export const DEFAULT_WORKING_COPY_EXCLUDES = ['output/**', '**/.env', '**/.env.*', '**/.dev.vars', '**/.dev.vars.*', '**/*.pem', '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc'];
/** Example files that are safe even though they match a secret-like pattern. */
export const EXAMPLE_FILE_RE = /\.example$|\.sample$|\.template$/;

export function normalizeOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return `https://${u.host.toLowerCase()}`;
}

function semantic(doc: ProjectsDocument): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const origins = new Map<string, string>();
  for (const p of doc.projects) {
    if (ids.has(p.id)) issues.push(`duplicate project id ${p.id}`);
    ids.add(p.id);
    if (!isAbsolute(p.repoPath)) issues.push(`${p.id}: repoPath must be absolute`);
    for (const url of p.urls) {
      const o = normalizeOrigin(url);
      if (!o) issues.push(`${p.id}: url ${url} must be https without credentials`);
      else if (origins.has(o) && origins.get(o) !== p.id) issues.push(`${p.id}: url ${url} already registered by ${origins.get(o)}`);
      else origins.set(o, p.id);
    }
    const tids = new Set<string>();
    for (const t of p.deploymentTargets ?? []) {
      if (tids.has(t.id)) issues.push(`${p.id}: duplicate target ${t.id}`);
      tids.add(t.id);
      for (const c of [...(t.identityChecks ?? []), ...(t.liveChecks ?? [])]) {
        if (c.type === 'command' && !('argv' in c && c.argv)) issues.push(`${p.id}/${t.id}: command check needs argv`);
        if (c.type !== 'command' && !('url' in c && c.url)) issues.push(`${p.id}/${t.id}: ${c.type} check needs url`);
        if (c.type === 'http_header' && !c.header) issues.push(`${p.id}/${t.id}: http_header check needs header`);
        if (c.type === 'http_json' && !c.field) issues.push(`${p.id}/${t.id}: http_json check needs field`);
      }
    }
    for (const [k, v] of Object.entries(p.release?.credentialEnv ?? {})) if (!isSecretRef(v)) issues.push(`${p.id}: release.credentialEnv.${k} must be a secret reference`);
    for (const k of Object.keys(p.worker.env ?? {})) if (/token|secret|passw|api[-_]?key|credential|auth/i.test(k)) issues.push(`${p.id}: worker.env.${k} looks like a credential; workers get none`);
    const cmdIds = new Set<string>();
    for (const c of [...(p.setupCommands ?? []), ...p.testCommands, ...(p.buildCommands ?? [])]) {
      if (cmdIds.has(c.id)) issues.push(`${p.id}: duplicate command id ${c.id}`);
      cmdIds.add(c.id);
    }
    if (p.release?.enabled && !(p.release.commands ?? []).some((c) => c.phase === 'release')) issues.push(`${p.id}: enabled release needs a command with phase "release"`);
  }
  return issues;
}

export function validateProjectsDocument(raw: unknown): Result<ProjectsDocument> {
  const schema = loadSchema();
  const issues = validateSchema(raw, { $ref: '#/$defs/projectsDocument' }, schema).map((i) => `${i.path} ${i.message}`);
  if (issues.length) return perr('config_invalid', `projects invalid: ${issues.join('; ')}`, { issues });
  const doc = raw as ProjectsDocument;
  const sem = semantic(doc);
  if (sem.length) return perr('config_invalid', `projects invalid: ${sem.join('; ')}`, { issues: sem });
  return ok(doc);
}

export function loadProjectsFile(path: string): Result<ProjectRegistry> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return perr('config_invalid', `cannot read projects file ${path}: ${(e as Error).message}`);
  }
  const v = validateProjectsDocument(raw);
  return v.ok ? ok(createProjectRegistry(v.value)) : v;
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

export function createProjectRegistry(doc: ProjectsDocument): ProjectRegistry {
  const projects = (structuredClone(doc.projects) as ProjectEntry[]).map((p) => deepFreeze(p));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byOrigin = new Map<string, ProjectEntry>();
  for (const p of projects) for (const u of p.urls) {
    const o = normalizeOrigin(u);
    if (o) byOrigin.set(o, p);
  }
  const target = (pid: string, tid: string) => byId.get(pid)?.deploymentTargets?.find((t) => t.id === tid);
  return {
    get: (id) => byId.get(id),
    resolveUrl(url) {
      const o = normalizeOrigin(url);
      return o ? byOrigin.get(o) : undefined;
    },
    list: () => projects,
    target,
    targetHash(pid, tid) {
      const t = target(pid, tid);
      const p = byId.get(pid);
      return t && p ? hashCanonical({ projectId: pid, remoteUrl: p.remoteUrl, target: t }) : undefined;
    },
  };
}
