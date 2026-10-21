/** Keep the host's owner authority aligned with the single admitted iMessage owner. */
export function configureIMessageOwner(cfg: {
  channels?: {imessage?: {allowFrom?: unknown}};
  commands?: Record<string, unknown>;
}): string {
  const owners = cfg.channels?.imessage?.allowFrom;
  if (!Array.isArray(owners) || owners.length !== 1 || typeof owners[0] !== 'string' || !/^\+[1-9]\d{7,14}$/.test(owners[0])) {
    throw new Error('exactly one iMessage owner number is required');
  }
  // Channel allowFrom admits chat; commands.ownerAllowFrom separately grants
  // the host owner bit used by learning, task controls and exact reactions.
  // This setup migrates away from Telegram, so stale owners must not survive.
  cfg.commands = {...cfg.commands, ownerAllowFrom: [`imessage:${owners[0]}`]};
  return owners[0];
}
