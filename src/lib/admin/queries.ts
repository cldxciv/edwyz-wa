import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";

const DAY_MS = 86_400_000;

/** Monthly value of a plan price in paise. */
export const monthlyPaise = (pricePaise: number, intervalMonths: number) => Math.round(pricePaise / Math.max(intervalMonths, 1));

export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return `INR ${rupees.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export async function getPlatformMetrics(now = new Date()) {
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const [tenants, subs, users7, users30, tenants7, tenants30, inbound, outbound, quality, jobs, failedEvents] = await Promise.all([
    prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true }, take: 5000 }),
    prisma.subscription.findMany({ where: { status: "active", tenant: { billingExempt: false } }, select: { razorpaySubscriptionId: true, plan: { select: { pricePaise: true, intervalMonths: true } } } }),
    prisma.user.count({ where: { createdAt: { gte: d7 } } }),
    prisma.user.count({ where: { createdAt: { gte: d30 } } }),
    prisma.tenant.count({ where: { createdAt: { gte: d7 } } }),
    prisma.tenant.count({ where: { createdAt: { gte: d30 } } }),
    prisma.message.count({ where: { direction: "inbound", createdAt: { gte: d1 } } }),
    prisma.message.count({ where: { direction: "outbound", createdAt: { gte: d1 } } }),
    prisma.phoneNumber.groupBy({ by: ["qualityRating"], _count: { _all: true } }),
    prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.webhookEvent.findMany({ where: { error: { not: null } }, orderBy: { receivedAt: "desc" }, take: 10, select: { id: true, receivedAt: true, error: true, processedAt: true } }),
  ]);

  const byState: Record<string, number> = {};
  const statuses = await Promise.all(tenants.map((t) => getBillingStatus(t.id).then((s) => s.state).catch(() => "unknown")));
  for (const s of statuses) byState[s] = (byState[s] ?? 0) + 1;

  const paid = subs.filter((s) => s.razorpaySubscriptionId);
  return {
    tenantsByState: byState,
    totalTenants: tenants.length,
    trialCount: byState.trialing ?? 0,
    activeSubscriptions: subs.length,
    paidSubscriptions: paid.length,
    manualSubscriptions: subs.length - paid.length,
    mrrPaise: paid.reduce((sum, s) => sum + monthlyPaise(s.plan.pricePaise, s.plan.intervalMonths), 0),
    signups: { users7, users30, tenants7, tenants30 },
    messages24h: { inbound, outbound },
    quality: quality.map((q) => ({ rating: q.qualityRating ?? "unknown", count: q._count._all })),
    jobs: Object.fromEntries(jobs.map((j) => [j.status, j._count._all])) as Record<string, number>,
    failedEvents: failedEvents.map((e) => ({ id: e.id, at: e.receivedAt.toISOString(), error: (e.error ?? "").slice(0, 200) })),
  };
}

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilter = { tenantId?: string; userId?: string; action?: string; from?: Date; to?: Date; page: number };

export function auditWhere(f: AuditFilter) {
  const where: Record<string, unknown> = {};
  if (f.tenantId) where.tenantId = f.tenantId;
  if (f.userId) where.userId = f.userId;
  if (f.action) where.action = { startsWith: f.action };
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
  return where;
}

/** Only fields that are safe to show: meta is limited to scalar values. */
export async function listAudit(f: AuditFilter) {
  const where = auditWhere(f);
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      action: r.action,
      tenantId: r.tenantId,
      userId: r.userId,
      target: r.target,
      meta: safeMeta(r.meta),
    })),
  };
}

export function safeMeta(meta: unknown): string {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "";
  return Object.entries(meta as Record<string, unknown>)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || v === null)
    .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
    .join(" ");
}

export async function listPayments() {
  const [events, invoices] = await Promise.all([
    prisma.paymentEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 50, select: { id: true, type: true, receivedAt: true, processedAt: true, error: true } }),
    prisma.invoice.findMany({ orderBy: { issuedAt: "desc" }, take: 50 }),
  ]);
  const tenants = await prisma.tenant.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.tenantId))] } }, select: { id: true, name: true } });
  const names = new Map(tenants.map((t) => [t.id, t.name]));
  return {
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      status: e.error ? "error" : e.processedAt ? "processed" : "pending",
      at: e.receivedAt.toISOString(),
      error: e.error ? e.error.slice(0, 200) : null,
    })),
    invoices: invoices.map((i) => ({
      id: i.id, number: i.number, tenant: names.get(i.tenantId) ?? i.tenantId, status: i.status, totalPaise: i.totalPaise, issuedAt: i.issuedAt.toISOString(), paidAt: i.paidAt?.toISOString() ?? null,
    })),
  };
}
