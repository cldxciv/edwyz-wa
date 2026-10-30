import { prisma } from "@/lib/db";

export type JobRow = { queue: string; status: string; n: number | bigint; oldestDueSeconds: number | null; stuck: number | bigint; recentFailed?: number | bigint };
export type PeriodicRow = { key: string; ageSeconds: number | null; lastRunAt: string | null };
/** failed counts every failed row ever kept; failedRecent only those whose last attempt was in the past 24 hours (what alerts should look at). */
export type QueueStats = { queued: number; running: number; failed: number; failedRecent: number; oldestDueSeconds: number; stuckRunning: number };
export type Metrics = {
  generatedAt: string;
  queues: Record<string, QueueStats>;
  totals: QueueStats;
  periodic: { name: string; lastRunAt: string | null; ageSeconds: number | null }[];
  worker: { heartbeatAgeSeconds: number | null; daemonAgeSeconds: number | null };
  dbRttMs: number;
};

const empty = (): QueueStats => ({ queued: 0, running: 0, failed: 0, failedRecent: 0, oldestDueSeconds: 0, stuckRunning: 0 });
const whole = (value: number | null) => (value === null ? null : Math.max(0, Math.round(Number(value))));

export function shapeMetrics(jobs: JobRow[], periodic: PeriodicRow[], heartbeatAge: number | null, dbRttMs: number, now = new Date(), daemonAge: number | null = null): Metrics {
  const queues: Record<string, QueueStats> = {};
  const totals = empty();
  for (const row of jobs) {
    const stats = (queues[row.queue] ??= empty());
    const n = Number(row.n);
    if (row.status === "queued" || row.status === "running" || row.status === "failed") {
      stats[row.status] += n;
      totals[row.status] += n;
    }
    const oldest = whole(row.oldestDueSeconds) ?? 0;
    stats.oldestDueSeconds = Math.max(stats.oldestDueSeconds, oldest);
    totals.oldestDueSeconds = Math.max(totals.oldestDueSeconds, oldest);
    const stuck = Number(row.stuck);
    stats.stuckRunning += stuck;
    totals.stuckRunning += stuck;
    const recent = Number(row.recentFailed ?? 0);
    stats.failedRecent += recent;
    totals.failedRecent += recent;
  }
  return {
    generatedAt: now.toISOString(),
    queues,
    totals,
    periodic: periodic.map((p) => ({ name: p.key.replace(/^periodic:/, ""), lastRunAt: p.lastRunAt, ageSeconds: whole(p.ageSeconds) })),
    worker: { heartbeatAgeSeconds: whole(heartbeatAge), daemonAgeSeconds: whole(daemonAge) },
    dbRttMs,
  };
}

/** Counts rows that are not done; finished jobs are an unbounded history and are deliberately left out. */
export async function collectMetrics(): Promise<Metrics> {
  const started = performance.now();
  const jobs = await prisma.$queryRaw<JobRow[]>`
    SELECT queue, status::text AS status, count(*)::int AS n,
           extract(epoch FROM now() - min("runAt") FILTER (WHERE status = 'queued' AND "runAt" <= now()))::float8 AS "oldestDueSeconds",
           count(*) FILTER (WHERE status = 'running' AND "lockedAt" < now() - interval '10 minutes')::int AS stuck,
           count(*) FILTER (WHERE status = 'failed' AND COALESCE("lockedAt", "runAt") > now() - interval '24 hours')::int AS "recentFailed"
    FROM "Job" WHERE status <> 'done' GROUP BY queue, status`;
  const periodic = await prisma.$queryRaw<PeriodicRow[]>`
    SELECT key, extract(epoch FROM now() - "updatedAt")::float8 AS "ageSeconds", value->>'lastRunAt' AS "lastRunAt"
    FROM "PlatformSetting" WHERE starts_with(key, 'periodic:') ORDER BY key`;
  const beat = await prisma.$queryRaw<{ key: string; age: number | null }[]>`
    SELECT key, extract(epoch FROM now() - "updatedAt")::float8 AS age FROM "PlatformSetting" WHERE key IN ('worker:heartbeat', 'worker:daemon')`;
  const ageOf = (key: string) => beat.find((b) => b.key === key)?.age ?? null;
  return shapeMetrics(jobs, periodic, ageOf('worker:heartbeat'), Math.round(performance.now() - started), new Date(), ageOf('worker:daemon'));
}
