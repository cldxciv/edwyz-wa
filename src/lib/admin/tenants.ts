import { audit } from "@/lib/auth/audit";
import { getBillingStatus } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { workspaceSuspendedTemplate } from "@/lib/email/templates";
import { emailOwners } from "@/lib/lifecycle/state";
import { windDownTenant } from "@/lib/tenant-lifecycle";
import { HttpError } from "@/lib/tenancy";
import { int, requireConfirmation, requireReason, str } from "./http";

const DAY_MS = 86_400_000;
export const PAGE_SIZE = 25;

export type TenantFilter = "all" | "trial" | "paying" | "suspended" | "exempt" | "deleted" | "deletion_requested";
export const TENANT_FILTERS: TenantFilter[] = ["all", "trial", "paying", "suspended", "exempt", "deleted", "deletion_requested"];

const DELETION_PREFIX = "workspace-deletion:";

/** Workspaces whose owner asked for deletion and that no one has erased yet, with the date the 30 day promise runs out. */
export async function pendingDeletionRequests(): Promise<Map<string, { requestedAt: string; deleteBy: string }>> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { startsWith: DELETION_PREFIX }, value: { path: ["status"], equals: "requested" } },
    select: { key: true, value: true },
    take: 500,
  });
  const out = new Map<string, { requestedAt: string; deleteBy: string }>();
  for (const r of rows) {
    const v = r.value as { requestedAt?: string; deleteBy?: string } | null;
    if (v?.requestedAt && v.deleteBy) out.set(r.key.slice(DELETION_PREFIX.length), { requestedAt: v.requestedAt, deleteBy: v.deleteBy });
  }
  return out;
}

export function tenantWhere(filter: TenantFilter, q: string, now = new Date()) {
  const where: Record<string, unknown> = {};
  if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }];
  if (filter === "deleted") where.deletedAt = { not: null };
  // Deletion requests list deleted workspaces too: one an admin soft-deleted, or whose erase stopped partway, is still owed an
  // erase, and the overview counts it (getPlatformMetrics), so the list it links to must show it.
  else if (filter !== "deletion_requested") where.deletedAt = null;
  if (filter === "suspended") where.status = "suspended";
  if (filter === "exempt") where.billingExempt = true;
  if (filter === "trial") Object.assign(where, { trialEndsAt: { gt: now }, billingExempt: false, subscription: { is: null } });
  if (filter === "paying") where.subscription = { is: { status: "active" } };
  return where;
}

export async function listTenants(opts: { filter: TenantFilter; q: string; page: number }) {
  const pending = await pendingDeletionRequests();
  const where = tenantWhere(opts.filter, opts.q);
  if (opts.filter === "deletion_requested") where.id = { in: [...pending.keys()] };
  const [total, rows] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (opts.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, name: true, slug: true, createdAt: true, status: true, deletedAt: true, trialEndsAt: true, billingExempt: true, onboardingStatus: true,
        _count: { select: { memberships: true } },
        subscription: { select: { status: true, plan: { select: { name: true } } } },
      },
    }),
  ]);
  const items = await Promise.all(
    rows.map(async (t) => ({ ...t, billing: (await getBillingStatus(t.id).catch(() => null))?.state ?? "unknown", deletionRequest: pending.get(t.id) ?? null })),
  );
  return { total, items };
}

export async function getTenantDetail(id: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: {
      memberships: { include: { user: { select: { id: true, email: true, name: true, disabledAt: true } } }, orderBy: { createdAt: "asc" } },
      subscription: { include: { plan: true } },
      wabas: { include: { phoneNumbers: true } },
    },
  });
  if (!tenant) return null;
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [invoices, contacts, conversations, messages30d, broadcasts, audits, onboarding, billing] = await Promise.all([
    prisma.invoice.findMany({ where: { tenantId: id }, orderBy: { issuedAt: "desc" }, take: 10 }),
    prisma.contact.count({ where: { tenantId: id } }),
    prisma.conversation.count({ where: { tenantId: id } }),
    prisma.message.count({ where: { tenantId: id, createdAt: { gte: since } } }),
    prisma.broadcast.count({ where: { tenantId: id } }),
    prisma.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: "desc" }, take: 15, select: { id: true, action: true, userId: true, createdAt: true } }),
    prisma.onboardingLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: "desc" }, take: 10, select: { step: true, status: true, createdAt: true } }),
    getBillingStatus(id).catch(() => null),
  ]);
  const deletionRequest = (await pendingDeletionRequests()).get(id) ?? null;
  return { tenant, invoices, usage: { contacts, conversations, messages30d, broadcasts }, audits, onboarding, billing, deletionRequest };
}

