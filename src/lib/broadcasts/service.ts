import type { Prisma } from "@/generated/prisma/client";
import { getRateCard } from "@/lib/admin/ratecard";
import { assertWithinLimit } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";
import { resolveFilters } from "@/lib/segments/service";
import { parseFilter } from "@/lib/segments/filter";
import { SpendBlockedError } from "@/lib/spend/errors";
import { spendEnforceMode } from "@/lib/spend/flags";
import { spendState } from "@/lib/spend/kill";
import type { FreezeState, SpendActor } from "@/lib/spend/types";
import { countAudience, freezeAudience, isFixedAudience, specFromJson } from "./audience";
import { audienceContacts, audiencePhones } from "./audience-data";
import { broadcastSupportReason } from "./components";
import {
  type BulkHold,
  broadcastLimitError,
  bulkEstimateMinor,
  countByCountry,
  estimateBreakdown,
  estimateBroadcastHold,
  fitsRoom,
  holdBroadcastFor,
  messagingRoom,
  releaseBulkFor,
  releaseBulkHold,
  SCHEDULE_WARNING,
} from "./cost";
import { type MissingValuePolicy, type VariableMap, countMissing, parsePolicy, parseVariableMap } from "./mapping";
import { BROADCAST_QUEUE, enqueueBroadcastRun } from "./jobs";
import { assertMediaReady, assertUploadsFit, mediaWakeAt } from "./media";
import { clearPauseReason, pauseReasonKey, readPauseReason } from "./pause";
import { portfolioUsage } from "./portfolio";
import { assertValidSchedule, parseRetryDays } from "./schedule";
import { daysToReach, nextStep, scalingHint, topTier } from "./throttle";

export { BROADCAST_QUEUE, pauseReasonKey };

export type CreateBroadcastInput = {
  name: string;
  phoneNumberId: string;
  templateId: string;
  segmentTags?: string[];
  scheduledAt?: Date | null;
  retryDays?: number;
  /** Saved or preset segment id and/or a filter stack, added to the tags. */
  audience?: { segmentId?: string; filter?: unknown } | null;
  variableMap?: unknown;
  missingValuePolicy?: unknown;
  /** Set by follow-ups: the recipients are copied from this broadcast and never recomputed from tags or filters. */
  fixedFrom?: string;
  /** Which people a follow-up reaches ("unsent" retries what the source has not delivered). Stored so starting it can settle the source. */
  fixedOutcome?: string;
};

function audienceJson(audience: CreateBroadcastInput["audience"]): Prisma.InputJsonObject | undefined {
  if (!audience) return undefined;
  const out: Record<string, unknown> = {};
  if (audience.segmentId) {
    if (typeof audience.segmentId !== "string" || audience.segmentId.length > 100) throw new HttpError(400, "The segment is not valid.");
    out.segmentId = audience.segmentId;
  }
  const filter = parseFilter(audience.filter);
  if (filter.all?.length || filter.any?.length) out.filter = filter;
  return Object.keys(out).length ? (out as Prisma.InputJsonObject) : undefined;
}

/**
 * A template a broadcast may use: approved, or flagged by Meta when it is not marketing (docs/SPEND-CONTROLS-SPEC.md 6.3:
 * marketing broadcasts may not use a flagged template, other senders may continue).
 */
export function usableForBroadcast(template: { status: string; category?: string | null }): boolean {
  if (template.status === "approved") return true;
  return template.status === "flagged" && String(template.category ?? "").toUpperCase() !== "MARKETING";
}

const FLAGGED_MARKETING = "Meta flagged this template for low quality, so marketing broadcasts can't use it for now. Try again once Meta clears it, or choose another approved template.";

/** The spend controls' actor for a person's broadcast action. */
const spendActorOf = (actor: Actor): SpendActor => ({ type: "user", userId: actor.userId, role: actor.role });

