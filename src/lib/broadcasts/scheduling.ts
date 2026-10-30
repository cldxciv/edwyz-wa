import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";
import type { CalendarItem } from "./calendar";
import { enqueueBroadcastRun } from "./jobs";
import { ownedBroadcast } from "./service";
import { assertValidRange, assertValidSchedule, parseRetryDays } from "./schedule";

const CALENDAR_LIMIT = 500;

export type BroadcastPatch = { scheduledAt?: Date | null; retryDays?: number };

/** Changes the planned send time (drafts and scheduled broadcasts only) or the retry window of a broadcast that has not finished. */
export async function updateBroadcastPlan(actor: Actor, id: string, patch: BroadcastPatch, now = new Date()) {
  const broadcast = await ownedBroadcast(actor, id);
  const data: { scheduledAt?: Date | null; retryDays?: number } = {};

  if (patch.scheduledAt !== undefined) {
    if (!["draft", "scheduled"].includes(broadcast.status)) throw new HttpError(409, `A ${broadcast.status} broadcast cannot be rescheduled.`);
    if (patch.scheduledAt === null && broadcast.status === "scheduled") throw new HttpError(400, "Cancel the broadcast instead of clearing its schedule.");
    if (patch.scheduledAt) assertValidSchedule(patch.scheduledAt, now);
    data.scheduledAt = patch.scheduledAt;
  }
  if (patch.retryDays !== undefined) {
    if (["completed", "canceled", "failed"].includes(broadcast.status)) throw new HttpError(409, `A ${broadcast.status} broadcast cannot change its retry window.`);
    data.retryDays = parseRetryDays(patch.retryDays);
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to update.");

  const updated = await prisma.broadcast.update({ where: { id: broadcast.id, tenantId: actor.tenantId }, data });
  if (broadcast.status === "scheduled" && data.scheduledAt) {
    await enqueueBroadcastRun(broadcast.id, data.scheduledAt);
  }
  return updated;
}

/** Broadcasts planned or started inside [from, to): the calendar planner's data. */
export async function listCalendar(actor: Actor, from: Date, to: Date): Promise<CalendarItem[]> {
  assertValidRange(from, to);
  const inRange = { gte: from, lt: to };
  const rows = await prisma.broadcast.findMany({
    where: { tenantId: actor.tenantId, OR: [{ scheduledAt: inRange }, { startedAt: inRange }] },
    orderBy: { createdAt: "asc" },
    take: CALENDAR_LIMIT,
    select: { id: true, name: true, status: true, scheduledAt: true, startedAt: true },
  });
  return rows.flatMap((r) => {
    const at = r.startedAt && r.startedAt >= from && r.startedAt < to ? r.startedAt : r.scheduledAt;
    return at ? [{ id: r.id, name: r.name, status: r.status, at: at.toISOString() }] : [];
  });
}
