import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { formRefOf } from "./backfill";
import { ingestForTenant, LEAD_QUEUE, parseLeadJob } from "./ingest";
import { runDueSequences, startSequenceForLead } from "./runner";
import { matchesSequence, readSteps } from "./steps";

/** A blocked workspace's lead is re-checked every 15 minutes for up to 7 days; Meta does not redeliver the webhook. */
export const LEAD_DEFER_MS = 15 * 60_000;
export const MAX_LEAD_DEFERRALS = (7 * 86_400_000) / LEAD_DEFER_MS;

type Deferral = { deferrals: number; only: string[] | null };

function readDeferral(payload: unknown): Deferral {
  const p = (payload ?? {}) as { deferrals?: unknown; deferredFor?: unknown };
  const n = typeof p.deferrals === "number" && Number.isFinite(p.deferrals) ? Math.max(0, Math.floor(p.deferrals)) : 0;
  const only = Array.isArray(p.deferredFor) ? p.deferredFor.filter((t): t is string => typeof t === "string") : null;
  return { deferrals: n, only };
}

/**
 * Same fan-out as handleLeadJob, but a workspace that is suspended, deleted or locked is not ingested now. It is not dropped:
 * the job is re-queued for that workspace only (Meta will not send the webhook again), so the lead is ingested once the workspace
 * recovers. After 7 days the lead is given up on and the give-up is audited. Scheduling does not depend on the attempt number:
 * every attempt (including a retry after a crash, a reclaimed job or an error while queueing) schedules the next deferral
 * unless an identical one is already queued, so a lead is never lost between attempts and a retry does not start a second chain.
 */
export async function handleLeadJobForActiveTenants(payload: unknown): Promise<void> {
  const job = parseLeadJob(payload);
  if (!job) return;
  const { deferrals, only } = readDeferral(payload);
  const found = await prisma.metaAsset.findMany({ where: { type: "page", externalId: job.pageId, status: "active" }, select: { id: true, tenantId: true } });
  const assets = only ? found.filter((a) => only.includes(a.tenantId)) : found;
  let failed: unknown = null;
  const blocked: string[] = [];
  for (const asset of assets) {
    if (!(await tenantMayRunBackground(asset.tenantId))) {
      blocked.push(asset.tenantId);
      continue;
    }
    try {
      await ingestForTenant(asset.tenantId, asset.id, job);
    } catch (e) {
      console.error("[leads] ingest failed:", describeError(e));
      failed = e;
    }
  }
  if (blocked.length) await deferBlocked(job, blocked, deferrals);
  if (failed) throw failed;
}

async function deferBlocked(job: { leadgenId: string; pageId: string; formId?: string }, tenantIds: string[], deferrals: number): Promise<void> {
  if (deferrals >= MAX_LEAD_DEFERRALS) {
    for (const tenantId of tenantIds) await audit({ tenantId, action: "leads.fetch_given_up", target: job.leadgenId, meta: { reason: "workspace_inactive" } }).catch(() => undefined);
    return;
  }
  const deferredFor = [...tenantIds].sort();
  if (await alreadyQueued(job.leadgenId, deferrals + 1, deferredFor)) return;
  await enqueue(LEAD_QUEUE, { ...job, deferrals: deferrals + 1, deferredFor }, { runAt: new Date(Date.now() + LEAD_DEFER_MS) });
}

/** True when this very deferral (same lead, same step of the chain, same workspaces) is already waiting or running. A lookup that fails counts as "not queued": a duplicate is harmless because ingesting is idempotent per workspace. */
async function alreadyQueued(leadgenId: string, deferrals: number, deferredFor: string[]): Promise<boolean> {
  try {
    const found = await prisma.job.findFirst({
      where: {
        queue: LEAD_QUEUE,
        status: { in: ["queued", "running"] },
        AND: [{ payload: { path: ["leadgenId"], equals: leadgenId } }, { payload: { path: ["deferrals"], equals: deferrals } }, { payload: { path: ["deferredFor"], equals: deferredFor } }],
      },
      select: { id: true },
    });
    return Boolean(found);
  } catch {
    return false;
  }
}

// =====================================================================================================================
// The 60-minute welcome catch-up (docs/IG-PAGE-ADS-SPEC.md 3.5, PRM-10 acceptance 2a)
// =====================================================================================================================

/** A sequence turned on this long after its campaign started still welcomes the form's earlier leads; later, nothing is back-filled. */
export const CATCH_UP_WINDOW_MS = 60 * 60_000;
/** Sequence runs one catch-up starts at most. */
export const CATCH_UP_MAX_RUNS = 50;
/** How often the worker looks for a campaign that started within the window. */
export const CATCH_UP_EVERY_MS = 60_000;
/** Leads looked at per catch-up at most. */
const CATCH_UP_CANDIDATES = 500;
/** Campaigns looked at per run at most. */
const CATCH_UP_CAMPAIGNS = 100;
/** Catch-up counts are kept this long: past the window nothing is back-filled, so they are no longer needed. */
const CATCH_UP_MARK_KEEP_MS = 2 * CATCH_UP_WINDOW_MS;
const CATCH_UP_PREFIX = "leads:catch-up:";
/** Workspaces whose Start and resume rows are read per run at most. */
const CATCH_UP_TENANTS = 1_000;

