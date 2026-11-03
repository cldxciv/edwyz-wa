import { campaignApprovalKey } from "@/lib/approvals/summary";
import { IDEMPOTENCY_PRUNE_HOURS, pruneIdempotencyClaims } from "@/lib/compat/idempotency";
import { deleteMedia } from "@/lib/content/media";
import { prisma } from "@/lib/db";
import { sweepPendingUploads } from "@/lib/inbox/media";
import { BATCH as LEAD_PAGE, chunk, deleteBatched } from "./batch";
import { cleanupOrphanCreativeFiles } from "./files";
import { FIXED_RETENTION_DAYS, PROMOTE_RETENTION_DAYS, RETENTION_CONFIG_KEY, RETENTION_DEFAULTS, RETENTION_LIMITS, type RetentionKey } from "./personal-data";

const DAY = 24 * 60 * 60 * 1000;

/** Fixed retention periods in days. They live in personal-data.ts together with the configurable defaults. */
export const RETENTION_DAYS = FIXED_RETENTION_DAYS;

const BATCH = 5000;

type Purgeable = {
  findMany: (args: { where: object; select: { id: true }; take: number }) => Promise<{ id: string }[]>;
  deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>;
};

async function purge(model: Purgeable, where: object): Promise<number> {
  const rows = await model.findMany({ where, select: { id: true }, take: BATCH });
  if (rows.length === 0) return 0;
  return (await model.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count;
}

export async function runRetention(now = Date.now()): Promise<Record<string, number>> {
  const ago = (days: number) => new Date(now - days * DAY);
  const webhookCutoff = ago(RETENTION_DAYS.webhookEvents);

  const stale = await prisma.webhookEvent.findMany({ where: { processedAt: null, receivedAt: { lt: webhookCutoff } }, select: { id: true }, take: BATCH });
  if (stale.length) {
    await prisma.webhookEvent.updateMany({
      where: { id: { in: stale.map((r) => r.id) }, processedAt: null },
      data: { payload: {}, error: "expired unprocessed", processedAt: new Date(now) },
    });
  }

  return {
    webhookEventsDeleted: await purge(prisma.webhookEvent as unknown as Purgeable, { processedAt: { not: null, lt: webhookCutoff } }),
    webhookPayloadsCleared: stale.length,
    jobs: await purge(prisma.job as unknown as Purgeable, { status: "done", createdAt: { lt: ago(RETENTION_DAYS.doneJobs) } }),
    sessions: await purge(prisma.session as unknown as Purgeable, {
      OR: [{ expiresAt: { lt: ago(RETENTION_DAYS.sessions) } }, { revokedAt: { lt: ago(RETENTION_DAYS.sessions) } }],
    }),
    emailTokens: await purge(prisma.emailToken as unknown as Purgeable, {
      OR: [{ usedAt: { lt: ago(RETENTION_DAYS.emailTokens) } }, { expiresAt: { lt: ago(RETENTION_DAYS.emailTokens) } }],
    }),
    automationRuns: await purge(prisma.automationRun as unknown as Purgeable, { createdAt: { lt: ago(RETENTION_DAYS.automationRuns) } }),
  };
}

export type RetentionConfig = Record<RetentionKey, number>;

/** Applies PlatformSetting overrides on top of the defaults. A value that is not a whole number inside its limits is ignored. */
export function resolveRetentionConfig(raw: unknown): RetentionConfig {
  const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...RETENTION_DEFAULTS } as RetentionConfig;
  for (const key of Object.keys(RETENTION_DEFAULTS) as RetentionKey[]) {
    const v = given[key];
    const { min, max } = RETENTION_LIMITS[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

export async function getRetentionConfig(): Promise<RetentionConfig> {
  const row = await prisma.platformSetting.findUnique({ where: { key: RETENTION_CONFIG_KEY } }).catch(() => null);
  return resolveRetentionConfig(row?.value);
}

function monthsAgo(now: number, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/**
 * Deletes leads whose last activity is older than the cutoff. Last activity is the later of the lead's creation, the first
 * response and the last message in any conversation with the lead's contact. Leads still in an active follow-up sequence stay.
 */
async function purgeLeads(cutoff: Date): Promise<number> {
  let total = 0;
  let after = "";
  for (;;) {
    const candidates = await prisma.lead.findMany({
      where: {
        id: { gt: after },
        createdAt: { lt: cutoff },
        OR: [{ firstResponseAt: null }, { firstResponseAt: { lt: cutoff } }],
        runs: { none: { status: "active" } },
      },
      select: { id: true, tenantId: true, contactId: true },
      orderBy: { id: "asc" },
      take: LEAD_PAGE,
    });
    if (candidates.length === 0) break;
    after = candidates[candidates.length - 1].id;
    const contactIds = [...new Set(candidates.map((l) => l.contactId).filter((c): c is string => !!c))];
    const busy = new Set<string>();
    for (const part of chunk(contactIds)) {
      const recent = await prisma.conversation.findMany({ where: { contactId: { in: part }, lastMessageAt: { gte: cutoff } }, select: { tenantId: true, contactId: true } });
      for (const c of recent) busy.add(`${c.tenantId}:${c.contactId}`);
    }
    const ids = candidates.filter((l) => !(l.contactId && busy.has(`${l.tenantId}:${l.contactId}`))).map((l) => l.id);
    if (ids.length) {
      await prisma.leadSequenceRun.deleteMany({ where: { leadId: { in: ids } } });
      total += (await prisma.lead.deleteMany({ where: { id: { in: ids } } })).count;
    }
    if (candidates.length < LEAD_PAGE) break;
  }
  return total;
}

/** Fixed retention of the spend controls (docs/SPEND-CONTROLS-SPEC.md 3.5), in days. */
export const SPEND_RETENTION_DAYS = {
  stoppedCommitments: 400,
  clearedBreakers: 400,
  closedReservations: 90,
  intradaySamples: 35,
} as const;

/**
 * Spend controls retention (3.5). Open rows are never touched: only stopped commitments, cleared breakers and closed
 * reservations age out. SpendDaily and AssistantShadowRecord follow the ad performance period, SpendApproval the approval
 * request period. SpendLedger and SpendConsent are append-only and kept for the life of the workspace.
 */
export async function runSpendRetention(now: number, cfg: RetentionConfig): Promise<Record<string, number>> {
  const ago = (days: number) => new Date(now - days * DAY);
  return {
    spendCommitmentsStopped: await deleteBatched("SpendCommitment", { status: "stopped", updatedAt: { lt: ago(SPEND_RETENTION_DAYS.stoppedCommitments) } }),
    spendBreakersCleared: await deleteBatched("SpendBreaker", { state: "cleared", clearedAt: { lt: ago(SPEND_RETENTION_DAYS.clearedBreakers) } }),
    spendReservationsClosed: await deleteBatched("SpendReservation", { status: { in: ["settled", "released", "expired"] }, closedAt: { lt: ago(SPEND_RETENTION_DAYS.closedReservations) } }),
    intradaySpendSamples: await deleteBatched("IntradaySpendSample", { sampledAt: { lt: ago(SPEND_RETENTION_DAYS.intradaySamples) } }),
    spendDaily: await deleteBatched("SpendDaily", { day: { lt: ago(cfg.insightSnapshotDays) } }, "scopeId"),
    assistantShadowRecords: await deleteBatched("AssistantShadowRecord", { createdAt: { lt: ago(cfg.insightSnapshotDays) } }),
    // A request still marked pending 90 days after it expired was declined by lazy expiry long ago (4.16).
    spendApprovals: await deleteBatched("SpendApproval", {
      OR: [{ decidedAt: { lt: ago(cfg.approvalRequestDays) } }, { decidedAt: null, expiresAt: { lt: ago(cfg.approvalRequestDays) } }],
    }),
  };
}

/** The AdMedia ids that a non-archived ad of the workspace still uses (Ad.mediaIds). */
async function mediaInUse(tenantId: string): Promise<Set<string>> {
  const ads = await prisma.ad.findMany({ where: { tenantId, status: { not: "archived" } }, select: { mediaIds: true } });
  return new Set(ads.flatMap((a) => a.mediaIds ?? []));
}

/** Rows grouped by workspace, in the order they came. */
function byTenant<T extends { tenantId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.tenantId, [...(out.get(r.tenantId) ?? []), r]);
  return out;
}

/**
 * Ad-only media (crops and copies made only for ads) PROMOTE_RETENTION_DAYS.adOnlyMedia days after their last use (or after
 * they were made, if never used), once no non-archived ad of the workspace uses them. The delete repeats the age filter, so a
 * draft that picked the media up meanwhile keeps it. The file goes too, through the content store's own path checks, unless
 * another AdMedia row of the workspace still names it (the same crop sent to a second ad account). Library media
 * (adOnly = false) is never touched here, and files of the creative store are never deleted here.
 */
async function purgeAdOnlyMedia(cutoff: Date): Promise<{ rows: number; files: number }> {
  const aged = { adOnly: true, OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }] };
  let rows = 0;
  let files = 0;
  let after = "";
  for (;;) {
    const candidates = await prisma.adMedia.findMany({
      where: { id: { gt: after }, ...aged },
      select: { id: true, tenantId: true, source: true, sourceKey: true },
      orderBy: { id: "asc" },
      take: LEAD_PAGE,
    });
    if (candidates.length === 0) break;
    after = candidates[candidates.length - 1].id;
    for (const [tenantId, list] of byTenant(candidates)) {
      const used = await mediaInUse(tenantId);
      const gone = list.filter((m) => !used.has(m.id));
      if (gone.length === 0) continue;
      rows += (await prisma.adMedia.deleteMany({ where: { tenantId, id: { in: gone.map((m) => m.id) }, ...aged } })).count;
      for (const key of new Set(gone.filter((m) => m.source !== "creative").map((m) => m.sourceKey))) {
        const stillNamed = await prisma.adMedia.count({ where: { tenantId, sourceKey: key, source: { not: "creative" } } });
        if (stillNamed > 0) continue;
        if (await deleteMedia(tenantId, key).catch(() => false)) files++;
      }
    }
    if (candidates.length < LEAD_PAGE) break;
  }
  return { rows, files };
}

/** AdMedia sources whose file Edwyz made only for ads (a copy of Instagram media, a crop). Library uploads and generated creatives are the customer's. */
const ADS_ONLY_FILE_SOURCES = ["ig_copy", "crop"];

/**
 * Local video originals already processed by Meta (5.5): a video AdMedia row that is ready with a Meta video id and has not changed
 * for PROMOTE_RETENTION_DAYS.processedVideoOriginals days (updatedAt, never earlier than the moment it became ready) loses its
 * local file once no non-archived ad or draft of the workspace uses it. The row stays with metaVideoId and metaThumbHash, so ads
 * keep working from Meta's processed copy. Only files Edwyz made for ads go (an Instagram copy); a video the customer uploaded to
 * their library is theirs and stays, as do generated creatives. A file another AdMedia row of the workspace still needs (in use,
 * or not processed yet) stays. A file already gone counts nothing, so a later run only checks again.
 */
async function purgeProcessedVideoOriginals(cutoff: Date): Promise<number> {
  const aged = { kind: "video", status: "ready", metaVideoId: { not: null }, updatedAt: { lt: cutoff }, source: { in: ADS_ONLY_FILE_SOURCES } };
  let files = 0;
  let after = "";
  for (;;) {
    const candidates = await prisma.adMedia.findMany({
      where: { id: { gt: after }, ...aged },
      select: { id: true, tenantId: true, sourceKey: true },
      orderBy: { id: "asc" },
      take: LEAD_PAGE,
    });
    if (candidates.length === 0) break;
    after = candidates[candidates.length - 1].id;
    for (const [tenantId, list] of byTenant(candidates)) {
      const used = await mediaInUse(tenantId);
      for (const key of new Set(list.filter((m) => !used.has(m.id)).map((m) => m.sourceKey))) {
        const named = await prisma.adMedia.findMany({ where: { tenantId, sourceKey: key, source: { not: "creative" } }, select: { id: true, status: true, metaVideoId: true } });
        if (named.some((m) => used.has(m.id) || m.status !== "ready" || !m.metaVideoId)) continue;
        if (await deleteMedia(tenantId, key).catch(() => false)) files++;
      }
    }
    if (candidates.length < LEAD_PAGE) break;
  }
  return files;
}

/**
 * Discarded drafts (5.5) PROMOTE_RETENTION_DAYS.discardedDrafts days after they were discarded, while they never reached Meta: a
 * draft, or a start that failed before Meta made the campaign (status error, no Meta campaign id). Their client approval records
 * go first (ApprovalRequest rows and the approval:ad_campaign:<tenant>:<id> setting), then the campaign; its ad sets, ads and version
 * comparison go with it (foreign keys cascade). The delete repeats the filter, so a draft restored meanwhile stays.
 */
async function purgeDiscardedDrafts(cutoff: Date): Promise<number> {
  const where = { status: { in: ["draft", "error"] }, metaCampaignId: null, discardedAt: { lt: cutoff } };
  let total = 0;
  for (;;) {
    const rows = await prisma.adCampaign.findMany({ where, select: { id: true, tenantId: true }, orderBy: { id: "asc" }, take: LEAD_PAGE });
    if (rows.length === 0) break;
    let deleted = 0;
    for (const [tenantId, list] of byTenant(rows)) {
      const ids = list.map((r) => r.id);
      await prisma.approvalRequest.deleteMany({ where: { tenantId, subjectType: "ad_campaign", subjectId: { in: ids } } });
      await prisma.platformSetting.deleteMany({ where: { key: { in: ids.map((id) => campaignApprovalKey(tenantId, id)) } } });
      deleted += (await prisma.adCampaign.deleteMany({ where: { ...where, tenantId, id: { in: ids } } })).count;
    }
    total += deleted;
    if (deleted === 0 || rows.length < LEAD_PAGE) break;
  }
  return total;
}

/** Test leads (Lead.isTest, D33) PROMOTE_RETENTION_DAYS.testLeads days after they arrived, with any sequence run they have. */
async function purgeTestLeads(cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await prisma.lead.findMany({ where: { isTest: true, createdAt: { lt: cutoff } }, select: { id: true }, take: LEAD_PAGE });
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    await prisma.leadSequenceRun.deleteMany({ where: { leadId: { in: ids } } });
    const { count } = await prisma.lead.deleteMany({ where: { id: { in: ids }, isTest: true } });
    total += count;
    if (count === 0 || rows.length < LEAD_PAGE) break;
  }
  return total;
}

