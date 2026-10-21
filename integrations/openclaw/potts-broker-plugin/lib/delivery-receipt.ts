/** Accept positive CLI delivery receipts, never mere exit success or partial sends. */
export function deliveryReceiptAccepted(raw: string, channel: string, target: string): boolean {
  let d: Record<string, any>;
  try { d = JSON.parse(raw); } catch { return false; }
  if (!d || typeof d !== 'object' || d.ok === false || d.error || d.dryRun === true || d.sentBeforeError === true) return false;
  const p = d.payload;
  if ((d.deliveryStatus !== undefined && d.deliveryStatus !== 'sent') || (p?.deliveryStatus !== undefined && p.deliveryStatus !== 'sent') || p?.sentBeforeError === true) return false;
  for (const id of [d.messageId, p?.result?.messageId]) if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.trim() === 'unknown')) return false;
  // Only the old unscoped acknowledgement may omit modern routing/outcome evidence.
  if (d.ok === true && d.action === undefined && d.channel === undefined && d.to === undefined && p === undefined) return true;
  if (d.to !== undefined && d.to !== target) return false;
  if (d.action !== 'send' || d.channel !== channel || p?.channel !== channel || p?.to !== target || p?.deliveryStatus !== 'sent') return false;
  if (!Array.isArray(p.payloadOutcomes) || !p.payloadOutcomes.length || p.payloadOutcomes.some((v: any) => v?.status !== 'sent')) return false;
  const messageId = d.messageId ?? p.result?.messageId;
  return typeof messageId === 'string' && messageId.trim().length > 0 && messageId.trim() !== 'unknown';
}

/** Installed outbound adapters return a platform ID, or iMessage's explicit "ok" acknowledgement.
 * "unknown", a resolved promise, or an empty receipt never prove acceptance. */
export function nativeDeliveryReceipt(value: unknown): { accepted: true; messageId: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.ok === false || r.error || r.dryRun === true || r.sentBeforeError === true || r.deliveryStatus === 'failed') return null;
  const id = r.messageId;
  if (id === 'ok') return { accepted: true, messageId: null };
  if (typeof id === 'string' && id.trim() && id.trim() !== 'unknown') return { accepted: true, messageId: id };
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) return { accepted: true, messageId: String(id) };
  return null;
}