/**
 * The audit actions of Start and resume (ads/service.ts activateCampaign; the same list as promote/review.ts START_AUDIT_ACTIONS).
 * A campaign is launched paused (launchedAt) and its ads run only from one of these, which may come days later.
 */
export const START_AUDIT_ACTIONS = ["ads.campaign.activated", "ads.campaign.resumed"] as const;

/** PlatformSetting key that counts the runs the catch-up of a sequence for one campaign started ({started, at}). */
export const catchUpKey = (tenantId: string, sequenceId: string, campaignId: string) => `${CATCH_UP_PREFIX}${tenantId}:${sequenceId}:${campaignId}`;

/**
 * When a campaign's ads started: the latest of its launch, its last Start or resume (activatedAt, from the audit log) and its
 * scheduled start. Null before launch. A scheduled start still to come gives a start in the future: nothing has run yet.
 */
export function campaignStart(c: { launchedAt: Date | null; startsAt: Date | null; activatedAt?: Date | null }): Date | null {
  if (!c.launchedAt) return null;
  let start = c.launchedAt;
  for (const d of [c.activatedAt, c.startsAt]) if (d && d.getTime() > start.getTime()) start = d;
  return start;
}

export type CatchUpResult = { campaigns: number; started: number };

/**
 * The campaigns started or resumed in [since, now], with the time of their last Start or resume. Start writes the campaign row,
 * so only workspaces with an active campaign changed in the window can have one, and the audit log is read for those workspaces
 * only (its index is per workspace). Empty when the log cannot be read: the start is then the launch or the scheduled start.
 */
async function startsSince(since: Date, now: Date): Promise<Map<string, { tenantId: string; at: Date }>> {
  const out = new Map<string, { tenantId: string; at: Date }>();
  try {
    const changed = await prisma.adCampaign.findMany({
      where: { status: "active", launchedAt: { not: null }, updatedAt: { gte: since } },
      select: { tenantId: true },
      distinct: ["tenantId"],
      take: CATCH_UP_TENANTS,
    });
    const tenantIds = [...new Set((changed ?? []).map((c) => c.tenantId))];
    if (tenantIds.length === 0) return out;
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: { in: tenantIds }, action: { in: [...START_AUDIT_ACTIONS] }, createdAt: { gte: since, lte: now } },
      select: { tenantId: true, target: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: CATCH_UP_TENANTS,
    });
    for (const r of rows ?? []) {
      if (!r.target || !r.tenantId) continue;
      const before = out.get(r.target);
      if (!before || before.at.getTime() < r.createdAt.getTime()) out.set(r.target, { tenantId: r.tenantId, at: r.createdAt });
    }
  } catch (e) {
    console.error("[leads] welcome catch-up could not read the campaign starts:", describeError(e));
  }
  return out;
}

/**
 * Leads that arrive between Start and the follow-up being turned on get no welcome from ingest (no sequence was on). So, every
 * minute: for each running campaign that started less than 60 minutes ago, and each lead form its ads use, an enabled sequence made
 * for that form (appliesTo.leadFormId) starts for the form's leads that arrived since the start, whose WhatsApp consent was detected
 * on the form (and not withdrawn since), are not test leads and have no run yet: oldest first, and at most 50 in all for each
 * (sequence, campaign), counted in a PlatformSetting row. The start is the latest of the launch, the last Start or resume and the
 * scheduled start (campaignStart), so a campaign launched paused and started days later is caught up from its real start. A
 * sequence that was on before the start finds nothing to do (ingest started every consented lead); one turned off and on again
 * within the hour welcomes the leads it missed, up to the same 50. After 60 minutes nothing is back-filled, and the Leads hub shows
 * those leads as "No welcome sent". Runs start through the runner's startSequenceForLead, so Phase 0's WhatsApp limits and every
 * step's own checks apply as for any lead.
 */
export async function runSequenceCatchUp(now: Date = new Date()): Promise<CatchUpResult> {
  const t = now.getTime();
  const since = new Date(t - CATCH_UP_WINDOW_MS);
  const activated = await startsSince(since, now);
  const campaigns = await prisma.adCampaign.findMany({
    where: {
      status: "active",
      launchedAt: { not: null },
      OR: [{ launchedAt: { gte: since } }, { startsAt: { gte: since, lte: now } }, ...(activated.size > 0 ? [{ id: { in: [...activated.keys()] } }] : [])],
    },
    select: { id: true, tenantId: true, metaCampaignId: true, launchedAt: true, startsAt: true },
    orderBy: { launchedAt: "asc" },
    take: CATCH_UP_CAMPAIGNS,
  });
  const result: CatchUpResult = { campaigns: 0, started: 0 };
  for (const c of campaigns ?? []) {
    const a = activated.get(c.id);
    const start = campaignStart({ ...c, activatedAt: a && a.tenantId === c.tenantId ? a.at : null });
    if (!start || start.getTime() > t || t - start.getTime() > CATCH_UP_WINDOW_MS) continue;
    result.campaigns++;
    try {
      result.started += await catchUpCampaign(c, start, now);
    } catch (e) {
      console.error("[leads] welcome catch-up failed:", describeError(e));
    }
  }
  if (result.campaigns > 0) {
    try {
      await prisma.platformSetting.deleteMany({ where: { key: { startsWith: CATCH_UP_PREFIX }, updatedAt: { lt: new Date(t - CATCH_UP_MARK_KEEP_MS) } } });
    } catch {
      // Old markers are cleared by a later run.
    }
  }
  return result;
}