type Meta = Record<string, string | number | boolean | null>;
const log = (adminUserId: string, tenantId: string, action: string, meta: Meta) =>
  audit({ tenantId, userId: adminUserId, action: `admin.tenant.${action}`, target: tenantId, meta });

/**
 * Ads first (pausing needs the Meta token), then only the Meta connections that no live campaign needs any more
 * (see windDownTenant). Best effort and audited per item; never throws.
 * A connection whose campaign could not be paused is kept (revoking would delete the token and leave the campaign spending
 * with no way to pause it); the failure is audited once per campaign and the sweep (pauseAdsForBlockedTenants) retries the pause
 * and then revokes the connection. A campaign whose connection is already unusable cannot be retried; the warning tells the admin.
 * Residual windows, accepted: the workers' tenant-state cache is 30 seconds, and a billing lock has no transition event,
 * so ads of a locked workspace are paused by the billing worker's sweep, up to a few minutes later.
 */
async function windDown(adminUserId: string, tenantId: string): Promise<Meta> {
  const res = await windDownTenant(tenantId, adminUserId, { revoke: true });
  return {
    adsPaused: res.paused,
    adsPauseFailed: res.pauseFailed + res.unreachable,
    connectionsRevoked: res.revoked,
    revokeFailed: res.revokeFailed,
    connectionsDeferred: res.deferred,
  };
}

const WIND_DOWN_WARNING = "Some ad campaigns could not be paused on Meta, so their Meta connections were kept. The system retries every 15 minutes; check Meta Ads Manager if it persists.";

/** The 5.8 choices for Meta's spending limit when a workspace is suspended or deleted. "keep" is the default. */
export const META_LIMIT_CHOICES = ["keep", "restore", "remove"] as const;
export type MetaLimitChoice = (typeof META_LIMIT_CHOICES)[number];

/** The admin form's choice (field metaLimitChoice); missing or empty means "keep". */
export function metaLimitChoiceOf(body: Record<string, unknown>): MetaLimitChoice {
  const v = body.metaLimitChoice;
  if (v === undefined || v === null || v === "") return "keep";
  if (typeof v !== "string" || !(META_LIMIT_CHOICES as readonly string[]).includes(v)) throw new HttpError(400, "Choose to keep Meta's spending limit, put back the owner's old limit, or remove it.");
  return v as MetaLimitChoice;
}

/**
 * Applies the 5.8 choice to every ad account where Edwyz holds Meta's spending limit, while the Meta token still works, so
 * BEFORE the connections are revoked (docs/SPEND-CONTROLS-SPEC.md 5.8, 3.5). Ledgered by the offboarding itself with the
 * platform admin as the actor. Best effort: it never blocks the suspend or the delete.
 */
async function offboardMetaLimits(adminUserId: string, tenantId: string, trigger: "suspend" | "soft_delete", choice: MetaLimitChoice): Promise<Meta> {
  try {
    const rows = await prisma.metaSpendLimit.findMany({ where: { tenantId, mode: { notIn: ["off", "withdrawn"] } }, select: { adAccountAssetId: true } });
    if (!rows.length) return { metaLimitChoice: choice, metaLimitAccounts: 0 };
    const { offboardTenant } = await import("@/lib/spend/metacap/offboard");
    const results = await offboardTenant(tenantId, trigger, { actor: { type: "platform_admin", userId: adminUserId }, choices: Object.fromEntries(rows.map((r) => [r.adAccountAssetId, choice])) });
    return { metaLimitChoice: choice, metaLimitAccounts: results.length, metaLimitApplied: results.filter((r) => r.applied !== "not_applied").length };
  } catch (error) {
    console.error("[admin] Meta limit offboarding failed:", error instanceof Error ? error.message : "unknown");
    return { metaLimitChoice: choice, metaLimitAccounts: -1 };
  }
}

