/** Optional extended coordinator model. Native Sol workers retain their own runtime. */
export const COORDINATOR_MODEL = 'openai/gpt-6.1-sol';
export const COORDINATOR_MODEL_SETTINGS = { agentRuntime: { id: 'openclaw' } };

export function registerCoordinatorModel(cfg: any): void {
  cfg.agents.defaults.models ??= {};
  cfg.agents.defaults.models[COORDINATOR_MODEL] ??= { alias: 'sol' };
  if (cfg.agents.defaults.modelPolicy?.allow) cfg.agents.defaults.modelPolicy.allow = [...new Set([...cfg.agents.defaults.modelPolicy.allow, COORDINATOR_MODEL])];
}

export function switchCoordinatorModel(cfg: any): void {
  const coordinator = cfg.agents?.entries?.['potts-coordinator'];
  if (!coordinator) throw new Error('Existing Potts coordinator is required');
  registerCoordinatorModel(cfg);
  // Per-agent routing avoids the native workers' global dynamic-tool exclusions.
  coordinator.models = { ...coordinator.models, [COORDINATOR_MODEL]: {
    ...coordinator.models?.[COORDINATOR_MODEL], ...COORDINATOR_MODEL_SETTINGS,
  } };
  coordinator.model = { ...coordinator.model, primary: COORDINATOR_MODEL,
    fallbacks: (coordinator.model?.fallbacks ?? []).filter((m: string) => m !== COORDINATOR_MODEL),
  };
  coordinator.modelPolicy = { ...coordinator.modelPolicy, allow: [...new Set([
    ...(coordinator.modelPolicy?.allow ?? []), COORDINATOR_MODEL,
  ])] };
}
