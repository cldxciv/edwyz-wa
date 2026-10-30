import { prisma } from "@/lib/db";
import { finishDeletionRequest, getDeletionRequest, noteDeletionFailure } from "@/lib/storage";
import { eraseMetaUserData } from "./erase-meta";

const SWEEP_LIMIT = 20;
const MAX_FAILED_ATTEMPTS = 10;

export type DeletionOutcome = "completed" | "failed" | "skipped";

/**
 * Carries out a recorded Meta data-deletion request: finds the workspace connections made by that Facebook user id and
 * erases them (see erase-meta.ts for exactly what goes). A user id that no workspace connected matches nothing, and the
 * request is completed with zero connections because nothing is stored under that id. Safe to run twice.
 */
export async function processDeletionRequest(code: string, now = new Date()): Promise<DeletionOutcome> {
  const record = await getDeletionRequest(code);
  if (!record || record.status === "completed") return "skipped";
  try {
    const result = await eraseMetaUserData(record.userId);
    await finishDeletionRequest(code, { connections: result.connections, workspaces: result.workspaces }, now);
    return "completed";
  } catch {
    await noteDeletionFailure(code).catch(() => undefined);
    return "failed";
  }
}

/** Periodic safety net for requests the callback could not finish. Gives up after repeated failures so an admin looks at it. */
export async function runDeletionRequestSweep(): Promise<{ completed: number; failed: number }> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { startsWith: "deletion:" }, value: { path: ["status"], equals: "received" } },
    select: { key: true, value: true },
    take: SWEEP_LIMIT,
  });
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    const attempts = (row.value as { failedAttempts?: number } | null)?.failedAttempts ?? 0;
    if (attempts >= MAX_FAILED_ATTEMPTS) continue;
    const outcome = await processDeletionRequest(row.key.slice("deletion:".length));
    if (outcome === "completed") completed++;
    if (outcome === "failed") failed++;
  }
  return { completed, failed };
}