/**
 * Retention of Instagram and Facebook Page ads data (docs/IG-PAGE-ADS-SPEC.md 5.5), fixed periods (PROMOTE_RETENTION_DAYS):
 * results by placement and version 400 days, or the configured ad performance period if shorter (cfg.insightSnapshotDays, the
 * period the privacy page states); customer-list upload records 180 days; ad-only media 30 days after last use; local copies of
 * videos Meta has processed 30 days after they were ready; test leads 30 days; and discarded drafts that never reached Meta 30
 * days after they were discarded, with their client approval records.
 */
export async function runPromoteRetention(now: number, cfg: RetentionConfig = { ...RETENTION_DEFAULTS }): Promise<Record<string, number>> {
  const ago = (days: number) => new Date(now - days * DAY);
  const P = PROMOTE_RETENTION_DAYS;
  const media = await purgeAdOnlyMedia(ago(P.adOnlyMedia));
  return {
    insightBreakdowns: await deleteBatched("InsightBreakdown", { date: { lt: ago(Math.min(P.insightBreakdowns, cfg.insightSnapshotDays)) } }),
    adAudienceUploads: await deleteBatched("AdAudienceUpload", { createdAt: { lt: ago(P.audienceUploads) } }),
    adOnlyMedia: media.rows,
    adOnlyMediaFiles: media.files,
    processedVideoOriginalFiles: await purgeProcessedVideoOriginals(ago(P.processedVideoOriginals)),
    testLeads: await purgeTestLeads(ago(P.testLeads)),
    discardedDrafts: await purgeDiscardedDrafts(ago(P.discardedDrafts)),
  };
}

