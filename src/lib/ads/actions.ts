import { randomUUID } from "node:crypto";
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getAssetAccess } from "@/lib/meta-connect";
import { sanitizeMessage } from "@/lib/safe-error";
import { noteBudgetWriteError, recordLowering, reserveAds, settleAds } from "@/lib/spend/book";
import { isSpendError } from "@/lib/spend/errors";
import { sandboxFlagFor } from "@/lib/spend/sandbox";
import type { AdsPermit, SpendActor } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { auditOutcome, auditStrict } from "./audit";
import { adsClient } from "./client";

/*
 * Single-object ads actions (docs/SPEND-CONTROLS-SPEC.md 4.8): the optimizer's proposals, their undo, the breakers and Eddy
 * use these. Each takes the actor who decided (a person, an assistant, a breaker or a system job).
 *
 * - pauseAd and pauseAdSet are lowering: recordLowering, never refused, work while spending is stopped.
 * - setAdSetBudget: a cut is lowering (recordLowering cut_budget); a raise goes through reserveAds raise_budget, so it is
 *   checked against the workspace's limits at Meta's worst case (1.75x a day). There is no clamping any more: a raise that
 *   does not fit is refused with the room that is left (SpendBlockedError carries `left` and `needs`), and the caller may
 *   retry with a smaller value. The other half of a zero-sum shift is named with shiftFromAdSetId, whose cut must already
 *   be applied.
 * - resumeAd goes through reserveAds resume_ad: turning an ad back on is a raise and can be refused.
 * The audit trail keeps its request row first and exactly one outcome row; the money record is the spend ledger.
 */

export type ActionResult = { revertPayload: Record<string, unknown> };

export type ActionOptions = {
  /** Plain-language why, for the spend ledger. */
  reason?: string;
  /** Reuse to make a retried raise return the same reservation. */
  idempotencyKey?: string;
  /** An approved SpendApproval being applied (7.3). */
  approvalId?: string;
};

export type BudgetOptions = ActionOptions & {
  /**
   * The ad set (its Meta id or its row id) whose budget was cut first in the same operation: the other half of a zero-sum
   * shift, or the previous step of an undo. That cut must already be applied; the book counts it as freed.
   */
  shiftFromAdSetId?: string;
};

const isAmbiguous = (e: unknown) => !!e && typeof e === "object" && (e as { ambiguous?: unknown }).ambiguous === true;
const userIdOf = (actor: SpendActor): string | null => (actor.type === "user" || actor.type === "platform_admin" ? actor.userId : actor.type === "api" ? (actor.userId ?? null) : null);
const sourceOf = (actor: SpendActor): string => (actor.type === "user" || actor.type === "platform_admin" ? "user" : actor.type === "breaker" ? "breaker" : "automation");
const failure = (e: unknown) => sanitizeMessage(e instanceof Error ? e.message : "request failed");

function checkActor(actor: SpendActor | undefined): asserts actor is SpendActor {
  if (!actor || typeof actor !== "object" || typeof actor.type !== "string") throw new HttpError(500, "An ads action needs the person or job that decided it.");
}

type AdRow = { id: string; tenantId: string; adSetId: string; metaAdId: string | null; status: string };
type SetRow = { id: string; tenantId: string; campaignId: string; metaAdSetId: string | null; name: string; status: string; dailyBudgetMinor: number | null };
type CampaignRow = { id: string; tenantId: string; adAccountAssetId: string; status: string; dailyBudgetMinor: number; currency: string; name: string };

async function campaignOf(tenantId: string, campaignId: string): Promise<CampaignRow> {
  const c = (await prisma.adCampaign.findFirst({ where: { id: campaignId, tenantId } })) as CampaignRow | null;
  if (!c) throw new HttpError(404, "Campaign not found.");
  return c;
}

async function loadAd(tenantId: string, metaAdId: string) {
  const ad = (await prisma.ad.findFirst({ where: { tenantId, metaAdId } })) as AdRow | null;
  if (!ad) throw new HttpError(404, "Ad not found.");
  const set = (await prisma.adSet.findFirst({ where: { id: ad.adSetId, tenantId } })) as SetRow | null;
  if (!set) throw new HttpError(404, "Ad not found.");
  return { ad, set, campaign: await campaignOf(tenantId, set.campaignId) };
}

async function loadAdSet(tenantId: string, metaAdSetId: string) {
  const set = (await prisma.adSet.findFirst({ where: { tenantId, metaAdSetId } })) as SetRow | null;
  if (!set) throw new HttpError(404, "Ad set not found.");
  return { set, campaign: await campaignOf(tenantId, set.campaignId) };
}

