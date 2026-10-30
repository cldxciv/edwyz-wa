export type Funnel = { sent: number; delivered: number; read: number; replied: number; failed: number; total: number };

/** counts is a status -> number map of BroadcastRecipient rows. Sent includes delivered and read. */
export function buildFunnel(counts: Record<string, number>, replied: number): Funnel {
  const n = (s: string) => counts[s] ?? 0;
  return {
    sent: n("sent") + n("delivered") + n("read"),
    delivered: n("delivered") + n("read"),
    read: n("read"),
    replied: Math.max(0, replied),
    failed: n("failed"),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

export const funnelRate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function mergeCounts(groups: { status: string; _count: { _all: number } }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.status] = (counts[g.status] ?? 0) + g._count._all;
  return counts;
}
