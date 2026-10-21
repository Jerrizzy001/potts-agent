/**
 * Read gate: readers are trusted job code, not broker actions, but they still
 * honour the owner's controls. A revoked account or a paused integration (or
 * global pause) stops synchronization before any network call.
 */
export type ReadGateVerdict = { ok: true } | { ok: false; code: 'revoked' | 'paused'; reason: string };
export type ReadGate = (accountId: string, integration: string) => ReadGateVerdict;

export const openReadGate: ReadGate = () => ({ ok: true });

export function brokerReadGate(broker: { controls(): { globalPaused: boolean; pausedIntegrations: readonly string[]; revokedAccounts: readonly string[] } }): ReadGate {
  return (accountId, integration) => {
    const c = broker.controls();
    if (c.revokedAccounts.includes(accountId)) return { ok: false, code: 'revoked', reason: `account ${accountId} is revoked` };
    if (c.globalPaused) return { ok: false, code: 'paused', reason: 'all integrations are paused' };
    if (c.pausedIntegrations.includes(integration)) return { ok: false, code: 'paused', reason: `integration ${integration} is paused` };
    return { ok: true };
  };
}