/** The guarded client for the campaign's ad account. */
async function clientFor(tenantId: string, adAccountAssetId: string, actor: SpendActor) {
  const access = await getAssetAccess(tenantId, adAccountAssetId);
  const sandbox = await sandboxFlagFor(tenantId, adAccountAssetId);
  return adsClient(access.token, access.externalId, { tenantId, adAccountAssetId, actor, sandbox });
}

/** Writes the ad set budget and keeps the campaign total (the sum of its ad sets) in step, reading the siblings fresh. */
async function writeBudget(tenantId: string, setId: string, campaignId: string, value: number) {
  await prisma.adSet.updateMany({ where: { id: setId, tenantId }, data: { dailyBudgetMinor: value } });
  const fresh = (await prisma.adCampaign.findFirst({ where: { id: campaignId, tenantId } })) as CampaignRow | null;
  const siblings = ((await prisma.adSet.findMany({ where: { tenantId, campaignId } })) ?? []) as SetRow[];
  const others = siblings.filter((s) => s.id !== setId).reduce((sum, s) => sum + (s.dailyBudgetMinor ?? fresh?.dailyBudgetMinor ?? 0), 0);
  await prisma.adCampaign.updateMany({ where: { id: campaignId, tenantId }, data: { dailyBudgetMinor: others + value } });
}

/** Pauses one ad on Meta (lowering, never refused) and marks it paused. Returns the payload needed to undo it. */
export async function pauseAd(tenantId: string, metaAdId: string, actor: SpendActor, opts: ActionOptions = {}): Promise<ActionResult> {
  checkActor(actor);
  const { ad, campaign } = await loadAd(tenantId, metaAdId);
  const previousStatus = ad.status;
  const client = await clientFor(tenantId, campaign.adAccountAssetId, actor);
  try {
    await recordLowering(tenantId, { kind: "pause", metaObjectId: metaAdId }, actor, opts.reason ?? "Paused an ad.", (permit) => client.setStatus(metaAdId, "PAUSED", permit), { objectLevel: "ad" });
  } catch (e) {
    throw new HttpError(502, `Could not pause the ad on Meta: ${failure(e)}`);
  }
  await prisma.ad.updateMany({ where: { id: ad.id, tenantId }, data: { status: "paused" } });
  await audit({ tenantId, userId: userIdOf(actor), action: "ads.ad.paused", target: ad.id, meta: { source: sourceOf(actor), previousStatus } });
  return { revertPayload: { action: "resume_ad", metaAdId, previousStatus } };
}

/** Pauses one ad set on Meta (lowering; breakers use it) and marks it paused. Returns the payload needed to undo it. */
export async function pauseAdSet(tenantId: string, metaAdSetId: string, actor: SpendActor, opts: ActionOptions = {}): Promise<ActionResult> {
  checkActor(actor);
  const { set, campaign } = await loadAdSet(tenantId, metaAdSetId);
  const previousStatus = set.status;
  const client = await clientFor(tenantId, campaign.adAccountAssetId, actor);
  try {
    await recordLowering(tenantId, { kind: "pause", metaObjectId: metaAdSetId }, actor, opts.reason ?? "Paused an ad set.", (permit) => client.setStatus(metaAdSetId, "PAUSED", permit), { objectLevel: "adset" });
  } catch (e) {
    throw new HttpError(502, `Could not pause the ad set on Meta: ${failure(e)}`);
  }
  await prisma.adSet.updateMany({ where: { id: set.id, tenantId }, data: { status: "paused" } });
  await audit({ tenantId, userId: userIdOf(actor), action: "ads.adset.paused", target: set.id, meta: { source: sourceOf(actor), previousStatus } });
  return { revertPayload: { action: "resume_adset", metaAdSetId, previousStatus } };
}

/** The row id of the ad set named by shiftFromAdSetId (its Meta id or its row id), in the same workspace. */
async function shiftSource(tenantId: string, ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  const row = ((await prisma.adSet.findFirst({ where: { tenantId, metaAdSetId: ref } })) ?? (await prisma.adSet.findFirst({ where: { tenantId, id: ref } }))) as SetRow | null;
  if (!row) throw new HttpError(404, "The ad set whose budget was cut first was not found.");
  return row.id;
}

