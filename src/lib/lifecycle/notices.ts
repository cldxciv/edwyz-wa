import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { numberQualityDroppedTemplate, paymentFailedTemplate, trialEndedTemplate, trialEndingTemplate } from "@/lib/email/templates";
import { getSettings } from "@/lib/platform-settings";
import { emailOwners, onceWithRetry, readState, writeState } from "./state";

const DAY = 24 * 60 * 60 * 1000;
export const BATCH = 100;
/** Trials that ended longer ago than this get no "ended" mail (avoids mailing old trials when the feature first runs). */
const ENDED_LOOKBACK_DAYS = 7;

export type TrialKind = "trial3" | "trial1" | "trialEnded";

export function trialKind(trialEndsAt: Date, now: number): TrialKind | null {
  const left = trialEndsAt.getTime() - now;
  if (left <= 0) return left > -ENDED_LOOKBACK_DAYS * DAY ? "trialEnded" : null;
  if (left <= DAY) return "trial1";
  if (left <= 3 * DAY) return "trial3";
  return null;
}

/** A safety cap: 100 pages of BATCH workspaces is far more trials than can sit in a 10-day window. */
const MAX_TRIAL_PAGES = 100;

/**
 * The marker names the trial end it belongs to, so a trial that an admin extends gets its 3 day, 1 day and ended mails again for the
 * new date. A marker written before the end date was part of the key is honoured only when it was written inside this trial's reminder
 * window (so a deploy does not mail workspaces twice, while an extended trial is not blocked by the old marker).
 */
async function alreadyMailed(kind: TrialKind, tenantId: string, trialEndsAt: Date): Promise<boolean> {
  const legacy = await readState<{ at?: string }>(`lifecycle:${kind}:${tenantId}`).catch(() => null);
  const at = legacy?.at ? Date.parse(legacy.at) : NaN;
  return Number.isFinite(at) && at >= trialEndsAt.getTime() - 3 * DAY;
}

