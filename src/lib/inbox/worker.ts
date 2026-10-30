import { prisma } from "@/lib/db";
import type { WorkerModule } from "@/worker/registry";

const PRUNE_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ConversationMark has no foreign key to Conversation, so a deleted chat leaves its favourite, unread and mention rows behind.
 * Readers already skip them; this removes them, a bounded batch at a time. Returns how many rows were removed.
 */
export async function pruneOrphanMarks(limit = PRUNE_BATCH): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "ConversationMark"
    WHERE id IN (
      SELECT m.id FROM "ConversationMark" m
      WHERE NOT EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = m."conversationId" AND c."tenantId" = m."tenantId")
      LIMIT ${limit}
    )`;
}

export const worker: WorkerModule = {
  queues: {},
  periodic: [{ name: "inbox-prune-marks", everyMs: DAY_MS, run: () => pruneOrphanMarks() }],
};
