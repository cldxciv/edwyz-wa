import { prisma } from "@/lib/db";

const TIMEOUT_MS = 2500;
const WORKER_STALE_SECONDS = 15 * 60;
const READY_OK_CACHE_MS = 5000;
const READY_FAIL_CACHE_MS = 1000;

export type WorkerState = "ok" | "stale" | "unknown";
export type HealthReport = {
  status: "ok" | "degraded";
  service: "edwyz-wa";
  db: { ok: boolean; rttMs: number | null };
  worker: { lastTickAgeSeconds: number | null; state: WorkerState };
};
export type ReadyReport = { status: "ready" | "not_ready"; checks: { database: boolean; schema: boolean; migrations: boolean } };

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function workerState(ageSeconds: number | null, staleAfter = WORKER_STALE_SECONDS): WorkerState {
  if (ageSeconds === null) return "unknown";
  return ageSeconds > staleAfter ? "stale" : "ok";
}

/**
 * One query: proves the database answers and reads the freshest worker signal. `worker:heartbeat` is written by the tick
 * route when it is wired (see docs/ops.md); until then the newest `periodic:*` lease row stands in for it.
 */
export async function healthReport(): Promise<HealthReport> {
  const started = performance.now();
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<{ heartbeat: number | null; periodic: number | null }[]>`
        SELECT
          (SELECT extract(epoch FROM now() - max("updatedAt"))::float8 FROM "PlatformSetting" WHERE key = 'worker:heartbeat') AS heartbeat,
          (SELECT extract(epoch FROM now() - max("updatedAt"))::float8 FROM "PlatformSetting" WHERE starts_with(key, 'periodic:')) AS periodic`,
    );
    const rttMs = Math.round(performance.now() - started);
    const raw = rows[0]?.heartbeat ?? rows[0]?.periodic ?? null;
    const age = raw === null ? null : Math.max(0, Math.round(Number(raw)));
    return { status: "ok", service: "edwyz-wa", db: { ok: true, rttMs }, worker: { lastTickAgeSeconds: age, state: workerState(age) } };
  } catch {
    return { status: "degraded", service: "edwyz-wa", db: { ok: false, rttMs: null }, worker: { lastTickAgeSeconds: null, state: "unknown" } };
  }
}

let cached: { at: number; report: ReadyReport } | null = null;

export function resetReadyCache() {
  cached = null;
}

async function readyChecks(): Promise<ReadyReport["checks"]> {
  const checks = { database: false, schema: false, migrations: false };
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<{ tracked: boolean; core: boolean }[]>`
        SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS tracked,
               (to_regclass('"Tenant"') IS NOT NULL AND to_regclass('"Job"') IS NOT NULL AND to_regclass('"PlatformSetting"') IS NOT NULL) AS core`,
    );
    checks.database = true;
    checks.schema = Boolean(rows[0]?.core);
    if (!rows[0]?.tracked) {
      // Migrations applied by hand with psql leave no _prisma_migrations table; the schema check above is the signal then.
      checks.migrations = checks.schema;
      return checks;
    }
    const state = await withTimeout(
      prisma.$queryRaw<{ applied: number | bigint; pending: number | bigint }[]>`
        SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
               count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS pending
        FROM "_prisma_migrations"`,
    );
    checks.migrations = Number(state[0]?.applied ?? 0) > 0 && Number(state[0]?.pending ?? 0) === 0;
  } catch {
    // reported as false below; the response never carries the error
  }
  return checks;
}

export async function readyReport(now = Date.now()): Promise<ReadyReport> {
  if (cached) {
    const ttl = cached.report.status === "ready" ? READY_OK_CACHE_MS : READY_FAIL_CACHE_MS;
    if (now - cached.at < ttl) return cached.report;
  }
  const checks = await readyChecks();
  const report: ReadyReport = { status: checks.database && checks.schema && checks.migrations ? "ready" : "not_ready", checks };
  cached = { at: now, report };
  return report;
}
