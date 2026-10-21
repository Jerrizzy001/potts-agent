/**
 * Support engine: inbound customer message → classification → draft →
 * (only outside shadow mode) a broker proposal.
 *
 *   shadow (default) / channel disabled: the draft and its citations are
 *     stored; NOTHING is proposed, so nothing can be sent.
 *   automatic channel: a `support_reply` is proposed. requiresOwner is false
 *     only when EVERY condition holds — support enabled, channel registered +
 *     enabled + mode automatic, category customer_support with no protected
 *     reason, confidence >= threshold, verbatim composer citing >= 1 item, all
 *     cited items approved in the owner policy and not stale, policy
 *     support.mode active and the channel's account in registeredChannels.
 *     The broker's decide() re-checks the policy side independently; anything
 *     else becomes an owner approval request.
 *   personal business opportunity: proposed as `send_message` (always owner
 *     approval), never as a support reply.
 *
 * The engine never calls execute(); the daemon executes "ready" actions.
 */
import type { Db } from '../store/db.ts';
import type { Clock } from '../core/clock.ts';
import { newId } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/hash.ts';
import { ok, perr, type Result } from '../core/result.ts';
import type { LoadedPolicy } from '../policy/document.ts';
import type { ProposeOutcome } from '../broker/broker.ts';
import { isEmailAddress, type ReplyContext } from '../connectors/writers/writer-payload.ts';
import type { SupportRegistry } from './registry.ts';
import type { KnowledgeBase } from './knowledge.ts';
import { classifyWithExtra, type Classification, type ExtraClassifier } from './classifier.ts';
import { composeReply, type ComposedReply } from './composer.ts';

export interface InboundSupportMessage {
  channelId: string;
  /** Provider message id (dedupe key within the channel). */
  messageId: string;
  /** Customer address (email for support_email). Untrusted. */
  from: string;
  subject?: string;
  text: string;
  receivedAt: string;
  /** Threading info for email replies. */
  reply?: ReplyContext;
}

export type SupportDisposition = 'shadow_draft' | 'channel_disabled' | 'proposed_automatic' | 'proposed_for_approval' | 'proposal_rejected' | 'no_reply';

export interface SupportOutcome {
  draftId: string;
  duplicate: boolean;
  classification: Classification;
  effectiveMode: 'shadow' | 'automatic';
  automaticEligible: boolean;
  eligibilityReasons: string[];
  disposition: SupportDisposition;
  actionId: string | null;
  actionKind: 'support_reply' | 'send_message' | null;
  decision: string | null;
  reply: { subject: string | null; body: string | null; knowledgeIds: string[] };
}

export interface SupportEngineOptions {
  db: Db;
  clock: Clock;
  registry: SupportRegistry;
  kb: () => KnowledgeBase;
  policy: () => LoadedPolicy;
  broker: { propose(input: unknown, actor: string): Result<ProposeOutcome> };
  extraClassifier?: ExtraClassifier;
}

export interface SupportEngine {
  handleInbound(msg: InboundSupportMessage): Promise<Result<SupportOutcome>>;
  get(draftId: string): SupportDraftRecord | undefined;
  list(opts?: { disposition?: SupportDisposition; limit?: number }): SupportDraftRecord[];
}

export interface SupportDraftRecord {
  id: string;
  channelId: string;
  app: string;
  inboundMessageId: string;
  customerAddress: string;
  category: string;
  confidence: number;
  protectedReasons: string[];
  replySubject: string | null;
  replyText: string | null;
  knowledgeIds: string[];
  knowledgeHashes: Record<string, string>;
  kbVersion: string;
  effectiveMode: 'shadow' | 'automatic';
  disposition: SupportDisposition;
  actionId: string | null;
  decision: string | null;
  createdAt: string;
}