export async function createBroadcast(actor: Actor, input: CreateBroadcastInput) {
  const [template, phone] = await Promise.all([
    prisma.template.findFirst({ where: { id: input.templateId, tenantId: actor.tenantId } }),
    prisma.phoneNumber.findFirst({ where: { id: input.phoneNumberId, tenantId: actor.tenantId } }),
  ]);
  if (!template) throw new HttpError(404, "Template not found.");
  if (!phone) throw new HttpError(404, "Phone number not found.");
  if (template.status === "flagged" && !usableForBroadcast(template)) throw new HttpError(400, FLAGGED_MARKETING);
  if (!usableForBroadcast(template)) throw new HttpError(400, "Only approved templates can be broadcast.");
  if (template.wabaRefId !== phone.wabaRefId) throw new HttpError(400, "Template and phone number belong to different accounts.");
  const unsupported = broadcastSupportReason(template.components);
  if (unsupported) throw new HttpError(400, unsupported);
  if (input.scheduledAt) assertValidSchedule(input.scheduledAt);
  const retryDays = parseRetryDays(input.retryDays);
  const policy = parsePolicy(input.missingValuePolicy);
  const variableMap = parseVariableMap(input.variableMap, template.components, policy);
  assertUploadsFit(variableMap, phone.id);
  const audienceFilter = input.fixedFrom ? ({ fixed: true, sourceBroadcastId: input.fixedFrom, ...(input.fixedOutcome ? { outcome: input.fixedOutcome } : {}) } as Prisma.InputJsonObject) : audienceJson(input.audience);
  if (audienceFilter && !input.fixedFrom) await resolveFilters(actor.tenantId, specFromJson(audienceFilter));

  return prisma.broadcast.create({
    data: {
      tenantId: actor.tenantId,
      phoneNumberId: phone.id,
      templateId: template.id,
      name: input.name,
      segmentTags: input.segmentTags ?? [],
      scheduledAt: input.scheduledAt ?? null,
      retryDays,
      missingValuePolicy: policy,
      ...(audienceFilter ? { audienceFilter } : {}),
      ...(variableMap ? { variableMap: variableMap as unknown as Prisma.InputJsonObject } : {}),
      createdByUserId: actor.userId,
    },
  });
}

export async function ownedBroadcast(actor: Actor, id: string) {
  const broadcast = await prisma.broadcast.findFirst({ where: { id, tenantId: actor.tenantId }, include: { template: true } });
  if (!broadcast) throw new HttpError(404, "Broadcast not found.");
  return broadcast;
}

const policyOf = (raw: unknown): MissingValuePolicy => (raw === "fallback" || raw === "fail" ? raw : "skip");
const mapOf = (raw: unknown): VariableMap | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as VariableMap) : null);

type AudienceRef = { id: string; tenantId: string; segmentTags: string[]; audienceFilter: unknown };

async function costFor(b: AudienceRef & { template: { category: string } }) {
  const [phones, card] = await Promise.all([audiencePhones(b), getRateCard()]);
  return estimateBreakdown({ category: b.template.category, countries: countByCountry(phones), card });
}

type Cost = Awaited<ReturnType<typeof costFor>>;

/** The column holds paise, so it is filled only when the admin's rate card is in INR and every recipient has a price. */
const storedEstimate = (cost: Cost | null): number | null => (cost && cost.configured && cost.currency === "INR" && cost.unpricedCount === 0 ? cost.totalMinor : null);

const fixedInfo = (raw: unknown): { sourceId: string | null; outcome: string | null } => {
  const f = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { sourceBroadcastId?: unknown; outcome?: unknown };
  return { sourceId: typeof f.sourceBroadcastId === "string" ? f.sourceBroadcastId : null, outcome: typeof f.outcome === "string" ? f.outcome : null };
};

/**
 * A retry of "everyone not messaged yet" replaces the rest of its source broadcast. That happens here, when the person actually sends
 * the new draft, not when the draft is created: a draft that is never sent must not cost anyone their message. The source has to be paused
 * (so nothing is sending) and is then canceled; anyone the source reached since the draft was made is dropped from the draft.
 */
async function settleRetrySource(actor: Actor, draft: { id: string; audienceFilter: unknown }) {
  const { sourceId, outcome } = fixedInfo(draft.audienceFilter);
  if (!sourceId || outcome !== "unsent") return;
  const source = await prisma.broadcast.findFirst({ where: { id: sourceId, tenantId: actor.tenantId }, select: { id: true, status: true } });
  if (!source) return;
  if (source.status === "sending" || source.status === "scheduled") {
    throw new HttpError(409, "The broadcast this retry is for is still running. Pause it first, so nobody receives two messages.");
  }
  await prisma.broadcastRecipient.updateMany({
    where: {
      tenantId: actor.tenantId,
      broadcastId: draft.id,
      status: "pending",
      contact: { broadcastRecipients: { some: { tenantId: actor.tenantId, broadcastId: source.id, status: { in: ["queued", "sent", "delivered", "read"] } } } },
    },
    data: { status: "skipped", errorCode: "already_sent" },
  });
  if (source.status === "paused") await cancelBroadcast(actor, source.id);
}

