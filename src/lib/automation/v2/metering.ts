import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getBillingStatus } from "@/lib/billing/status";
import { queueEmail } from "@/lib/email";
import { monthStart } from "@/lib/usage";

/**
 * A trigger is one rule run that completed (RuleExecution.outcome = "ok"). The monthly allowance comes from the plan:
 * Plan.features.automationTriggersMonthly (whole number, 1 or more). When the plan leaves it out there is no limit. 0 is ignored:
 * it would switch automation off for a plan, and every module is on every plan (owner decision 6, 2026-10-31).
 */
export const LIMIT_FEATURE = "automationTriggersMonthly";
export const ALERT_THRESHOLDS = [80, 90, 100] as const;
const LIMIT_TTL_MS = 60_000;

const limitCache = new Map<string, { at: number; limit: number | null }>();

export function resetMeteringCache() {
  limitCache.clear();
}

export function readLimit(features: unknown): number | null {
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  const raw = (features as Record<string, unknown>)[LIMIT_FEATURE];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

export async function triggerLimit(tenantId: string, now = Date.now()): Promise<number | null> {
  const hit = limitCache.get(tenantId);
  if (hit && now - hit.at < LIMIT_TTL_MS) return hit.limit;
  let limit: number | null = null;
  try {
    const status = await getBillingStatus(tenantId);
    if (status.state !== "exempt") {
      const select = { features: true } as const;
      const plan = status.planId
        ? await prisma.plan.findUnique({ where: { id: status.planId }, select })
        : status.state === "trialing"
          ? await prisma.plan.findUnique({ where: { code: "trial" }, select })
          : null;
      limit = readLimit(plan?.features);
    }
  } catch {
    limit = null;
  }
  limitCache.set(tenantId, { at: now, limit });
  if (limitCache.size > 5000) limitCache.clear();
  return limit;
}

export type TriggerUsage = { used: number; limit: number | null; percent: number | null; resetsOn: string };

export const usedThisMonth = (tenantId: string, now = new Date()) =>
  prisma.ruleExecution.count({ where: { tenantId, outcome: "ok", createdAt: { gte: monthStart(now) } } });

export async function getTriggerUsage(tenantId: string, now = new Date()): Promise<TriggerUsage> {
  const [used, limit] = await Promise.all([usedThisMonth(tenantId, now), triggerLimit(tenantId, now.getTime())]);
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { used, limit, percent: limit === null ? null : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100)), resetsOn };
}

/** True when the workspace has used its whole monthly allowance. */
export async function isOverLimit(tenantId: string, now = new Date()): Promise<boolean> {
  const limit = await triggerLimit(tenantId, now.getTime());
  if (limit === null) return false;
  return (await usedThisMonth(tenantId, now)) >= limit;
}

/** How many more rule runs fit in this month's allowance, or null when there is no limit. */
export async function remainingTriggers(tenantId: string, now = new Date()): Promise<number | null> {
  const limit = await triggerLimit(tenantId, now.getTime());
  if (limit === null) return null;
  return Math.max(0, limit - (await usedThisMonth(tenantId, now)));
}

export function highestThreshold(used: number, limit: number): number | null {
  if (limit <= 0) return null;
  const pct = (used / limit) * 100;
  return [...ALERT_THRESHOLDS].reverse().find((t) => pct >= t) ?? null;
}

const alertKey = (tenantId: string, now: Date, threshold: number) => `automation-alert:${tenantId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}:${threshold}`;

async function claimAlert(tenantId: string, now: Date, threshold: number): Promise<boolean> {
  try {
    await prisma.platformSetting.create({ data: { key: alertKey(tenantId, now, threshold), value: { at: now.toISOString() } } });
    return true;
  } catch {
    return false;
  }
}

async function notifyOwners(tenantId: string, threshold: number, used: number, limit: number) {
  const owners = await prisma.membership.findMany({ where: { tenantId, role: { in: ["owner", "admin"] } }, select: { user: { select: { email: true, disabledAt: true } } } });
  const subject = threshold >= 100 ? "Your automation rules have paused for this month" : `You have used ${threshold}% of this month's automation runs`;
  const body =
    threshold >= 100
      ? `Your workspace has used all ${limit} automation rule runs included in your plan this month, so rules will not run again until the month starts over.`
      : `Your workspace has used ${used} of the ${limit} automation rule runs included in your plan this month.`;
  for (const m of owners) {
    if (m.user.disabledAt) continue;
    await queueEmail({ to: m.user.email, subject, text: `${body}\n\nSee your plan and options: ${siteUrl()}/app/billing\n` });
  }
}

/** Hourly: emails owners and admins once per month and threshold (80, 90, 100 percent). Returns how many alerts were sent. */
export async function sendQuotaAlerts(now = new Date()): Promise<number> {
  const rows = await prisma.ruleExecution.groupBy({ by: ["tenantId"], where: { outcome: "ok", createdAt: { gte: monthStart(now) } }, _count: { _all: true } });
  let sent = 0;
  for (const row of rows) {
    const limit = await triggerLimit(row.tenantId, now.getTime());
    if (limit === null) continue;
    const used = row._count._all;
    const threshold = highestThreshold(used, limit);
    if (threshold === null || !(await claimAlert(row.tenantId, now, threshold))) continue;
    await notifyOwners(row.tenantId, threshold, used, limit);
    sent += 1;
  }
  return sent;
}
