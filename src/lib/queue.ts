import { sanitizeMessage } from "@/lib/safe-error";
import { prisma } from "@/lib/db";

export type JobContext = { attempt: number; maxAttempts: number; isLastAttempt: boolean };
export type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;

/** Adds a job. runAt delays it (used for scheduled broadcasts and retries). */
export async function enqueue(queue: string, payload: unknown, opts: { runAt?: Date; maxAttempts?: number } = {}) {
  return prisma.job.create({
    data: { queue, payload: payload as object, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5 },
  });
}

const backoffMs = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 30 * 60_000);

export type ClaimedJob = { id: string; payload: unknown; attempts: number; maxAttempts: number; runAt: Date; createdAt: Date };

const time = (d: Date | string) => new Date(d).getTime();

/**
 * Claimed jobs in the order they were queued: runAt, then createdAt, then id. Postgres does not promise that UPDATE ... RETURNING
 * follows the ORDER BY of its subquery, and order matters for webhooks (two quick messages, or STOP then START, from one customer).
 */
export function inQueueOrder<T extends Pick<ClaimedJob, "id" | "runAt" | "createdAt">>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => time(a.runAt) - time(b.runAt) || time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Claims and runs up to `limit` due jobs from a queue, oldest first. Safe to run in several processes (FOR UPDATE SKIP LOCKED).
 * A failed job is retried with exponential backoff until maxAttempts, then marked failed.
 */
export async function runDueJobs(queue: string, handler: JobHandler, limit = 10): Promise<number> {
  await prisma.$executeRaw`
    UPDATE "Job"
    SET status = CASE WHEN attempts >= "maxAttempts" THEN 'failed'::"JobStatus" ELSE 'queued'::"JobStatus" END,
        "lockedAt" = NULL, "lastError" = 'worker stopped before finishing'
    WHERE queue = ${queue} AND status = 'running' AND "lockedAt" < now() - interval '10 minutes'`;
  const claimed = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" SET status = 'running', "lockedAt" = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE queue = ${queue} AND status = 'queued' AND "runAt" <= now()
      ORDER BY "runAt", "createdAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload, attempts, "maxAttempts", "runAt", "createdAt"`;

  for (const job of inQueueOrder(claimed)) {
    try {
      await handler(job.payload, { attempt: job.attempts, maxAttempts: job.maxAttempts, isLastAttempt: job.attempts >= job.maxAttempts });
      await prisma.job.update({ where: { id: job.id }, data: { status: "done", lockedAt: null } });
    } catch (error) {
      const message = error instanceof Error ? sanitizeMessage(error.message) : "unknown error";
      const exhausted = job.attempts >= job.maxAttempts;
      await prisma.job
        .update({
          where: { id: job.id },
          data: {
            status: exhausted ? "failed" : "queued",
            lockedAt: null,
            lastError: message,
            runAt: exhausted ? undefined : new Date(Date.now() + backoffMs(job.attempts)),
          },
        })
        .catch(() => undefined);
    }
  }
  return claimed.length;
}
