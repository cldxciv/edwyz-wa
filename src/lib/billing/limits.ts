import { effectiveCreditLimit } from "@/lib/ai-agent/credits";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { AI_LEGACY_ACTOR, reserveAi, type AiFeature, type AiHold } from "@/lib/spend/exec/ai";
import type { SpendActor } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { usedThisMonth } from "@/lib/usage";
import { getBillingStatus } from "./status";

export type LimitKind = "seats" | "contacts" | "broadcastContacts" | "aiCredits" | "adAccounts" | "scheduledPosts" | "channels";

export const LIMIT_KINDS: readonly LimitKind[] = ["seats", "contacts", "broadcastContacts", "aiCredits", "adAccounts", "scheduledPosts", "channels"];

/** Kinds whose usage restarts on the first of each month (UTC). The others are totals. */
export const MONTHLY_KINDS: readonly LimitKind[] = ["broadcastContacts", "aiCredits", "scheduledPosts"];

type PlanLimits = {
  seatLimit: number | null;
  contactLimit: number | null;
  monthlyBroadcastLimit: number | null;
  adAccountLimit: number | null;
  scheduledPostLimit: number | null;
  connectedChannelLimit: number | null;
};

const SELECT = { seatLimit: true, contactLimit: true, monthlyBroadcastLimit: true, adAccountLimit: true, scheduledPostLimit: true, connectedChannelLimit: true } as const;

async function resolvePlanLimits(tenantId: string): Promise<PlanLimits | null> {
  const status = await getBillingStatus(tenantId);
  if (status.state === "exempt") return null;
  if (status.planId) return prisma.plan.findUnique({ where: { id: status.planId }, select: SELECT });
  if (status.state === "trialing") return prisma.plan.findUnique({ where: { code: "trial" }, select: SELECT });
  return null;
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const PLAN_FIELD: Record<Exclude<LimitKind, "aiCredits">, keyof PlanLimits> = {
  seats: "seatLimit",
  contacts: "contactLimit",
  broadcastContacts: "monthlyBroadcastLimit",
  adAccounts: "adAccountLimit",
  scheduledPosts: "scheduledPostLimit",
  channels: "connectedChannelLimit",
};

/** The limit that applies to a workspace for one kind, or null when there is none. AI credits are never unlimited: a plan with no allotment gets the platform ceiling. */
export async function limitFor(tenantId: string, kind: LimitKind): Promise<number | null> {
  if (kind === "aiCredits") return effectiveCreditLimit(tenantId);
  const plan = await resolvePlanLimits(tenantId);
  return plan ? (plan[PLAN_FIELD[kind]] ?? null) : null;
}

/** Ad accounts that already carry a campaign. An account is "in use" from its first campaign on; archived campaigns do not hold it. */
export async function usedAdAccountIds(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.adCampaign.findMany({ where: { tenantId, status: { not: "archived" } }, distinct: ["adAccountAssetId"], select: { adAccountAssetId: true }, take: 1000 });
  return new Set(rows.map((r) => r.adAccountAssetId));
}

/** Pages, Instagram and Threads accounts that already carry a post target. Canceled posts do not hold a channel. */
export async function usedChannelIds(tenantId: string, excludePostId?: string): Promise<Set<string>> {
  const rows = await prisma.postTarget.findMany({ where: { tenantId, post: { status: { not: "canceled" } }, ...(excludePostId ? { postId: { not: excludePostId } } : {}) }, distinct: ["assetId"], select: { assetId: true }, take: 1000 });
  return new Set(rows.map((r) => r.assetId));
}

export async function usageFor(tenantId: string, kind: LimitKind, now = new Date()): Promise<number> {
  switch (kind) {
    case "seats": {
      const [members, invites] = await Promise.all([
        prisma.membership.count({ where: { tenantId } }),
        prisma.invite.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: now } } }),
      ]);
      return members + invites;
    }
    case "contacts":
      return prisma.contact.count({ where: { tenantId } });
    case "broadcastContacts":
      return prisma.broadcastRecipient.count({ where: { tenantId, broadcast: { createdAt: { gte: monthStartUtc(now) } } } });
    case "aiCredits":
      return usedThisMonth(tenantId, "ai_credits", now);
    case "adAccounts":
      return (await usedAdAccountIds(tenantId)).size;
    case "scheduledPosts":
      return prisma.scheduledPost.count({ where: { tenantId, createdAt: { gte: monthStartUtc(now) }, status: { not: "canceled" } } });
    case "channels":
      return (await usedChannelIds(tenantId)).size;
  }
}

export const LIMIT_LABEL: Record<LimitKind, string> = {
  seats: "team seats",
  contacts: "contacts",
  broadcastContacts: "broadcast messages per month",
  aiCredits: "AI credits per month",
  adAccounts: "ad accounts",
  scheduledPosts: "scheduled posts per month",
  channels: "connected social channels",
};

function refusal(kind: LimitKind, limit: number, used: number): string {
  if (kind === "aiCredits") {
    return `You have used ${used} of your ${limit} AI credits for this month, so this cannot run. Credits restart on the 1st of the month. Upgrade your plan at /app/billing for a larger allowance.`;
  }
  return `Your plan allows up to ${limit} ${LIMIT_LABEL[kind]} (${used} in use). Upgrade your plan at /app/billing.`;
}

/**
 * Throws HttpError(402) when adding would exceed the plan's limit. No limit is applied when the plan leaves it unset, except AI credits,
 * which always have a ceiling. For aiCredits, `adding` is the credit cost of the action about to run. For adAccounts and channels it is
 * the number of NEW accounts (use assertAdAccountAllowed / assertChannelsAllowed, which work that out).
 */