/**
 * The daily budget the book counts this ad set at now: its open commitment's D. The AdSet row is written only by Edwyz's own
 * budget writes, while the syncs adopt Ads Manager edits into the commitment, so the row can be stale. Null when the ad set
 * has no open commitment of its own (paused, or its budget is at campaign level).
 */
async function committedDailyBudget(tenantId: string, metaAdSetId: string): Promise<number | null> {
  const c = (await prisma.spendCommitment.findFirst({
    where: { tenantId, metaObjectId: metaAdSetId, status: { in: ["reserved", "live", "unconfirmed"] } },
    select: { dailyBudgetMinor: true },
  })) as { dailyBudgetMinor?: bigint | number | null } | null;
  if (c?.dailyBudgetMinor === null || c?.dailyBudgetMinor === undefined) return null;
  const n = Number(c.dailyBudgetMinor);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Sets an ad set's daily budget (minor units). Raise or cut is decided against what the book counts (the open commitment's
 * daily budget), not the AdSet row, which can be stale after a change in Ads Manager. A cut is a lowering and always goes ahead. A raise is reserved in the Spend Book
 * BEFORE Meta is called, checked against the limits at Meta's worst case; a refusal says how much room is left. If Meta's answer
 * is ambiguous the raise stays counted (settled `unconfirmed`, the reconciler reads the truth) and the higher budget stays
 * recorded. The audit trail has a "budget_change_requested" row, then exactly one of "budget_changed", "budget_change_failed"
 * or "budget_change_unconfirmed". Returns the payload needed to undo it.
 */
