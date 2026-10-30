import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { GraphError, graphFetchAs } from "@/lib/graph";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { sanitizeMessage } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import type { WorkerModule } from "@/worker/registry";
import { CONVERSIONS_QUEUE, enqueueDelivery } from "./index";
import { buildConversionPayload, hasIdentifiers, type ConversionEventName } from "./payload";
import { getConversionSettings } from "./settings";

type Json = Record<string, unknown>;

async function markSkipped(id: string, reason: string, datasetId?: string) {
  await prisma.conversionEvent.update({ where: { id }, data: { status: "skipped", response: { reason }, ...(datasetId ? { datasetId } : {}) } });
}

async function markFailed(id: string, attempts: number, message: string) {
  await prisma.conversionEvent.update({ where: { id }, data: { status: "failed", attempts, response: { error: sanitizeMessage(message) } } });
}

function emailFromFields(fields: unknown, attributes: unknown): string | null {
  if (Array.isArray(fields)) {
    for (const item of fields as { name?: unknown; values?: unknown }[]) {
      if (typeof item?.name === "string" && /e-?mail/i.test(item.name) && Array.isArray(item.values) && typeof item.values[0] === "string") return item.values[0];
    }
  } else if (fields && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields as Json)) if (/e-?mail/i.test(key) && typeof value === "string") return value;
  }
  const attr = (attributes as Json | null)?.email;
  return typeof attr === "string" ? attr : null;
}

async function resolveDataset(tenantId: string, preferredAssetId: string | null) {
  const assets = await listAssets(tenantId, "dataset");
  const usable = assets.filter((a) => a.status === "active");
  return usable.find((a) => a.id === preferredAssetId) ?? (preferredAssetId ? null : usable[0] ?? null);
}

/** Meta accepts an event only for 7 days after it happened, so an event of a blocked workspace is kept at most that long. */
const MAX_BLOCKED_AGE_MS = 7 * 86_400_000;
/** Pending events younger than this still have their normal delivery job in flight; the sweep leaves them alone. */
const SWEEP_MIN_AGE_MS = 30 * 60_000;
const SWEEP_BATCH = 200;
const SWEEP_ROUNDS = 5;

const ageOf = (event: { eventTime: Date; createdAt?: Date }, now: number) => {
  const at = event.eventTime instanceof Date ? event.eventTime : event.createdAt;
  return at instanceof Date ? now - at.getTime() : 0;
};

/**
 * The workspace is suspended, deleted or billing-locked. The event is NOT dropped and nothing is sent: it stays "pending" and the
 * job ends. sweepPendingConversions re-enqueues it once the workspace is allowed again. An event older than Meta's window could not
 * be delivered anyway; it is then marked skipped with reason tenant_blocked.
 */
async function holdWhileBlocked(event: { id: string; eventTime: Date; createdAt?: Date }, now = Date.now()): Promise<void> {
  if (ageOf(event, now) > MAX_BLOCKED_AGE_MS) await markSkipped(event.id, "tenant_blocked");
}

/**
 * Periodic safety net for events held by holdWhileBlocked (and for jobs lost for any other reason). Looks at old pending events,
 * oldest first, and per workspace: allowed again and no delivery job in flight -> enqueue one; still blocked -> leave pending,
 * or skip with tenant_blocked once older than 7 days. Blocked workspaces are excluded from later rounds so a large backlog of
 * theirs cannot starve healthy ones. Tenant-scoped through each event row. Returns how many deliveries were enqueued.
 */