/** Freeze state for the start check; null when it cannot be read (the send gate still holds every message under a stop). */
async function readFreeze(tenantId: string): Promise<FreezeState | null> {
  try {
    return await spendState(tenantId);
  } catch (error) {
    console.warn("[broadcast] could not read whether spending is stopped:", (error as Error)?.message ?? "error");
    return null;
  }
}

type HoldRef = { id: string; tenantId: string; name: string; phoneNumberId: string; template: { category?: string | null } };

/**
 * The scheduler's dry run (docs/SPEND-CONTROLS-SPEC.md 4.9): the hold is taken when the broadcast is due, because the audience
 * and the limit can change before then. Null when it fits, cannot be priced, or the limit only observes (SPEND_ENFORCE=observe).
 */
async function scheduleWarning(b: HoldRef): Promise<string | null> {
  if (spendEnforceMode() !== "enforce") return null;
  try {
    const card = await getRateCard();
    const est = await estimateBroadcastHold(b, card);
    if (!est || est.estimateMinor <= 0n) return null;
    const room = await messagingRoom(b.tenantId, est.currency);
    return fitsRoom(room, est.estimateMinor).fits ? null : SCHEDULE_WARNING;
  } catch (error) {
    console.warn("[broadcast] could not check a scheduled broadcast against the WhatsApp limit:", (error as Error)?.message ?? "error");
    return null;
  }
}

const NOT_STARTED = "The broadcast did not start, so what was set aside for it went back to your WhatsApp limit.";