/** One entry point for every workspace action; each validates its own input, applies the change and audits it. */
export async function applyTenantAction(adminUserId: string, tenantId: string, body: Record<string, unknown>) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, trialEndsAt: true, deletedAt: true } });
  if (!tenant) throw new HttpError(404, "Workspace not found.");
  const action = str(body, "action", "Action", 40);
  const reason = requireReason(body);
  let extra: Meta = {};

  switch (action) {
    case "suspend": {
      requireConfirmation(tenant.name, body.confirm);
      const choice = metaLimitChoiceOf(body);
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "suspended", suspendedReason: reason } });
      const meta = await offboardMetaLimits(adminUserId, tenantId, "suspend", choice);
      extra = { ...meta, ...(await windDown(adminUserId, tenantId)) };
      await emailOwners(tenantId, () => workspaceSuspendedTemplate({ workspaceName: tenant.name })).catch(() => 0);
      break;
    }
    case "unsuspend":
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "active", suspendedReason: null } });
      break;
    case "extend_trial": {
      const days = int(body, "days", "Days", 1, 365);
      const base = Math.max(Date.now(), tenant.trialEndsAt?.getTime() ?? 0);
      await prisma.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: new Date(base + days * DAY_MS) } });
      await log(adminUserId, tenantId, action, { reason, days });
      return { ok: true };
    }
    case "comp": {
      if (typeof body.exempt !== "boolean") throw new HttpError(400, "Choose whether to comp or remove the comp.");
      await prisma.tenant.update({ where: { id: tenantId }, data: { billingExempt: body.exempt } });
      await log(adminUserId, tenantId, action, { reason, exempt: body.exempt });
      return { ok: true };
    }
    case "change_plan":
      return changePlan(adminUserId, tenantId, body, reason);
    case "soft_delete": {
      requireConfirmation(tenant.name, body.confirm);
      const choice = metaLimitChoiceOf(body);
      await prisma.tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date(), status: "suspended", suspendedReason: `Deleted by platform admin: ${reason}` } });
      const meta = await offboardMetaLimits(adminUserId, tenantId, "soft_delete", choice);
      extra = { ...meta, ...(await windDown(adminUserId, tenantId)) };
      break;
    }
    case "restore":
      await prisma.tenant.update({ where: { id: tenantId }, data: { deletedAt: null, status: "active", suspendedReason: null } });
      break;
    default: {
      // The spending actions of 8.3 (override ceilings, new-workspace limits, stops, safety stops, Meta's limit) live in
      // spending.ts; loaded only when one is asked for.
      const spending = await import("./spending");
      if (spending.isTenantSpendAction(action)) return spending.applySpendAction(adminUserId, tenantId, body);
      throw new HttpError(400, "Unknown action.");
    }
  }
  await log(adminUserId, tenantId, action, { reason, ...extra });
  if (Number(extra.adsPauseFailed) > 0 || Number(extra.connectionsDeferred) > 0) return { ok: true, warning: WIND_DOWN_WARNING };
  return { ok: true };
}

async function changePlan(adminUserId: string, tenantId: string, body: Record<string, unknown>, reason: string) {
  const planId = str(body, "planId", "Plan", 60);
  const months = int(body, "months", "Months", 1, 36);
  const [plan, existing] = await Promise.all([
    prisma.plan.findUnique({ where: { id: planId }, select: { id: true, code: true } }),
    prisma.subscription.findUnique({ where: { tenantId }, select: { razorpaySubscriptionId: true, status: true } }),
  ]);
  if (!plan) throw new HttpError(404, "Plan not found.");
  if (existing?.razorpaySubscriptionId && existing.status === "active") {
    throw new HttpError(409, "This workspace has a live Razorpay subscription. Cancel it in Razorpay first.");
  }
  const start = new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  const data = { planId, status: "active" as const, currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false, pastDueSince: null, razorpaySubscriptionId: null };
  await prisma.subscription.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  await log(adminUserId, tenantId, "change_plan", { reason, plan: plan.code, months, manual: true });
  return { ok: true };
}
