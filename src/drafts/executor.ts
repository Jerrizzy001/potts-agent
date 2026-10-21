import { ExecutorRejectedError, type Executor } from '../broker/executor.ts';
import type { DraftKind, DraftWorkspace } from './workspace.ts';
import type { HookVerdict, ActionView } from '../policy/decide.ts';

export const LOCAL_DRAFT_TASK = 'owner-local-drafts';
// Registered at trusted startup from the owner's standing permission to draft.
// This scope grants no source access, network, external send, or project execution.
export function localDraftScope(action: ActionView): HookVerdict {
  if (action.kind !== 'draft' || action.scope?.taskId !== LOCAL_DRAFT_TASK || action.accountId || action.destination.length || action.scope.projectId || action.scope.sourceIds?.length)
    return { outcome: 'hold', reasons: ['no registered task scope matches this action'] };
  return { outcome: 'allow', reasons: ['standing owner permission: save a local draft only'] };
}
const FORMATS: Record<string, DraftKind> = { email: 'email_reply', message: 'message', document: 'document', application: 'application' };
export function createLocalDraftExecutor(getWorkspace: () => DraftWorkspace | null): Executor {
  return {
    name: 'local-drafts', integration: 'drafts', kinds: ['draft'],
    async execute(intent) {
      const ws = getWorkspace();
      if (!ws) throw new ExecutorRejectedError('local draft workspace unavailable');
      const p = intent.payload as Record<string, unknown> | null;
      if (!p || Object.keys(p).some(k => !['format', 'title', 'body', 'inReplyTo', 'filename'].includes(k)) || typeof p.format !== 'string' || !Object.hasOwn(FORMATS, p.format) || typeof p.body !== 'string' || !p.body.trim() || p.body.length > 100_000 || (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 300)) || (p.filename !== undefined && (typeof p.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,149}$/.test(p.filename))) || intent.attachments.length || intent.destination.length || intent.accountId)
        throw new ExecutorRejectedError('invalid local draft payload; no paths, attachments or external destination allowed');
      const d = ws.forAction(intent.actionId) ?? ws.createLocalDraft({ kind: FORMATS[p.format]!, title: typeof p.title === 'string' ? p.title : 'Draft', body: p.body, actionId: intent.actionId, ...(typeof p.filename === 'string' ? { filename: p.filename } : {}) });
      return { providerOperationId: d.id, detail: { draftId: d.id, contentSha256: d.contentSha256 } };
    },
    async lookup(intent) {
      const ws = getWorkspace(); if (!ws) return { status: 'unknown', reason: 'draft workspace unavailable' };
      const d = ws.forAction(intent.actionId);
      return d ? { status: 'found', providerOperationId: d.id } : { status: 'not_found' };
    },
  };
}
