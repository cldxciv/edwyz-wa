export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Free-form messages are allowed for 24 hours after the customer's last inbound message (inclusive). */
export function isWithinServiceWindow(lastInboundAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const age = now.getTime() - lastInboundAt.getTime();
  return age <=SERVICE_WINDOW_MS;
}
