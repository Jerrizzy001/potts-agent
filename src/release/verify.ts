/**
 * Post-deploy verification: (1) deployed identity — the live system reports
 * the exact released commit (version endpoint, commit header, or a read-only
 * command such as the repo's deploy-drift check); (2) live behaviour checks.
 * A green liveness endpoint alone never passes verification: at least one
 * identity check is required.
 */
import type { DeployCheck, DeploymentTarget } from '../delegation/projects.ts';
import { outputTail, type RunResult, type RunSpec } from '../delegation/runner.ts';

export interface CheckResult {
  type: DeployCheck['type'];
  target: string;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  identity: CheckResult[];
  live: CheckResult[];
  notes: string[];
}

export interface VerifyContext {
  sha: string;
  /** Directory commands run in (the release executor's clean checkout). */
  cwd: string;
  env: Record<string, string>;
  fetch?: typeof fetch;
  run: (spec: RunSpec) => Promise<RunResult>;
}

/** True when `value` names the commit: the full SHA, or a ≥7-char prefix of it. */
export function namesCommit(value: string, sha: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.includes(sha)) return true;
  const tok = v.match(/[0-9a-f]{7,40}/g) ?? [];
  return tok.some((t) => sha.startsWith(t));
}

const subst = (argv: readonly string[], sha: string) => argv.map((a) => a.split('{sha}').join(sha));

function deepIncludes(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return JSON.stringify(actual) === JSON.stringify(expected);
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => deepIncludes((actual as Record<string, unknown>)[k], v));
}

function field(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export async function runCheck(c: DeployCheck, ctx: VerifyContext): Promise<CheckResult> {
  const f = ctx.fetch ?? fetch;
  const timeoutMs = (c.timeoutSeconds ?? 15) * 1000;
  try {
    if (c.type === 'command') {
      const argv = subst(c.argv, ctx.sha);
      const r = await ctx.run({ argv, cwd: ctx.cwd, env: ctx.env, network: { mode: 'allowlist', hosts: ['*'] }, timeoutMs, label: 'verify' });
      const ok = r.exitCode === 0 && !r.timedOut;
      return { type: c.type, target: argv.join(' '), ok, detail: ok ? 'exit 0' : `exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}: ${outputTail(r.stdout + r.stderr, 600)}` };
    }
    const res = await f(c.url, { method: 'GET', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
    if (c.type === 'http_header') {
      const v = res.headers.get(c.header) ?? '';
      return { type: c.type, target: `${c.url} [${c.header}]`, ok: !!v && namesCommit(v, ctx.sha), detail: v ? `header=${v.slice(0, 80)}` : 'header missing' };
    }
    if (c.type === 'http_json') {
      const j = (await res.json()) as unknown;
      const v = field(j, c.field);
      return { type: c.type, target: `${c.url} .${c.field}`, ok: typeof v === 'string' && namesCommit(v, ctx.sha), detail: `value=${String(v).slice(0, 80)}` };
    }
    const want = c.expectStatus ?? 200;
    if (res.status !== want) return { type: c.type, target: c.url, ok: false, detail: `HTTP ${res.status}, expected ${want}` };
    if (c.expectJson || c.bodyIncludes) {
      const text = await res.text();
      if (c.bodyIncludes && !text.includes(c.bodyIncludes)) return { type: c.type, target: c.url, ok: false, detail: 'expected text missing' };
      if (c.expectJson) {
        let j: unknown;
        try {
          j = JSON.parse(text);
        } catch {
          return { type: c.type, target: c.url, ok: false, detail: 'response is not JSON' };
        }
        if (!deepIncludes(j, c.expectJson)) return { type: c.type, target: c.url, ok: false, detail: 'JSON does not match the expected fields' };
      }
    }
    return { type: c.type, target: c.url, ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { type: c.type, target: c.type === 'command' ? c.argv.join(' ') : c.url, ok: false, detail: `error: ${(e as Error).message}` };
  }
}

export async function verifyDeployment(target: DeploymentTarget, ctx: VerifyContext): Promise<VerificationResult> {
  const notes: string[] = [];
  const identity: CheckResult[] = [];
  for (const c of target.identityChecks ?? []) identity.push(await runCheck(c, ctx));
  const live: CheckResult[] = [];
  for (const c of target.liveChecks ?? []) live.push(await runCheck(c, ctx));
  if (!identity.length) notes.push('No deployed-identity check is configured; a healthy endpoint does not prove the approved commit is live.');
  if (live.some((l) => /\/api\/health/.test(l.target))) notes.push('/api/health is liveness only (database, workers, job boards and email are not checked).');
  const ok = identity.length > 0 && identity.every((x) => x.ok) && live.every((x) => x.ok);
  return { ok, identity, live, notes };
}