type StartedCampaign = { id: string; tenantId: string; metaCampaignId: string | null };

async function catchUpCampaign(c: StartedCampaign, start: Date, now: Date): Promise<number> {
  if (!(await tenantMayRunBackground(c.tenantId))) return 0;
  const ads = await prisma.ad.findMany({ where: { tenantId: c.tenantId, adSet: { campaignId: c.id } }, select: { creative: true }, take: 200 });
  const refs = [...new Set(ads.map((a) => formRefOf(a.creative)).filter((r): r is string => r !== null))];
  if (refs.length === 0) return 0;
  const forms = await prisma.leadForm.findMany({ where: { tenantId: c.tenantId, OR: [{ id: { in: refs } }, { metaFormId: { in: refs } }] }, select: { id: true } });
  if (forms.length === 0) return 0;
  const sequences = await prisma.leadSequence.findMany({ where: { tenantId: c.tenantId, enabled: true }, orderBy: { createdAt: "asc" }, take: 100 });
  let started = 0;
  for (const form of forms) {
    for (const s of sequences) {
      if (!isSequenceForForm(s, form.id, c.metaCampaignId)) continue;
      const key = catchUpKey(c.tenantId, s.id, c.id);
      const before = await caughtUp(key);
      if (before >= CATCH_UP_MAX_RUNS) continue;
      const added = await catchUpForm(c.tenantId, form.id, start, now, CATCH_UP_MAX_RUNS - before);
      if (added > 0) await recordCaughtUp(key, before + added, now);
      started += added;
    }
  }
  return started;
}

/** A sequence made for this form (appliesTo.leadFormId), with steps, that the campaign's leads match. */
function isSequenceForForm(s: { appliesTo: unknown; steps: unknown }, formId: string, campaignMetaId: string | null): boolean {
  const a = s.appliesTo && typeof s.appliesTo === "object" ? (s.appliesTo as { leadFormId?: unknown }) : null;
  return a?.leadFormId === formId && readSteps(s.steps).length > 0 && matchesSequence(s.appliesTo, { leadFormId: formId, campaignMetaId });
}

/**
 * How many runs the catch-up of this sequence for this campaign has started so far. The task runs in one process at a time (the
 * periodic lease), and a lead never gets a second run of a sequence (the unique key of LeadSequenceRun), so a count is enough.
 * An unreadable count is taken as the cap: better no catch-up than more than 50.
 */
async function caughtUp(key: string): Promise<number> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    const n = row?.value && typeof row.value === "object" ? (row.value as { started?: unknown }).started : 0;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return CATCH_UP_MAX_RUNS;
  }
}

async function recordCaughtUp(key: string, started: number, now: Date): Promise<void> {
  const value = { started, at: now.toISOString() };
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function catchUpForm(tenantId: string, formId: string, start: Date, now: Date, max: number): Promise<number> {
  // Consent detected on the form (consentAt), as at ingest (D35).
  const leads = await prisma.lead.findMany({
    where: { tenantId, leadFormId: formId, isTest: false, contactId: { not: null }, consentAt: { not: null }, createdAt: { gte: start, lte: now }, runs: { none: {} } },
    orderBy: { createdAt: "asc" },
    take: CATCH_UP_CANDIDATES,
  });
  if (leads.length === 0) return 0;
  const contactIds = [...new Set(leads.map((l) => l.contactId).filter((id): id is string => id !== null))];
  const contacts = await prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, optedOutAt: true } });
  const byId = new Map(contacts.map((c) => [c.id, c]));
  // A contact who opted out since keeps out of the welcome.
  const consented = leads.filter((l) => {
    const c = l.contactId ? byId.get(l.contactId) : undefined;
    return c !== undefined && !c.optedOutAt;
  });
  let started = 0;
  for (const lead of consented.slice(0, max)) {
    const runId = await startSequenceForLead(tenantId, lead, now).catch((e) => {
      console.error("[leads] welcome catch-up could not start a sequence:", describeError(e));
      return null;
    });
    if (runId) started++;
  }
  return started;
}

export const worker: WorkerModule = {
  queues: { [LEAD_QUEUE]: (payload) => handleLeadJobForActiveTenants(payload) },
  periodic: [
    { name: "leads.sequences", everyMs: 30_000, run: () => runDueSequences() },
    { name: "leads.sequences.catch-up", everyMs: CATCH_UP_EVERY_MS, run: () => runSequenceCatchUp() },
  ],
};
