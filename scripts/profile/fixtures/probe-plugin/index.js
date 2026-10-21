// Potts WP-0 probe plugin. Install ONLY into the isolated test profile:
//   scripts/profile/run-test-gateway.sh -- scripts/profile/oc-test.sh plugins install -l scripts/profile/fixtures/probe-plugin --force --accept-capabilities
export default {
  id: 'potts-probe',
  name: 'Potts probe',
  description: 'WP-0 probe',
  register(api) {
    api.registerTool({
      name: 'potts_probe_echo',
      description: 'Echo input (probe)',
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
      async execute(_id, params) {
        return { content: [{ type: 'text', text: `probe: ${params.input}` }], details: { input: params.input } };
      },
    });
    // Commands bypass the LLM; ctx carries host-resolved sender identity (senderId, channel,
    // isAuthorizedSender, senderIsOwner when exposed). Never log raw identifiers in real code.
    api.registerCommand({
      name: 'pottsprobe',
      description: 'Probe command (no LLM)',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => ({
        text: `probe ok channel=${ctx.channel} authorized=${ctx.isAuthorizedSender} sender=${ctx.senderId ? 'present' : 'absent'}`,
      }),
    });
  },
};