export async function assertWithinLimit(tenantId: string, kind: LimitKind, adding = 1): Promise<void> {
  if (adding <= 0) return;
  const limit = await limitFor(tenantId, kind);
  if (limit === null || limit === undefined) return;
  const used = await usageFor(tenantId, kind);
  if (used + adding > limit) throw new HttpError(402, refusal(kind, limit, used));
}

export type ReserveCreditsOptions = {
  /** What the credits are for; decides what a freeze stops (4.10). Defaults to `creative`, the legacy caller. */
  feature?: AiFeature;
  /** Who asked. Defaults to a system actor (never an assistant). */
  actor?: SpendActor;
  /** The ai_call reservation subject, when the caller has a natural one. */
  subjectId?: string;
};

/** The release of a credit hold. `hold` lets the caller run the model through the gateway under it and settle it once. */
export type CreditRelease = (() => void) & { readonly hold: AiHold | null };

/**
 * Holds `cost` AI credits before a call starts (docs/SPEND-CONTROLS-SPEC.md 4.10). Same signature as before, but it now
 * delegates to the gateway's reserveAi(): the lock-free conditional reservation on SpendCounter, shared by every process,
 * plus a SpendReservation so a crash gives the credits back. Throws 402 ai_quota ("This month's AI limit is used up...")
 * when the daily or monthly AI limit would be passed, or the freeze refusal for automatic features.
 *
 * Then either settle `release.hold` (hold.settle with the actual credits and the usage reference), or record the credits
 * with recordUsage() and call the release in a finally. Releasing after a settle does nothing.
 */
export async function reserveCredits(tenantId: string, cost: number, opts: ReserveCreditsOptions = {}): Promise<CreditRelease> {
  if (cost <= 0) return Object.assign(() => undefined, { hold: null });
  const hold = await reserveAi({ tenantId, feature: opts.feature ?? "creative", actor: opts.actor ?? AI_LEGACY_ACTOR, credits: cost, subjectId: opts.subjectId });
  const release = () => {
    hold.release().catch((error) => console.warn(`[billing] AI credit hold not released: ${describeError(error)}`));
  };
  return Object.assign(release, { hold });
}

/**
 * Ad accounts count as "in use" from their first campaign (draft or launched, not archived) on. Discovering or connecting ad accounts
 * in meta-connect is deliberately not limited: Meta hands over every account the user can see and the workspace must be able to
 * pick one. A plan downgrade is grandfathered: accounts already carrying a campaign keep working, only a NEW account is refused.
 * A campaign on an ad account that already has one never counts again; only a new account is checked against the plan. */
export async function assertAdAccountAllowed(tenantId: string, adAccountAssetId: string): Promise<void> {
  if ((await limitFor(tenantId, "adAccounts")) === null) return;
  if ((await usedAdAccountIds(tenantId)).has(adAccountAssetId)) return;
  await assertWithinLimit(tenantId, "adAccounts", 1);
}

/** Which of these ad accounts the plan would refuse a first campaign on. Empty when the plan has no ad account limit. */
export async function adAccountsBlockedByPlan(tenantId: string, assetIds: string[]): Promise<Set<string>> {
  const limit = await limitFor(tenantId, "adAccounts");
  if (limit === null || assetIds.length === 0) return new Set();
  const used = await usedAdAccountIds(tenantId);
  return used.size >= limit ? new Set(assetIds.filter((id) => !used.has(id))) : new Set();
}

/** Only channels that do not carry a post yet count toward the plan's connected-channel limit. */
export async function assertChannelsAllowed(tenantId: string, assetIds: string[], opts: { excludePostId?: string } = {}): Promise<void> {
  if ((await limitFor(tenantId, "channels")) === null) return;
  const used = await usedChannelIds(tenantId, opts.excludePostId);
  const fresh = new Set(assetIds.filter((id) => !used.has(id)));
  if (fresh.size === 0) return;
  const limit = await limitFor(tenantId, "channels");
  if (limit !== null && used.size + fresh.size > limit) throw new HttpError(402, refusal("channels", limit, used.size));
}

/** Which plan the limits come from: none for a trial without a plan and for complimentary workspaces. For the billing page's wording. */
export async function usagePlan(tenantId: string): Promise<{ state: string; planName: string | null }> {
  const status = await getBillingStatus(tenantId);
  return { state: status.state, planName: status.planName };
}

export type UsageLine = { kind: LimitKind; label: string; used: number; limit: number | null; percent: number | null; monthly: boolean };

export function percentUsed(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return limit === 0 ? 100 : null;
  return Math.min(100, Math.floor((used * 100) / limit));
}

/** Every limit with how much of it is used, for the billing page and the alert sweep. The plan is read once. */
export async function usageLines(tenantId: string, now = new Date()): Promise<UsageLine[]> {
  const [plan, aiLimit] = await Promise.all([resolvePlanLimits(tenantId), effectiveCreditLimit(tenantId)]);
  return Promise.all(
    LIMIT_KINDS.map(async (kind) => {
      const limit = kind === "aiCredits" ? aiLimit : plan ? (plan[PLAN_FIELD[kind]] ?? null) : null;
      const used = await usageFor(tenantId, kind, now);
      return { kind, label: LIMIT_LABEL[kind], used, limit, percent: percentUsed(used, limit), monthly: MONTHLY_KINDS.includes(kind) };
    }),
  );
}
