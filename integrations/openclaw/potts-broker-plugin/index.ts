/**
 * Potts broker plugin for OpenClaw (WP-2).
 *
 *  - Agent tools: potts_propose_action / potts_action_status / potts_list_actions
 *    → broker proposer socket only (no approve/execute exists anywhere here).
 *  - Owner commands (bypass the LLM): /potts, /pstatus, /pause, /resume,
 *    /approvals, /papprove, /deny, /cancel, /revoke, /forget
 *    → owner checks → signed proof → authenticated ingress socket.
 *  - Telegram approval buttons: interactive namespace "potts".
 *
 * Self-contained: imports only node built-ins and ./lib. Install ONLY via the
 * scripts in integrations/openclaw/ (test profile first). See README.md.
 */
import { createSecretsProvider, parsePluginConfig } from './lib/config.ts';
import { createReplayCache, type CallbackContextLike, type CommandContextLike } from './lib/guard.ts';
import { COMMAND_ALIASES, createOwnerHandlers, type OwnerReply } from './lib/owner.ts';
import { CALLBACK_NAMESPACE } from './lib/nonce.ts';
import { createEnvironmentTool } from './lib/environment.ts';
import { createAgentTools } from './lib/tools.ts';
import { createGatewayTelegramDeliver, startOwnerChannelServer } from './lib/owner-channel.ts';
import { createOwnerMediaTools } from './lib/owner-media.ts';
import { createOwnerReminderTools } from './lib/owner-reminders.ts';
import { createClaudeTools } from './lib/claude-task.ts';
import { parseClaudeArgs } from './lib/claude-command.ts';
import { checkOwnerCommand } from './lib/guard.ts';
import { createWorkerTools, SOL_WORKER_PROMPT, SOL_WORKER_TOOLS } from './lib/worker-task.ts';
import { join } from 'node:path';
import { createLearning, type LearningContext } from './lib/learning.ts';
import { createOwnerReactions, canUseOwnerReactions, type ReactionContext, type Reaction } from './lib/owner-reactions.ts';
import { createImsgReactionAdapter } from './lib/imsg-reactions.ts';
import { coordinatorPrompt } from './lib/worker-policy.ts';

/** The subset of the OpenClaw plugin API this plugin uses (OpenClaw 2026.9.8). */
export interface PluginApiLike {
  on?(name: string, handler: (event: unknown, ctx: { agentId?: string; sessionKey?: string; senderId?: string; channel?: string; [key: string]: unknown }) => unknown, options?: unknown): void;
  pluginConfig?: Record<string, unknown>;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  registerTool(tool: unknown, opts?: unknown): void;
  registerCommand(def: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    channels?: readonly string[];
    handler: (ctx: CommandContextLike) => Promise<OwnerReply & { suppressReply?: boolean }>;
  }): void;
  config?: unknown;
  runtime?: unknown;
  registerService?(service: { id: string; start: (ctx: unknown) => void | Promise<void>; stop?: (ctx: unknown) => void | Promise<void> }): void;
  registerInteractiveHandler?(registration: { channel: string; namespace: string; handler: (ctx: CallbackContextLike & TelegramRespond) => Promise<{ handled?: boolean } | void> }): void;
}

interface TelegramRespond {
  respond?: {
    reply(params: { text: string }): Promise<void>;
    clearButtons(): Promise<void>;
  };
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  potts: 'Potts owner controls (status, pause, resume, approvals, approve, deny, cancel, revoke, forget, testcall)',
  pstatus: 'Potts status: controls, pending approvals, recent actions',
  pause: 'Pause all Potts actions, or one integration',
  resume: 'Resume Potts actions, or one integration',
  approvals: 'List pending Potts approvals',
  papprove: 'Review and approve one Potts approval',
  deny: 'Deny a Potts approval',
  cancel: 'Cancel a Potts approval or action',
  revoke: 'Revoke a Potts account',
  forget: 'Forget a Potts memory item',
};