/**
 * Retention for product and ad data. Periods come from PlatformSetting "retention:config" with safe defaults (see
 * personal-data.ts). Everything is deleted in batches, and only counts are logged.
 */
export async function runPersonalDataRetention(now = Date.now()): Promise<Record<string, number>> {
  const cfg = await getRetentionConfig();
  const ago = (days: number) => new Date(now - days * DAY);

  const counts: Record<string, number> = {
    insightSnapshots: await deleteBatched("InsightSnapshot", { date: { lt: ago(cfg.insightSnapshotDays) } }),
    optimizerProposals: await deleteBatched("OptimizerProposal", {
      status: { in: ["applied", "rejected", "expired", "failed"] },
      createdAt: { lt: ago(cfg.insightSnapshotDays) },
    }),
    conversionEvents: await deleteBatched("ConversionEvent", { createdAt: { lt: ago(cfg.conversionEventDays) } }),
    approvalRequests: await deleteBatched("ApprovalRequest", {
      OR: [{ decidedAt: { lt: ago(cfg.approvalRequestDays) } }, { decidedAt: null, expiresAt: { lt: ago(cfg.approvalRequestDays) } }],
    }),
    chatbotSessions: await deleteBatched("ChatbotSession", {
      status: { in: ["completed", "expired", "handed_off"] },
      updatedAt: { lt: ago(cfg.chatbotSessionDays) },
    }),
    usageLedger: await deleteBatched("UsageLedger", { createdAt: { lt: ago(cfg.usageLedgerDays) } }),
    abandonedCarts: await deleteBatched("AbandonedCart", { createdAt: { lt: ago(cfg.abandonedCartDays) } }),
    webhookDeliveries: await deleteBatched("WebhookDelivery", { createdAt: { lt: ago(cfg.webhookDeliveryDays) } }),
    leads: await purgeLeads(monthsAgo(now, cfg.leadMonths)),
    ...(await runSpendRetention(now, cfg)),
    ...(await runPromoteRetention(now, cfg)),
    // Compat send claims (PlatformSetting "compat:idem:*") are only meaningful for 24 hours; the in-process sweep is best effort, this one is the backstop.
    compatIdempotencyClaims: await pruneIdempotencyClaims(new Date(now - IDEMPOTENCY_PRUNE_HOURS * 3_600_000)),
  };
  const orphans = await cleanupOrphanCreativeFiles(now);
  counts.creativeFilesOrphaned = orphans.filesDeleted;
  // Inbox attachments picked but never sent; each workspace's own uploads also trim them, this covers workspaces gone quiet.
  counts.inboxUnsentCopiesDeleted = (await sweepPendingUploads(now)).files;

  console.info("[retention] personal data", JSON.stringify(counts));
  return counts;
}