export async function sweepPendingConversions(now = new Date()): Promise<number> {
  const inFlight = new Set<string>();
  const jobs = await prisma.job.findMany({ where: { queue: CONVERSIONS_QUEUE, status: { in: ["queued", "running"] } }, select: { payload: true }, take: 5000 });
  for (const j of jobs) {
    const id = (j.payload as { conversionEventId?: unknown } | null)?.conversionEventId;
    if (typeof id === "string") inFlight.add(id);
  }
  const blocked = new Set<string>();
  const seen = new Set<string>();
  let enqueued = 0;
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const rows = await prisma.conversionEvent.findMany({
      where: {
        status: "pending",
        createdAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
        ...(blocked.size ? { tenantId: { notIn: [...blocked] } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH,
      select: { id: true, tenantId: true, eventTime: true, createdAt: true },
    });
    const before = blocked.size;
    let fresh = 0;
    for (const event of rows) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      fresh++;
      if (!blocked.has(event.tenantId) && !(await tenantMayRunBackground(event.tenantId, now.getTime()))) blocked.add(event.tenantId);
      if (blocked.has(event.tenantId)) {
        await holdWhileBlocked(event, now.getTime());
        continue;
      }
      if (inFlight.has(event.id)) continue;
      await enqueueDelivery(event.tenantId, event.id);
      enqueued++;
    }
    if (rows.length < SWEEP_BATCH || fresh === 0 || blocked.size === before) break;
  }
  return enqueued;
}

/** Delivers one ConversionEvent. Throws only for retryable failures so the job queue retries with backoff. */
export async function deliverConversion(tenantId: string, conversionEventId: string, isLastAttempt: boolean): Promise<void> {
  const event = await prisma.conversionEvent.findFirst({ where: { id: conversionEventId, tenantId } });
  if (!event || event.status === "sent" || event.status === "skipped") return;
  if (!(await tenantMayRunBackground(tenantId))) return holdWhileBlocked(event);

  const settings = await getConversionSettings(tenantId);
  if (!settings.enabled) return markSkipped(event.id, "disabled");

  const lead = event.leadId ? await prisma.lead.findFirst({ where: { id: event.leadId, tenantId } }) : null;
  const contactId = event.contactId ?? lead?.contactId ?? null;
  const contact = contactId ? await prisma.contact.findFirst({ where: { id: contactId, tenantId } }) : null;
  if (contact?.optedOutAt) return markSkipped(event.id, "opted_out");

  const dataset = await resolveDataset(tenantId, settings.datasetAssetId);
  if (!dataset) return markSkipped(event.id, "no_dataset");

  const conversation = contact
    ? await prisma.conversation.findFirst({
        where: { tenantId, contactId: contact.id, referral: { not: Prisma.DbNull } },
        orderBy: { createdAt: "desc" },
        select: { referral: true, phoneNumber: { select: { waba: { select: { wabaId: true } } } } },
      })
    : null;
  const ctwaClid = (conversation?.referral as { ctwaClid?: string } | null)?.ctwaClid ?? null;
  const wabaId = ctwaClid ? conversation?.phoneNumber?.waba?.wabaId ?? null : null;

  const payload = buildConversionPayload({
    tenantId,
    subjectId: event.leadId ?? event.contactId ?? event.id,
    eventName: event.eventName as ConversionEventName,
    eventTime: event.eventTime,
    email: emailFromFields(lead?.fields, contact?.attributes),
    phone: contact?.phone,
    ctwaClid,
    wabaId,
  });
  if (!hasIdentifiers(payload)) return markSkipped(event.id, "no_identifiers", dataset.externalId);

  const attempts = event.attempts + 1;
  try {
    const access = await getAssetAccess(tenantId, dataset.id);
    const response = await graphFetchAs<Json>(access.token, { path: `${access.externalId}/events`, method: "POST", body: payload });
    await prisma.conversionEvent.update({
      where: { id: event.id },
      data: { status: "sent", attempts, datasetId: access.externalId, response: { eventsReceived: response?.events_received ?? null, eventId: payload.data[0].event_id } as object },
    });
  } catch (e) {
    const retryable = e instanceof GraphError && e.retryable;
    const message = e instanceof Error ? e.message : "delivery failed";
    if (retryable && !isLastAttempt) {
      await prisma.conversionEvent.update({ where: { id: event.id }, data: { attempts, datasetId: dataset.externalId } });
      throw e;
    }
    await markFailed(event.id, attempts, message);
  }
}

export const worker: WorkerModule = {
  queues: {
    [CONVERSIONS_QUEUE]: async (payload, ctx) => {
      const { tenantId, conversionEventId } = (payload ?? {}) as { tenantId?: unknown; conversionEventId?: unknown };
      if (typeof tenantId !== "string" || typeof conversionEventId !== "string") return;
      await deliverConversion(tenantId, conversionEventId, ctx.isLastAttempt);
    },
  },
  periodic: [{ name: "conversions.sweep-pending", everyMs: 15 * 60_000, run: () => sweepPendingConversions() }],
};