export async function startBroadcast(actor: Actor, id: string) {
  const broadcast = await ownedBroadcast(actor, id);
  if (!["draft", "scheduled", "paused"].includes(broadcast.status)) {
    throw new HttpError(409, `A ${broadcast.status} broadcast cannot be started.`);
  }
  if (broadcast.template.status === "flagged" && !usableForBroadcast(broadcast.template)) throw new HttpError(409, FLAGGED_MARKETING);
  if (!usableForBroadcast(broadcast.template)) throw new HttpError(409, "The template is no longer approved.");

  const tenantId = actor.tenantId;
  const resuming = broadcast.status === "paused";
  const spec = specFromJson(broadcast.audienceFilter);
  const fixed = isFixedAudience(broadcast.audienceFilter);
  const existing = () => prisma.broadcastRecipient.count({ where: { tenantId, broadcastId: broadcast.id } });
  const later = !broadcast.startedAt && broadcast.scheduledAt && broadcast.scheduledAt.getTime() > Date.now();

  // A broadcast is an automatic send: while spending is stopped it cannot start now (4.9, freeze "all"). Scheduling is still
  // allowed; a scheduled broadcast pauses when it is due if spending is still stopped (process.ts).
  if (!later) {
    const freeze = await readFreeze(tenantId);
    if (freeze?.platform === "all") throw new SpendBlockedError("spend.platform_frozen");
    if (freeze?.workspace === "all") throw new SpendBlockedError("spend.frozen");
  }

  // The audience is frozen the first time a broadcast starts. Resuming never looks at today's contacts again: people who matched
  // the filter after the first start are not added, and the plan limit was already checked.
  let total: number;
  const froze = !(fixed || resuming);
  if (!froze) {
    total = await existing();
  } else {
    // The whole audience is what this start adds, so the broadcast's own waiting messages (frozen when it was scheduled) are left
    // out of the month's use: "Send now" on a scheduled broadcast must not count them twice.
    await assertWithinLimit(tenantId, "broadcastContacts", await countAudience(tenantId, broadcast.segmentTags, spec), { excludeBroadcastId: broadcast.id });
    total = await freezeAudience(tenantId, broadcast.id, broadcast.segmentTags, spec);
  }
  if (total === 0) throw new HttpError(400, "No opted-in contacts match this audience.");
  // A start that is refused leaves a draft as it was: the next start freezes today's audience again.
  const unfreeze = async () => {
    if (froze) await prisma.broadcastRecipient.deleteMany({ where: { tenantId, broadcastId: broadcast.id, status: "pending" } });
  };

  // An uploaded header file must still be alive at WhatsApp (it is uploaded again here when it is getting old).
  try {
    await assertMediaReady(broadcast);
  } catch (error) {
    await unfreeze();
    throw error;
  }

  // Checked on every start, resumes included: a broadcast that paused for a missing value must not restart until the data is fixed.
  if (policyOf(broadcast.missingValuePolicy) === "fail") {
    const { contacts } = await audienceContacts({ id: broadcast.id, tenantId, segmentTags: broadcast.segmentTags, audienceFilter: broadcast.audienceFilter });
    const { contactsMissing } = countMissing(broadcast.template.components, contacts, mapOf(broadcast.variableMap), "fail");
    if (contactsMissing > 0) {
      await unfreeze();
      const who = contactsMissing === 1 ? "contact has" : "contacts have";
      throw new HttpError(409, `${contactsMissing.toLocaleString()} ${who} no value for a placeholder, and this broadcast is set to stop in that case. Fix those contacts, or choose to skip them instead.`);
    }
  }

  // The WhatsApp limit (4.9 bulk gate). Starting now holds the conservative estimate of everyone still pending, for 7 days,
  // BEFORE anything changes; when it does not fit the start is refused with 409 and nothing is queued. Scheduling only warns
  // (a dry run): the hold is taken when it is due. A resume reuses the hold it still has.
  let hold: BulkHold | null = null;
  let spendWarning: string | null = null;
  const holdRef: HoldRef = { id: broadcast.id, tenantId, name: broadcast.name, phoneNumberId: broadcast.phoneNumberId, template: broadcast.template };
  if (later) {
    spendWarning = await scheduleWarning(holdRef);
  } else {
    try {
      hold = await holdBroadcastFor(holdRef, spendActorOf(actor));
    } catch (error) {
      if (error instanceof SpendBlockedError) await unfreeze();
      throw error;
    }
  }
  const giveBack = () => releaseBulkHold(hold?.created ? hold.reservationId : null, NOT_STARTED, spendActorOf(actor));

  if (!resuming) {
    try {
      await settleRetrySource(actor, broadcast);
    } catch (error) {
      await giveBack();
      throw error;
    }
  }

  const runAt = later ? broadcast.scheduledAt! : new Date();
  const ref = { id: broadcast.id, tenantId, segmentTags: broadcast.segmentTags, audienceFilter: broadcast.audienceFilter, template: broadcast.template };
  const cost = await costFor(ref).catch(() => null);
  // The status in the where clause makes the start a single step: of two near-simultaneous starts (a double click, or a resume
  // racing a pause) only one wins and queues the worker; the other is told the broadcast has already changed.
  let updated;
  try {
    updated = await prisma.broadcast.update({
      where: { id: broadcast.id, tenantId, status: broadcast.status },
      data: {
        status: later ? "scheduled" : "sending",
        startedAt: later ? undefined : (broadcast.startedAt ?? new Date()),
        estimatedCostPaise: storedEstimate(cost),
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2025") {
      // A start racing this one may be using the same hold (one open hold per broadcast): give it back only if nobody started it.
      const current = await prisma.broadcast.findFirst({ where: { id: broadcast.id, tenantId }, select: { status: true } }).catch(() => null);
      if (!current || !["sending", "scheduled"].includes(current.status)) await giveBack();
      throw new HttpError(409, "This broadcast was just changed. Refresh the page to see where it is now.");
    }
    await giveBack();
    throw error;
  }
  if (resuming) await clearPauseReason(broadcast.id);
  // A scheduled broadcast with an uploaded file wakes before it is due to keep the file alive at WhatsApp (process.ts).
  const wake = later ? mediaWakeAt(broadcast.variableMap, new Date()) : null;
  await enqueueBroadcastRun(broadcast.id, wake && wake < runAt ? wake : runAt);
  return { ...updated, spendWarning };
}

/**
 * Removes a draft that never started (no recipients), for example the one the wizard made before the person went back and changed
 * a step, so it does not stay in the list as canceled. Anything that started is canceled instead, to keep its report.
 */
export async function deleteDraftBroadcast(actor: Actor, id: string): Promise<void> {
  const broadcast = await ownedBroadcast(actor, id);
  if (broadcast.status !== "draft") throw new HttpError(409, `A ${broadcast.status} broadcast cannot be deleted. Cancel it instead.`);
  const recipients = await prisma.broadcastRecipient.count({ where: { tenantId: actor.tenantId, broadcastId: broadcast.id } });
  if (recipients > 0) throw new HttpError(409, "This broadcast already has people in it. Cancel it instead.");
  const { count } = await prisma.broadcast.deleteMany({ where: { id: broadcast.id, tenantId: actor.tenantId, status: "draft" } });
  if (count === 0) throw new HttpError(409, "This broadcast was just changed. Refresh the page to see where it is now.");
}

export async function pauseBroadcast(actor: Actor, id: string) {
  const broadcast = await ownedBroadcast(actor, id);
  if (broadcast.status !== "sending" && broadcast.status !== "scheduled") {
    throw new HttpError(409, `A ${broadcast.status} broadcast cannot be paused.`);
  }
  const updated = await prisma.broadcast.update({ where: { id: broadcast.id, tenantId: actor.tenantId }, data: { status: "paused" } });
  await enqueueBroadcastRun(broadcast.id, new Date(Date.now() + 30_000));
  return updated;
}

export async function cancelBroadcast(actor: Actor, id: string) {
  const broadcast = await ownedBroadcast(actor, id);
  if (["completed", "canceled", "failed"].includes(broadcast.status)) {
    throw new HttpError(409, `A ${broadcast.status} broadcast cannot be canceled.`);
  }
  await prisma.broadcastRecipient.updateMany({
    where: { tenantId: actor.tenantId, broadcastId: broadcast.id, status: "pending" },
    data: { status: "skipped" },
  });
  await prisma.broadcastRecipient.updateMany({
    where: { tenantId: actor.tenantId, broadcastId: broadcast.id, status: "failed", retryAfter: { not: null } },
    data: { retryAfter: null },
  });
  const updated = await prisma.broadcast.update({ where: { id: broadcast.id, tenantId: actor.tenantId }, data: { status: "canceled", completedAt: new Date() } });
  // What the broadcast did not use goes back to the WhatsApp limit at once (4.9). Messages already queued fall back to their own reservation.
  await releaseBulkFor(actor.tenantId, { type: "broadcast", id: broadcast.id }, `Broadcast "${broadcast.name}" was canceled, so what it did not use went back to your WhatsApp limit.`, spendActorOf(actor));
  await enqueueBroadcastRun(broadcast.id, new Date(Date.now() + 30_000));
  return updated;
}

export async function listBroadcasts(actor: Actor, query: { cursor?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const cursor = query.cursor && (await prisma.broadcast.findFirst({ where: { id: query.cursor, tenantId: actor.tenantId }, select: { id: true } })) ? query.cursor : undefined;
  const rows = await prisma.broadcast.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const groups = page.length
    ? await prisma.broadcastRecipient.groupBy({
        by: ["broadcastId", "status"],
        where: { tenantId: actor.tenantId, broadcastId: { in: page.map((b) => b.id) } },
        _count: { _all: true },
      })
    : [];
  const items = page.map((b) => {
    const counts: Record<string, number> = {};
    for (const g of groups) if (g.broadcastId === b.id) counts[g.status] = g._count._all;
    return { ...b, counts };
  });
  return { items, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/** Why recipients did not get the message: failure and skip codes with how many people each affected. */
async function failureSummary(tenantId: string, broadcastId: string): Promise<{ code: string; status: string; count: number }[]> {
  try {
    const rows = await prisma.broadcastRecipient.groupBy({
      by: ["errorCode", "status"],
      where: { tenantId, broadcastId, status: { in: ["failed", "skipped"] }, errorCode: { not: null } },
      _count: { _all: true },
    });
    return rows.map((r) => ({ code: r.errorCode as string, status: r.status, count: r._count._all })).sort((a, b) => b.count - a.count);
  } catch {
    return [];
  }
}

export async function getBroadcast(actor: Actor, id: string, query: { cursor?: string; limit?: number } = {}) {
  const broadcast = await ownedBroadcast(actor, id);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const cursor = query.cursor && (await prisma.broadcastRecipient.findFirst({ where: { id: query.cursor, tenantId: actor.tenantId, broadcastId: id }, select: { id: true } })) ? query.cursor : undefined;
  const [groups, rows, pauseReason, failures] = await Promise.all([
    prisma.broadcastRecipient.groupBy({ by: ["status"], where: { tenantId: actor.tenantId, broadcastId: id }, _count: { _all: true } }),
    prisma.broadcastRecipient.findMany({
      where: { tenantId: actor.tenantId, broadcastId: id },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { contact: { select: { phone: true, name: true, bsuid: true, username: true } } },
    }),
    broadcast.status === "paused" ? readPauseReason(id) : Promise.resolve(null),
    cursor ? Promise.resolve([]) : failureSummary(actor.tenantId, id),
  ]);
  const counts: Record<string, number> = {};
  for (const g of groups) counts[g.status] = g._count._all;
  const n = (s: string) => counts[s] ?? 0;
  const hasMore = rows.length > limit;
  const recipients = hasMore ? rows.slice(0, limit) : rows;
  return {
    broadcast,
    counts,
    report: {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      sent: n("sent") + n("delivered") + n("read"),
      delivered: n("delivered") + n("read"),
      read: n("read"),
      failed: n("failed"),
      skipped: n("skipped"),
    },
    pauseReason,
    failures,
    recipients,
    nextCursor: hasMore ? recipients[recipients.length - 1].id : null,
  };
}

/** Pre-send estimate: audience size, cost by country from the admin's rate card, value coverage and how long the daily limit allows. */
export async function estimateBroadcast(actor: Actor, id: string) {
  const broadcast = await ownedBroadcast(actor, id);
  const tenantId = actor.tenantId;
  const ref = { id: broadcast.id, tenantId, segmentTags: broadcast.segmentTags, audienceFilter: broadcast.audienceFilter };
  const frozen = await prisma.broadcastRecipient.count({ where: { tenantId, broadcastId: id } });
  const count = frozen || (await countAudience(tenantId, broadcast.segmentTags, specFromJson(broadcast.audienceFilter)));
  const policy = policyOf(broadcast.missingValuePolicy);
  const [cost, sample, phone] = await Promise.all([
    costFor({ ...ref, template: broadcast.template }),
    audienceContacts(ref),
    prisma.phoneNumber.findFirst({ where: { id: broadcast.phoneNumberId, tenantId }, select: { wabaRefId: true, messagingLimitTier: true } }),
  ]);
  const coverage = { ...countMissing(broadcast.template.components, sample.contacts, mapOf(broadcast.variableMap), policy), checked: sample.contacts.length, total: sample.total, policy };
  const usage = phone ? await portfolioUsage(tenantId, phone.wabaRefId, new Date()).catch(() => null) : null;
  // The hint and the next step describe the portfolio's level (the highest any of its numbers reports), the same one the limit uses.
  const portfolio = (usage ? topTier(usage.phones) : null) ?? phone?.messagingLimitTier;
  const sending = usage
    ? { limit: usage.limit === Infinity ? null : usage.limit, used: usage.used, days: daysToReach(count, usage.limit, usage.used), hint: scalingHint(portfolio), nextStep: nextStep(portfolio) }
    : null;
  const label = cost.configured ? undefined : "rate card not configured";
  const legacy = cost.configured ? { totalPaise: cost.totalMinor } : {};
  const limitWarning = await limitWarningFor({ ...broadcast, tenantId }, frozen === 0);
  return { count, category: broadcast.template.category, cost: { ...cost, ...legacy }, coverage, sending, label, limitWarning };
}

/**
 * What the review step says when the broadcast will not fit the WhatsApp limit (4.9): the 409 sentence for a send now, the
 * dry-run warning for a scheduled one. Null when it fits, cannot be priced, or the limit only observes. Before the audience is
 * frozen the estimate covers today's matching contacts.
 */
async function limitWarningFor(
  b: HoldRef & { segmentTags: string[]; audienceFilter: unknown; scheduledAt: Date | null; startedAt: Date | null },
  unfrozen: boolean,
): Promise<string | null> {
  if (spendEnforceMode() !== "enforce") return null;
  try {
    const card = await getRateCard();
    if (!card) return null;
    const estimateMinor = unfrozen
      ? bulkEstimateMinor({ category: b.template.category ?? "MARKETING", countries: countByCountry(await audiencePhones(b)), card })
      : ((await estimateBroadcastHold(b, card))?.estimateMinor ?? null);
    if (estimateMinor === null || estimateMinor <= 0n) return null;
    const fit = fitsRoom(await messagingRoom(b.tenantId, card.currency), estimateMinor);
    if (fit.fits) return null;
    const later = !b.startedAt && b.scheduledAt && b.scheduledAt.getTime() > Date.now();
    return later ? SCHEDULE_WARNING : broadcastLimitError(estimateMinor, fit, card.currency).message;
  } catch {
    return null;
  }
}