export async function runTrialReminders(now = Date.now()): Promise<number> {
  const where: Prisma.TenantWhereInput = {
    deletedAt: null,
    status: "active",
    billingExempt: false,
    trialEndsAt: { gt: new Date(now - ENDED_LOOKBACK_DAYS * DAY), lte: new Date(now + 3 * DAY) },
    OR: [{ subscription: null }, { subscription: { status: { in: ["canceled", "expired"] } } }],
  };
  let sent = 0;
  let after: string | undefined;
  // Walk every page by id: a fixed "first 100" would starve newer trials once 100 already-mailed workspaces sit in the window.
  for (let page = 0; page < MAX_TRIAL_PAGES; page++) {
    const tenants = await prisma.tenant.findMany({
      where: after ? { ...where, id: { gt: after } } : where,
      select: { id: true, name: true, trialEndsAt: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    for (const t of tenants) {
      const kind = t.trialEndsAt ? trialKind(t.trialEndsAt, now) : null;
      if (!kind || !t.trialEndsAt) continue;
      try {
        if (await alreadyMailed(kind, t.id, t.trialEndsAt)) continue;
        sent += await onceWithRetry(`lifecycle:${kind}:${t.id}:${t.trialEndsAt.getTime()}`, () =>
          emailOwners(t.id, () =>
            kind === "trialEnded" ? trialEndedTemplate({ workspaceName: t.name }) : trialEndingTemplate({ workspaceName: t.name, daysLeft: kind === "trial1" ? 1 : 3 }),
          ),
        );
      } catch {
        // One workspace's failure must not stop the others; the marker was given back, so the next sweep tries again.
        console.warn("[lifecycle] a trial reminder failed and will be retried");
      }
    }
    if (tenants.length < BATCH) break;
    after = tenants[tenants.length - 1].id;
  }
  return sent;
}

/**
 * Mails the owners once per failure (the failure is identified by when the workspace became past due). Called by the payment webhook the
 * moment Razorpay reports the failed charge, and again by the hourly sweep as a safety net; the one-time marker makes the second call a no-op.
 */
export async function sendPaymentFailedNotice(input: { tenantId: string; workspaceName: string; pastDueSince: Date; graceDays: number }, now = Date.now()): Promise<number> {
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { status: true, deletedAt: true } });
  if (tenant && (tenant.deletedAt || tenant.status === "suspended")) return 0;
  const used = Math.floor((now - input.pastDueSince.getTime()) / DAY);
  const graceDaysLeft = Math.max(0, input.graceDays - used);
  return onceWithRetry(`lifecycle:pastdue:${input.tenantId}:${input.pastDueSince.getTime()}`, () =>
    emailOwners(input.tenantId, () => paymentFailedTemplate({ workspaceName: input.workspaceName, graceDaysLeft })),
  );
}

export async function runPaymentFailedNotices(now = Date.now()): Promise<number> {
  const [subs, settings] = await Promise.all([
    prisma.subscription.findMany({
      where: { status: "past_due", pastDueSince: { not: null }, tenant: { deletedAt: null } },
      select: { tenantId: true, pastDueSince: true, tenant: { select: { name: true } } },
      orderBy: { pastDueSince: "desc" },
      take: BATCH,
    }),
    getSettings(),
  ]);
  let sent = 0;
  for (const s of subs) {
    if (!s.pastDueSince) continue;
    sent += await sendPaymentFailedNotice({ tenantId: s.tenantId, workspaceName: s.tenant.name, pastDueSince: s.pastDueSince, graceDays: settings.graceDays }, now);
  }
  return sent;
}

const QUALITY_RANK: Record<string, number> = { RED: 1, YELLOW: 2, GREEN: 3 };
/** Meta's older names for the same ratings (the 30-minute quality poll, spend/messaging/quality.ts, stores the new ones). */
const QUALITY_ALIASES: Record<string, string> = { HIGH: "GREEN", MEDIUM: "YELLOW", LOW: "RED" };
const QUALITY_PAGE = 500;
/** A safety cap on one sweep: 40 pages of numbers. */
const QUALITY_MAX_PAGES = 40;

/** The rating as GREEN, YELLOW or RED, or "" for UNKNOWN, NA or nothing (no mail on missing data). */
export function qualityLevel(rating: string | null | undefined): string {
  const v = (rating ?? "").trim().toUpperCase();
  const level = QUALITY_ALIASES[v] ?? v;
  return level in QUALITY_RANK ? level : "";
}

/**
 * Mails the owners when a number's quality rating drops. The rating is refreshed every 30 minutes by the spend controls' quality
 * poll (docs/SPEND-CONTROLS-SPEC.md 6.3), because Meta's quality webhook no longer carries it; this sweep reads that fresh value.
 * Every number is checked, page by page.
 */
export async function runQualityAlerts(): Promise<number> {
  let alerts = 0;
  let after: string | undefined;
  for (let page = 0; page < QUALITY_MAX_PAGES; page++) {
    const numbers = await prisma.phoneNumber.findMany({
      where: { qualityRating: { not: null }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, tenantId: true, displayPhone: true, qualityRating: true },
      orderBy: { id: "asc" },
      take: QUALITY_PAGE,
    });
    alerts += await qualityAlertsFor(numbers);
    if (numbers.length < QUALITY_PAGE) break;
    after = numbers[numbers.length - 1].id;
  }
  return alerts;
}

async function qualityAlertsFor(numbers: { id: string; tenantId: string; displayPhone: string; qualityRating: string | null }[]): Promise<number> {
  if (numbers.length === 0) return 0;
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: [...new Set(numbers.map((n) => n.tenantId))] }, deletedAt: null, status: "active" },
    select: { id: true, name: true },
  });
  const names = new Map(tenants.map((t) => [t.id, t.name]));
  let alerts = 0;
  for (const n of numbers) {
    if (!names.has(n.tenantId)) continue; // suspended or deleted workspace: no lifecycle mail
    const current = qualityLevel(n.qualityRating);
    if (!current) continue;
    const key = `lifecycle:quality:${n.id}`;
    const last = await readState<{ rating: string }>(key);
    if (last?.rating === current) continue;
    if (last && QUALITY_RANK[current] < (QUALITY_RANK[last.rating] ?? 0)) {
      // A drop: the new rating is remembered only once the owners were mailed, so a failed or ownerless send is tried again next sweep.
      try {
        const queued = await emailOwners(n.tenantId, () =>
          numberQualityDroppedTemplate({ workspaceName: names.get(n.tenantId) ?? "your workspace", displayPhone: n.displayPhone, from: last.rating, to: current }),
        );
        if (queued === 0) continue;
        alerts += queued;
      } catch {
        console.warn("[lifecycle] a quality alert could not be queued and will be retried");
        continue;
      }
    }
    await writeState(key, { rating: current });
  }
  return alerts;
}
