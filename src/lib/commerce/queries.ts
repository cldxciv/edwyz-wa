import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

const STATUSES = ["open", "recovered", "expired", "opted_out", "replied"];
const STAGES = ["cart", "checkout"];

export type CartQuery = { storeId?: string; status?: string; stage?: string; cursor?: string; limit?: number };

export function parseCartQuery(params: URLSearchParams): CartQuery {
  const status = params.get("status") || undefined;
  const stage = params.get("stage") || undefined;
  if (status && !STATUSES.includes(status)) throw new HttpError(400, "Unknown status filter.");
  if (stage && !STAGES.includes(stage)) throw new HttpError(400, "Unknown stage filter.");
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 25) || 25, 1), 100);
  return { storeId: params.get("storeId") || undefined, status, stage, cursor: params.get("cursor") || undefined, limit };
}

export async function listCarts(tenantId: string, q: CartQuery) {
  const rows = await prisma.abandonedCart.findMany({
    where: { tenantId, ...(q.storeId ? { storeId: q.storeId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.stage ? { stage: q.stage } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: (q.limit ?? 25) + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: {
      id: true, storeId: true, phone: true, totalMinor: true, currency: true, stage: true, status: true,
      remindersSent: true, nextReminderAt: true, createdAt: true, store: { select: { shopDomain: true } },
    },
  });
  const limit = q.limit ?? 25;
  const page = rows.slice(0, limit);
  return {
    carts: page.map(({ store, ...cart }) => ({ ...cart, shopDomain: store.shopDomain })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

export async function recoveryStats(tenantId: string, opts: { storeId?: string; days?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const base = { tenantId, createdAt: { gte: new Date(Date.now() - days * 86_400_000) }, ...(opts.storeId ? { storeId: opts.storeId } : {}) };
  const [total, recovered, reminded, recoveredAfterReminder, remindersSent, revenue] = await Promise.all([
    prisma.abandonedCart.count({ where: base }),
    prisma.abandonedCart.count({ where: { ...base, status: "recovered" } }),
    prisma.abandonedCart.count({ where: { ...base, remindersSent: { gt: 0 } } }),
    prisma.abandonedCart.count({ where: { ...base, status: "recovered", remindersSent: { gt: 0 } } }),
    prisma.abandonedCart.aggregate({ where: base, _sum: { remindersSent: true } }),
    prisma.abandonedCart.groupBy({ by: ["currency"], where: { ...base, status: "recovered", remindersSent: { gt: 0 } }, _sum: { totalMinor: true } }),
  ]);
  const rate = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
  return {
    days,
    total,
    recovered,
    recoveryRatePercent: rate(recovered, total),
    reminded,
    recoveredAfterReminder,
    reminderRecoveryRatePercent: rate(recoveredAfterReminder, reminded),
    remindersSent: remindersSent._sum.remindersSent ?? 0,
    recoveredValue: revenue.map((r) => ({ currency: r.currency, totalMinor: r._sum.totalMinor ?? 0 })),
  };
}
