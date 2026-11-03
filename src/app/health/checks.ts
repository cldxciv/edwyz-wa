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

/**
 * Something only a given migration creates: a table, a column (`object` is the table, `detail` the column) or an enum value
 * (`object` is the enum type, `detail` the value). Names are as Prisma writes them (case matters).
 */
export type MigrationMarker = { name: string; kind: "table" | "column" | "enum"; object: string; detail?: string };

/**
 * The newest folder in prisma/migrations and what it leaves behind. Migrations on the VPS are applied by hand with psql, so there
 * is no _prisma_migrations ledger to read; this marker is how /health/ready notices a release whose newest migration was skipped
 * (routes using the new column or table would answer 500). Update it in the same change as every new migration:
 * tests/ops-health.test.ts fails while it names an older folder or a marker its migration.sql does not create.
 * An index-only follow-up (CREATE INDEX CONCURRENTLY and VALIDATE CONSTRAINT only, such as 0013_ig_page_ads_indexes) is applied
 * off-peak after the restart and the code works without it, so the marker names the newest migration before it.
 */
export const LATEST_MIGRATION: MigrationMarker = { name: "0015_studio_canva", kind: "table", object: "StudioItem" };

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

async function readyChecks(marker: MigrationMarker): Promise<ReadyReport["checks"]> {
  const checks = { database: false, schema: false, migrations: false };
  const detail = marker.detail ?? "";
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<{ tracked: boolean; core: boolean; latest: boolean }[]>`
        SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS tracked,
               (to_regclass('"Tenant"') IS NOT NULL AND to_regclass('"Job"') IS NOT NULL AND to_regclass('"PlatformSetting"') IS NOT NULL) AS core,
               CASE ${marker.kind}::text
                 WHEN 'table' THEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${marker.object}::text)
                 WHEN 'column' THEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${marker.object}::text AND column_name = ${detail}::text)
                 WHEN 'enum' THEN EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                                          WHERE n.nspname = current_schema() AND t.typname = ${marker.object}::text AND e.enumlabel = ${detail}::text)
                 ELSE false
               END AS latest`,
    );
    checks.database = true;
    checks.schema = Boolean(rows[0]?.core);
    const latest = Boolean(rows[0]?.latest);
    if (!rows[0]?.tracked) {
      // Migrations applied by hand with psql leave no _prisma_migrations table: the schema check and the newest migration's marker
      // are the signal then.
      checks.migrations = checks.schema && latest;
      return checks;
    }
    const state = await withTimeout(
      prisma.$queryRaw<{ applied: number | bigint; pending: number | bigint }[]>`
        SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
               count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS pending
        FROM "_prisma_migrations"`,
    );
    checks.migrations = Number(state[0]?.applied ?? 0) > 0 && Number(state[0]?.pending ?? 0) === 0 && latest;
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
  const checks = await readyChecks(LATEST_MIGRATION);
  const report: ReadyReport = { status: checks.database && checks.schema && checks.migrations ? "ready" : "not_ready", checks };
  cached = { at: now, report };
  return report;
}
