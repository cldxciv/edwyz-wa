import { IDEMPOTENCY_PRUNE_HOURS, pruneIdempotencyClaims } from "@/lib/compat/idempotency";
import { prisma } from "@/lib/db";
import { BATCH as LEAD_PAGE, chunk, deleteBatched } from "./batch";
import { cleanupOrphanCreativeFiles } from "./files";
import { FIXED_RETENTION_DAYS, RETENTION_CONFIG_KEY, RETENTION_DEFAULTS, RETENTION_LIMITS, type RetentionKey } from "./personal-data";

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
    // Compat send claims (PlatformSetting "compat:idem:*") are only meaningful for 24 hours; the in-process sweep is best effort, this one is the backstop.
    compatIdempotencyClaims: await pruneIdempotencyClaims(new Date(now - IDEMPOTENCY_PRUNE_HOURS * 3_600_000)),
  };
  const orphans = await cleanupOrphanCreativeFiles(now);
  counts.creativeFilesOrphaned = orphans.filesDeleted;

  console.info("[retention] personal data", JSON.stringify(counts));
  return counts;
}