export async function setAdSetBudget(
  tenantId: string,
  metaAdSetId: string,
  dailyBudgetMinor: number,
  actor: SpendActor,
  opts: BudgetOptions = {},
): Promise<ActionResult & { appliedDailyBudgetMinor: number; clamped: boolean }> {
  checkActor(actor);
  if (!Number.isInteger(dailyBudgetMinor) || dailyBudgetMinor <= 0) throw new HttpError(400, "The daily budget must be a positive whole number in minor units.");
  const { set, campaign } = await loadAdSet(tenantId, metaAdSetId);
  const previous = (await committedDailyBudget(tenantId, metaAdSetId)) ?? set.dailyBudgetMinor ?? campaign.dailyBudgetMinor;
  const done = (applied: number) => ({ revertPayload: { action: "set_adset_budget", metaAdSetId, dailyBudgetMinor: previous }, appliedDailyBudgetMinor: applied, clamped: false });
  // Nothing to change: no Meta call, so no budget change is used up.
  if (dailyBudgetMinor === previous) return done(previous);
  const raise = dailyBudgetMinor > previous;
  const meta = { source: sourceOf(actor), from: previous, to: dailyBudgetMinor, currency: campaign.currency };
  await auditStrict({ tenantId, userId: userIdOf(actor), action: "ads.adset.budget_change_requested", target: set.id, meta });
  const outcome = (suffix: "changed" | "change_failed" | "change_unconfirmed", extra: Record<string, string | number | boolean | null> = {}) =>
    auditOutcome({ tenantId, userId: userIdOf(actor), action: `ads.adset.budget_${suffix}`, target: set.id, meta: { ...meta, ...extra } });

  let client: ReturnType<typeof adsClient>;
  try {
    client = await clientFor(tenantId, campaign.adAccountAssetId, actor);
  } catch (e) {
    await outcome("change_failed", { reason: "connection" });
    throw e;
  }

  if (!raise) {
    try {
      await recordLowering(tenantId, { kind: "cut_budget", metaObjectId: metaAdSetId, toMinor: BigInt(dailyBudgetMinor) }, actor, opts.reason ?? "Lowered a daily budget.", (permit) => client.setDailyBudget(metaAdSetId, dailyBudgetMinor, permit), { objectLevel: "adset" });
    } catch (e) {
      await noteBudgetWriteError(tenantId, metaAdSetId, e).catch(() => false);
      await outcome("change_failed");
      throw new HttpError(502, `Could not change the budget on Meta: ${failure(e)}`);
    }
    await writeBudget(tenantId, set.id, campaign.id, dailyBudgetMinor);
    await outcome("changed");
    return done(dailyBudgetMinor);
  }

  let permit: AdsPermit;
  try {
    permit = await reserveAds(
      tenantId,
      { kind: "raise_budget", adSetId: set.id, metaAdSetId, toMinor: BigInt(dailyBudgetMinor), shiftFromAdSetId: await shiftSource(tenantId, opts.shiftFromAdSetId) },
      actor,
      { idempotencyKey: opts.idempotencyKey ?? `ads:raise:${metaAdSetId}:${dailyBudgetMinor}:${randomUUID()}`, reason: opts.reason ?? "Raised a daily budget.", approvalId: opts.approvalId },
    );
  } catch (e) {
    await outcome("change_failed", { reason: isSpendError(e) ? String((e as { code?: unknown }).code ?? "refused") : "refused" });
    throw e;
  }
  try {
    await client.setDailyBudget(metaAdSetId, dailyBudgetMinor, permit);
  } catch (e) {
    await noteBudgetWriteError(tenantId, metaAdSetId, e).catch(() => false);
    if (isAmbiguous(e)) {
      await settleAds(permit, "unconfirmed", { error: "ambiguous" });
      await writeBudget(tenantId, set.id, campaign.id, dailyBudgetMinor).catch(() => undefined);
      await outcome("change_unconfirmed");
      throw new HttpError(502, "Meta did not confirm the budget change and it may have gone through. The higher budget stays counted against your limits; check the ad set in Ads Manager.");
    }
    await settleAds(permit, "failed", { error: failure(e).slice(0, 80) });
    await outcome("change_failed");
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not change the budget on Meta: ${failure(e)}`);
  }
  await settleAds(permit, "applied");
  await writeBudget(tenantId, set.id, campaign.id, dailyBudgetMinor);
  await outcome("changed");
  return done(dailyBudgetMinor);
}

/**
 * Undoes pauseAd using the revertPayload it returned. Only resumes an ad that was active before; never starts an ad that was
 * not spending. Turning an ad back on is a raise: it is reserved in the Spend Book first and can be refused (limits, a stop,
 * a safety stop).
 */
export async function resumeAd(tenantId: string, metaAdId: string, nativeRevertPayload: Record<string, unknown>, actor: SpendActor, opts: ActionOptions = {}): Promise<ActionResult> {
  checkActor(actor);
  if (nativeRevertPayload?.action !== "resume_ad" || nativeRevertPayload.metaAdId !== metaAdId) throw new HttpError(400, "That is not a revert payload for this ad.");
  const { ad, campaign } = await loadAd(tenantId, metaAdId);
  if (nativeRevertPayload.previousStatus !== "active") return { revertPayload: { action: "pause_ad", metaAdId } };
  if (campaign.status !== "active") throw new HttpError(409, "The campaign is not active, so the ad was not resumed.");
  const userId = userIdOf(actor);
  await auditStrict({ tenantId, userId, action: "ads.ad.resume_requested", target: ad.id, meta: { source: sourceOf(actor) } });
  let permit: AdsPermit;
  try {
    permit = await reserveAds(tenantId, { kind: "resume_ad", adId: ad.id, metaAdId }, actor, {
      idempotencyKey: opts.idempotencyKey ?? `ads:resume_ad:${metaAdId}:${randomUUID()}`,
      reason: opts.reason ?? "Turned an ad back on.",
      approvalId: opts.approvalId,
    });
  } catch (e) {
    await auditOutcome({ tenantId, userId, action: "ads.ad.resume_failed", target: ad.id, meta: { source: sourceOf(actor), reason: "refused" } });
    throw e;
  }
  try {
    const client = await clientFor(tenantId, campaign.adAccountAssetId, actor);
    await client.setStatus(metaAdId, "ACTIVE", permit);
  } catch (e) {
    if (isAmbiguous(e)) {
      await settleAds(permit, "unconfirmed", { error: "ambiguous" });
      await auditOutcome({ tenantId, userId, action: "ads.ad.resume_unconfirmed", target: ad.id, meta: { source: sourceOf(actor) } });
      throw new HttpError(502, "Meta did not confirm that the ad is back on, and it may be running. It stays counted against your limits; check it in Ads Manager.");
    }
    await settleAds(permit, "failed", { error: failure(e).slice(0, 80) });
    await auditOutcome({ tenantId, userId, action: "ads.ad.resume_failed", target: ad.id, meta: { source: sourceOf(actor) } });
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not resume the ad on Meta: ${failure(e)}`);
  }
  await settleAds(permit, "applied");
  await prisma.ad.updateMany({ where: { id: ad.id, tenantId }, data: { status: "active" } });
  await auditOutcome({ tenantId, userId, action: "ads.ad.resumed", target: ad.id, meta: { source: sourceOf(actor) } });
  return { revertPayload: { action: "pause_ad", metaAdId } };
}