const plugin = {
  id: 'potts-broker',
  name: 'Potts broker',
  description: 'Typed broker tools for the Potts agent, plus LLM-free owner controls and approval buttons.',
  register(api: PluginApiLike) {
    const parsed = parsePluginConfig(api.pluginConfig ?? {});
    if (!parsed.ok) {
      api.logger.error(`potts-broker: invalid plugin config: ${parsed.error}`);
      return;
    }
    const cfg = parsed.value;
    const secrets = createSecretsProvider(cfg);
    const learning = cfg.learningEnabled ? createLearning({ home: cfg.pottsHome, directory: cfg.learningDirectory!, coordinatorId: cfg.coordinatorAgentId, channel: cfg.deliveryChannel ?? 'telegram', ownerId: async () => (await secrets.get())?.ownerId ?? null }) : null;
    let learningFailure = false;
    if (learning) {
      api.on?.('inbound_claim', async (event, ctx) => {
        try { await learning.capture(event as Record<string,unknown>, ctx); learningFailure=false; }
        catch { learningFailure=true; api.logger.warn('Local learning capture failed; no save confirmation is available.'); }
      });
      api.on?.('reply_dispatch', async (event) => {
        try { await learning.captureDispatch(event as Record<string,unknown>); learningFailure=false; }
        catch { learningFailure=true; api.logger.warn('Local learning capture failed; no save confirmation is available.'); }
        // Observe only: the host continues the normal agent reply.
      });
      if(cfg.agentTools) api.registerTool((ctx: LearningContext) => learning.tools(ctx), { names: ['potts_learning'] });
      let timer: ReturnType<typeof setInterval> | undefined;
      api.registerService?.({id:'potts-learning',start:()=>{
        const tick=()=>{try{learning.syncJobs();learning.reviewDaily();}catch{api.logger.warn('Local learning review failed.');}};
        tick(); timer=setInterval(tick,60_000);timer.unref();
      },stop:()=>{if(timer)clearInterval(timer);learning.close();}});
    }
    if (cfg.agentTools && cfg.deliveryChannel === 'imessage') {
      let reactions: ReturnType<typeof createOwnerReactions> | undefined;
      api.registerTool((ctx: ReactionContext) => {
        if (!cfg.deliveryTarget || !canUseOwnerReactions(ctx,cfg.deliveryTarget)) return null;
        return { name:'potts_react', catalogMode:'direct-only', description:'Add or remove one native reaction on the exact owner message in this conversation. Successful reaction can be the entire acknowledgement. Never guess a target or retry uncertainty.',
          parameters:{type:'object',additionalProperties:false,required:['messageId','reaction','present'],properties:{messageId:{type:'string'},reaction:{enum:['love','like','dislike','laugh','emphasize','question']},present:{type:'boolean'}}},
          async execute(_id:string,p:Record<string,unknown>){
            const host=api.config as {channels?:{imessage?:{cliPath?:string}}}|undefined;
            const cliPath=host?.channels?.imessage?.cliPath;
            if(!cliPath)return {content:[{type:'text',text:'Exact-message reactions are not connected yet.'}],details:{ok:false,status:'unavailable'}};
            reactions ??= createOwnerReactions(join(cfg.pottsHome,'reactions.sqlite'),createImsgReactionAdapter({cliPath,ownerId:cfg.deliveryTarget!}));
            const r=await reactions.set(ctx,cfg.deliveryTarget!,{conversationId:ctx.nativeChannelId!,messageId:String(p.messageId??''),reaction:p.reaction as Reaction},p.present as boolean);
            return {content:[{type:'text',text:r.message}],details:{...r,ok:r.status==='applied'||r.status==='unchanged'}};
          }};
      },{names:['potts_react']});
      api.registerService?.({id:'potts-reactions',start:()=>{},stop:()=>{reactions?.close();reactions=undefined;}});
    }
    if (cfg.coordinatorEnabled) api.on?.('before_prompt_build', (_event, ctx) => {
      if (/^agent:main:potts-worker-sol_[0-9]{14}_[0-9a-f]{8}$/.test(ctx.sessionKey ?? '')) {
        // Native Codex MCP is suppressed by a finite toolsAllow override. Native
        // runs use the configured Codex dynamic-tool exclusions and core deny policy.
        const hostConfig = api.config as {
          agents?: { defaults?: { models?: Record<string, { agentRuntime?: { id?: string } }> } };
          plugins?: { entries?: { codex?: { config?: { codexDynamicToolsExclude?: string[] } } } };
        } | undefined;
        const nativeCodex = hostConfig?.agents?.defaults?.models?.['openai/gpt-6.1-sol']?.agentRuntime?.id === 'codex';
        const excluded = new Set(hostConfig?.plugins?.entries?.codex?.config?.codexDynamicToolsExclude ?? []);
        const workerRestrictionsPresent = ['message', 'cron', 'automations', 'sessions_spawn', 'subagents', 'potts_delegate', 'potts_claude', 'potts_send_file', 'potts_send_voice', 'potts_send_screenshot', 'potts_reminder', 'potts_worker_control', 'potts_learning', 'potts_react'].every(name => excluded.has(name));
        return nativeCodex && workerRestrictionsPresent ? { systemPrompt: SOL_WORKER_PROMPT } : { systemPrompt: SOL_WORKER_PROMPT, toolsAllow: [...SOL_WORKER_TOOLS] };
      }
      const base=coordinatorPrompt(ctx.agentId, cfg.coordinatorAgentId);
      if(!base||!learning)return base;
      return secrets.get().then(owner=>{
        if(!owner||ctx.senderId!==owner.ownerId||ctx.channel!==cfg.deliveryChannel)return base;
        try { return {...base,appendContext:learningFailure?'Local learning could not save this request. Do not claim it was remembered.':learning.context(String((_event as {currentUserMessage?:string;prompt?:string}).currentUserMessage??(_event as {prompt?:string}).prompt??''),ctx.sessionKey??'')}; }
        catch{return {...base,appendContext:'Local learning is unavailable. Do not claim that anything was saved.'};}
      });
    });
    const log = (event: string, data: Record<string, unknown>) => api.logger.info(`potts-broker: ${event}`, data);

    if (cfg.agentTools) {
      for (const t of createAgentTools(cfg)) api.registerTool(t);
      api.registerTool(createEnvironmentTool(cfg));
    }

    if (cfg.ownerControls) {
      const owner = createOwnerHandlers({ cfg, secrets, replay: createReplayCache(), log });
      const claudeTools = createClaudeTools(cfg, secrets);
      const workerTools = createWorkerTools(cfg, secrets, claudeTools);
      const deliverMedia = async (path: string, caption?: string) => {
        const runtime = api.runtime as { config?: { current?: () => unknown }; channel?: { outbound?: { loadAdapter?: (id: string) => Promise<Record<string, unknown> | undefined> } } };
        const channel = cfg.deliveryChannel ?? 'telegram';
        const adapter = await runtime.channel?.outbound?.loadAdapter?.(channel);
        const sendMedia = adapter?.sendMedia as ((ctx: unknown) => Promise<unknown>) | undefined;
        if (!sendMedia) throw new Error(`${channel} media adapter is unavailable`);
        const owner = await secrets.get();
        if (!owner) throw new Error('Owner destination unavailable');
        return sendMedia({ cfg: runtime.config?.current?.() ?? api.config, to: cfg.deliveryTarget ?? owner.ownerId, text: caption ?? '', mediaUrl: path, accountId: null });
      };
      if (cfg.agentTools) for (const t of [...createOwnerMediaTools(cfg, secrets, { deliverMedia }), ...createOwnerReminderTools(secrets, { home: cfg.pottsHome, deliveryChannel: cfg.deliveryChannel, deliveryTarget: cfg.deliveryTarget }), ...claudeTools, ...workerTools]) {
        if(t.name==='potts_worker_control') api.registerTool((ctx:LearningContext)=>({ ...t, async execute(id:string,p:Record<string,unknown>){
          const owner=await secrets.get();
          if(!owner||ctx.senderIsOwner!==true||ctx.requesterSenderId!==owner.ownerId||ctx.messageChannel!==cfg.deliveryChannel||typeof ctx.assertInvocationCurrent!=='function')return {content:[{type:'text' as const,text:'Task controls are available in your verified conversation.'}],details:{ok:false,state:'unauthorized'}};
          ctx.assertInvocationCurrent();return t.execute(id,p);
        }}),{names:['potts_worker_control']});
        else api.registerTool(t);
      }
      if (cfg.coordinatorEnabled) {
        let timer: ReturnType<typeof setInterval> | undefined;
        api.registerService?.({ id: 'potts-worker-recovery', start: async () => {
          await workerTools.recover();
          timer=setInterval(()=>{void workerTools.recover().catch(()=>api.logger.warn('potts worker recovery failed; inspect local job records'));},10000);timer.unref();
        }, stop: async()=>{if(timer)clearInterval(timer);} });
      }
      api.registerCommand({
        name: 'claude', description: 'Hand a coding task straight to Claude Code (Opus 5.5): /claude [exampleapp|potts|"/path"] <task>',
        acceptsArgs: true, requireAuth: true, channels: [cfg.deliveryChannel ?? 'telegram'],
        handler: async (ctx) => {
          const s = await secrets.get();
          if (!checkOwnerCommand(ctx, s?.ownerId ?? null, cfg.deliveryChannel ?? 'telegram').ok || !s) return { text: 'This command is not available here.' };
          const parsed = parseClaudeArgs(ctx.args ?? '');
          if ('error' in parsed) return { text: parsed.error };
          const r = await claudeTools[0]!.execute('cmd', parsed as unknown as Record<string, unknown>);
          const d = r.details as { ok?: boolean; jobId?: string };
          return { text: d.ok ? `On it. I’ll send you the result when it’s ready.` : r.content[0]!.text.replace(/^Not started: /, 'Couldn\'t start: ') };
        },
      });

      if (cfg.ownerChannel && typeof api.registerService === 'function') {
        let server: { close(): Promise<void> } | null = null;
        const rt = api.runtime as { config?: { current?: () => unknown } } | undefined;
        api.registerService({
          id: 'potts-owner-channel',
          start: async () => {
            server = await startOwnerChannelServer({
              socketPath: cfg.ownerChannelSocket,
              secrets,
              deliver: createGatewayTelegramDeliver(api.runtime, () => rt?.config?.current?.() ?? api.config, cfg.deliveryChannel === 'imessage' ? undefined : cfg.telegramAccountId ?? undefined, cfg.deliveryChannel, cfg.deliveryTarget),
              approvalPrompt: (id) => owner.approvalPrompt(id),
              log,
            });
            log('owner_channel_started', {});
          },
          stop: async () => {
            await server?.close();
            server = null;
          },
        });
      }

      for (const name of Object.keys(COMMAND_ALIASES)) {
        api.registerCommand({
          name,
          description: COMMAND_DESCRIPTIONS[name] ?? 'Potts owner control',
          acceptsArgs: true,
          requireAuth: true,
          channels: [cfg.deliveryChannel ?? 'telegram'],
          handler: async (ctx) => owner.handleCommand(name, ctx),
        });
      }
      if (typeof api.registerInteractiveHandler === 'function') {
        api.registerInteractiveHandler({
          channel: 'telegram',
          namespace: CALLBACK_NAMESPACE,
          handler: async (ctx) => {
            const out = await owner.handleCallback(ctx);
            try {
              if (out.clearButtons) await ctx.respond?.clearButtons();
              await ctx.respond?.reply({ text: out.reply.text });
            } catch (e) {
              api.logger.warn('potts-broker: could not deliver callback reply', { error: (e as Error).message });
            }
            return { handled: true };
          },
        });
      } else {
        api.logger.warn('potts-broker: registerInteractiveHandler unavailable; approval buttons disabled, use /papprove <id> <code>');
      }
    }
  },
};

export default plugin;
