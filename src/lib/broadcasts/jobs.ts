import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export const BROADCAST_QUEUE = "broadcast";

/**
 * Schedules a worker run for a broadcast unless one is already waiting. A start, a pause, a resume and the worker's own
 * follow-up all ask for a run; without this each of them would add a job and every job would requeue itself, leaving several
 * parallel chains per broadcast. When a run is already waiting but later than asked, it is moved earlier.
 */
export async function enqueueBroadcastRun(broadcastId: string, runAt: Date): Promise<void> {
  try {
    const waiting = await prisma.job.findFirst({
      where: { queue: BROADCAST_QUEUE, status: "queued", payload: { path: ["broadcastId"], equals: broadcastId } },
      orderBy: { runAt: "asc" },
      select: { id: true, runAt: true },
    });
    if (waiting) {
      if (runAt.getTime() < waiting.runAt.getTime()) await prisma.job.updateMany({ where: { id: waiting.id, status: "queued" }, data: { runAt } });
      return;
    }
  } catch {
    /* if the lookup fails, a possible duplicate run is safer than a missing one: the run lease keeps duplicates from overlapping */
  }
  await enqueue(BROADCAST_QUEUE, { broadcastId }, { runAt });
}

const LEASE_MS = 5 * 60 * 1000;
export const leaseKey = (broadcastId: string) => `broadcast.run_lease.${broadcastId}`;

/**
 * Only one worker run may send for a broadcast at a time, so two runs can never both read the rolling 24 hour usage and then
 * both send a batch past the limit. The lease is a row that expires after a few minutes in case a worker dies. If the
 * database cannot be reached to take the lease the run goes ahead: pausing sending for a bookkeeping error would be worse.
 */
export async function acquireRunLease(broadcastId: string, now = new Date()): Promise<boolean> {
  const key = leaseKey(broadcastId);
  try {
    await prisma.platformSetting.create({ data: { key, value: { at: now.toISOString() } } });
    return true;
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2002") return true;
  }
  try {
    const { count } = await prisma.platformSetting.updateMany({ where: { key, updatedAt: { lt: new Date(now.getTime() - LEASE_MS) } }, data: { value: { at: now.toISOString() } } });
    return count > 0;
  } catch {
    return true;
  }
}

export async function releaseRunLease(broadcastId: string): Promise<void> {
  try {
    await prisma.platformSetting.deleteMany({ where: { key: leaseKey(broadcastId) } });
  } catch {
    /* the lease expires by itself */
  }
}
