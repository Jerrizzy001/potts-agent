/**
 * External (the owner's OpenAI dot) adapter. Phase 0 found no supported
 * programmatic Potts → External route, so the adapter only produces an
 * owner-reviewed MANUAL brief: Potts shows it to the owner, who decides
 * whether to paste it into External. Nothing here automates a chat UI,
 * impersonates the owner, or messages a bot.
 *
 * A future verified route can be plugged in through `VerifiedExternalRoute`, but
 * it is used only when it carries verification evidence AND config sets
 * mode 'verified_route'. Until then every handoff is manual.
 */
import type { HandoffBrief } from './brief.ts';

export interface VerifiedExternalRoute {
  /** Where/when the route was verified (doc link, test run id). Required. */
  verification: { verifiedAt: string; evidence: string };
  submit(brief: HandoffBrief): Promise<{ handoffId: string }>;
}

export type ExternalHandoff =
  | { mode: 'manual'; taskId: string; briefText: string; briefSha256: string; ownerInstructions: string[]; automated: false }
  | { mode: 'verified_route'; taskId: string; handoffId: string; briefSha256: string; automated: true };

export interface ExternalAdapter {
  readonly mode: 'manual' | 'verified_route';
  handoff(brief: HandoffBrief): Promise<ExternalHandoff>;
}

export const EXTERNAL_OWNER_INSTRUCTIONS = [
  'Review the brief below. It contains only the inputs selected for this task.',
  'If you want External to do it, paste the brief into External yourself. Potts does not contact External.',
  'External\'s answer is a claim: send the result back to Potts for independent checks before anything is merged, deployed or sent.',
  'Approval rules still apply: nothing External produces is sent, merged, deployed or purchased without your separate approval.',
];

export function createExternalAdapter(o: { mode?: 'manual' | 'verified_route'; route?: VerifiedExternalRoute | null } = {}): ExternalAdapter {
  const route = o.route ?? null;
  const verified = o.mode === 'verified_route' && route !== null && !!route.verification?.verifiedAt && !!route.verification?.evidence;
  return {
    mode: verified ? 'verified_route' : 'manual',
    async handoff(brief) {
      if (verified) {
        const r = await route!.submit(brief);
        return { mode: 'verified_route', taskId: brief.taskId, handoffId: r.handoffId, briefSha256: brief.sha256, automated: true };
      }
      return { mode: 'manual', taskId: brief.taskId, briefText: brief.text, briefSha256: brief.sha256, ownerInstructions: [...EXTERNAL_OWNER_INSTRUCTIONS], automated: false };
    },
  };
}
