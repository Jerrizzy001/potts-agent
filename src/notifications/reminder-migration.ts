/**
 * Compare execution evidence across OpenClaw's disable operation. Disabling
 * clears the scheduled next run and updates scheduleActivatedAtMs even when
 * the authored schedule is unchanged (OpenClaw schedulingInputsChanged).
 * Neither field proves that a reminder executed. Preserve every other field,
 * including unknown future receipt fields, so changed execution fails closed.
 * Callers separately verify disabled state, authored schedule and payload.
 */
export function reminderExecutionFingerprint(state: Record<string, unknown> | undefined): string {
  const execution = { ...state };
  delete execution.nextRunAtMs;
  delete execution.scheduleActivatedAtMs;
  return JSON.stringify(Object.fromEntries(Object.entries(execution).sort(([a], [b]) => a.localeCompare(b))));
}