type Row = Record<string, string | number | null>;
const toRecord = (r: Row): SupportDraftRecord => ({
  id: String(r.id), channelId: String(r.channel_id), app: String(r.app), inboundMessageId: String(r.inbound_message_id), customerAddress: String(r.customer_address),
  category: String(r.category), confidence: Number(r.confidence), protectedReasons: JSON.parse(String(r.protected_reasons_json)) as string[],
  replySubject: r.reply_subject === null ? null : String(r.reply_subject), replyText: r.reply_text === null ? null : String(r.reply_text),
  knowledgeIds: JSON.parse(String(r.knowledge_ids_json)) as string[], knowledgeHashes: JSON.parse(String(r.knowledge_hashes_json)) as Record<string, string>,
  kbVersion: String(r.kb_version), effectiveMode: r.effective_mode as 'shadow' | 'automatic', disposition: r.disposition as SupportDisposition,
  actionId: r.action_id === null ? null : String(r.action_id), decision: r.decision === null ? null : String(r.decision), createdAt: String(r.created_at),
});

const MAX_INBOUND = 50_000;

export function createSupportEngine(o: SupportEngineOptions): SupportEngine {
  const { db, clock, registry } = o;
  const existing = (channelId: string, messageId: string) =>
    db.prepare('SELECT * FROM support_drafts WHERE channel_id = ? AND inbound_message_id = ?').get(channelId, messageId) as Row | undefined;

  const eligibility = (c: Classification, reply: ComposedReply, accountId: string | undefined, policy: LoadedPolicy): string[] => {
    const why: string[] = [];
    if (c.category !== 'customer_support') why.push(`category is ${c.category}`);
    if (c.protectedReasons.length) why.push(`protected: ${c.protectedReasons.join(', ')}`);
    if (c.confidence < registry.config.confidenceThreshold) why.push(`confidence ${c.confidence.toFixed(2)} below ${registry.config.confidenceThreshold}`);
    if (reply.composer !== 'verbatim') why.push(`composer ${reply.composer} is not verbatim approved knowledge`);
    if (!reply.cited.length) why.push('no approved knowledge matched');
    const unapproved = reply.cited.filter((k) => !policy.doc.support.approvedKnowledgeIds.includes(k.id)).map((k) => k.id);
    if (unapproved.length) why.push(`knowledge not approved in policy: ${unapproved.join(', ')}`);
    if (reply.staleStatus.length) why.push(`status knowledge is stale: ${reply.staleStatus.join(', ')}`);
    if (policy.doc.support.mode !== 'active') why.push('owner policy support.mode is shadow');
    if (!accountId || !policy.doc.support.registeredChannels.includes(accountId)) why.push('channel account not in policy registeredChannels');
    return why;
  };

  return {
    async handleInbound(msg) {
      const channel = registry.channel(msg.channelId);
      if (!channel) return perr('not_found', `support channel ${msg.channelId} is not registered; message ignored`);
      const app = registry.app(channel.app)!;
      if (typeof msg.messageId !== 'string' || !msg.messageId || msg.messageId.length > 512) return perr('invalid_input', 'messageId required');
      if (typeof msg.text !== 'string' || msg.text.length > MAX_INBOUND) return perr('invalid_input', 'inbound text missing or too long');
      if (typeof msg.from !== 'string' || !msg.from || msg.from.length > 320) return perr('invalid_input', 'from required');
      const prior = existing(channel.id, msg.messageId);
      if (prior) {
        const r = toRecord(prior);
        const c = { category: r.category, confidence: r.confidence, protectedReasons: r.protectedReasons, supportSignals: [], businessSignals: [] } as Classification;
        return ok({ draftId: r.id, duplicate: true, classification: c, effectiveMode: r.effectiveMode, automaticEligible: false, eligibilityReasons: ['duplicate inbound message'], disposition: r.disposition, actionId: r.actionId, actionKind: null, decision: r.decision, reply: { subject: r.replySubject, body: r.replyText, knowledgeIds: r.knowledgeIds } });
      }

      const kb = o.kb();
      const policy = o.policy();
      const classification = await classifyWithExtra({ ...(msg.subject ? { subject: msg.subject } : {}), text: msg.text }, o.extraClassifier);
      const reply = composeReply({
        kb, app, classification, text: msg.text, ...(msg.subject ? { subject: msg.subject } : {}), ...(channel.signature ? { signature: channel.signature } : {}),
        now: clock.now(), maxStatusAgeHours: registry.config.maxStatusAgeHours ?? 24,
      });
      const active = registry.config.enabled && channel.enabled;
      const effectiveMode: 'shadow' | 'automatic' = active && channel.mode === 'automatic' ? 'automatic' : 'shadow';
      const reasons = eligibility(classification, reply, channel.accountId, policy);
      const automaticEligible = effectiveMode === 'automatic' && reasons.length === 0;

      const draftId = newId('sdr', clock);
      let disposition: SupportDisposition = !active ? 'channel_disabled' : effectiveMode === 'shadow' ? 'shadow_draft' : reply.body ? 'proposed_for_approval' : 'no_reply';
      let actionId: string | null = null;
      let actionKind: SupportOutcome['actionKind'] = null;
      let decision: string | null = null;

      if (effectiveMode === 'automatic' && reply.body) {
        if (!isEmailAddress(msg.from)) {
          disposition = 'proposal_rejected';
          reasons.push('customer address is not a plain email address');
        } else {
          const knowledgeIds = reply.cited.map((k) => k.id);
          const isBusiness = classification.category === 'personal_business_opportunity';
          actionKind = isBusiness ? 'send_message' : 'support_reply';
          const payload: Record<string, unknown> = { channel: 'email', to: [msg.from], subject: reply.subject ?? 'Re: your message', body: reply.body };
          if (msg.reply) payload.reply = msg.reply;
          if (!isBusiness) {
            Object.assign(payload, {
              classification: classification.category === 'customer_support' && !classification.protectedReasons.length ? 'customer_support' : classification.category,
              knowledgeIds, requiresOwner: !automaticEligible, kbVersion: kb.version, supportDraftId: draftId,
            });
          }
          const summary = isBusiness
            ? `Possible personal business opportunity received on support channel ${channel.id}; reply needs owner approval.`
            : `Support reply (${classification.category}, confidence ${classification.confidence.toFixed(2)})${reasons.length ? `; owner review because: ${reasons.join('; ')}` : ''}`;
          const p = o.broker.propose({ kind: actionKind, accountId: channel.accountId, destination: [msg.from], payload, summary: summary.slice(0, 1900) }, `support:${channel.id}`);
          if (p.ok) {
            actionId = p.value.actionId;
            decision = p.value.decision;
            disposition = p.value.decision === 'allow' ? 'proposed_automatic' : 'proposed_for_approval';
          } else {
            disposition = 'proposal_rejected';
            reasons.push(`broker refused proposal: ${p.error.message}`);
          }
        }
      }

      const knowledgeHashes = Object.fromEntries(reply.cited.map((k) => [k.id, k.sha256]));
      db.prepare(
        `INSERT INTO support_drafts (id, channel_id, app, inbound_message_id, customer_address, inbound_subject, inbound_text, inbound_hash, received_at, category, confidence,
          protected_reasons_json, signals_json, reply_subject, reply_text, composer, knowledge_ids_json, knowledge_hashes_json, kb_version, effective_mode,
          automatic_eligible, eligibility_reasons_json, disposition, action_id, action_kind, decision, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        draftId, channel.id, app.id, msg.messageId, msg.from, msg.subject ?? null, msg.text, sha256Hex(msg.text), msg.receivedAt, classification.category, classification.confidence,
        canonicalJson(classification.protectedReasons), canonicalJson({ support: classification.supportSignals, business: classification.businessSignals }),
        reply.subject, reply.body, reply.composer, canonicalJson(reply.cited.map((k) => k.id)), canonicalJson(knowledgeHashes), kb.version, effectiveMode,
        automaticEligible ? 1 : 0, canonicalJson(reasons), disposition, actionId, actionKind, decision, clock.nowIso(),
      );
      return ok({
        draftId, duplicate: false, classification, effectiveMode, automaticEligible, eligibilityReasons: reasons, disposition, actionId, actionKind, decision,
        reply: { subject: reply.subject, body: reply.body, knowledgeIds: reply.cited.map((k) => k.id) },
      });
    },
    get(id) {
      const r = db.prepare('SELECT * FROM support_drafts WHERE id = ?').get(id) as Row | undefined;
      return r ? toRecord(r) : undefined;
    },
    list(opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
      const rows = (opts.disposition
        ? db.prepare('SELECT * FROM support_drafts WHERE disposition = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(opts.disposition, limit)
        : db.prepare('SELECT * FROM support_drafts ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)) as Row[];
      return rows.map(toRecord);
    },
  };
}
