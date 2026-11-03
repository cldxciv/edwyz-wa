import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queue: [] as unknown[], calls: 0, sql: [] as { text: string; values: unknown[] }[] }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      db.calls += 1;
      db.sql.push({ text: strings.join("?"), values });
      const next = db.queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  },
}));

import { healthReport, LATEST_MIGRATION, readyReport, resetReadyCache, workerState } from "@/app/health/checks";
import { splitSqlStatements } from "./helpers/pg";
import { shapeMetrics } from "@/app/api/internal/metrics/collect";
import { GET as metricsGet } from "@/app/api/internal/metrics/route";
import { GET as healthGet } from "@/app/health/route";
import { GET as readyGet } from "@/app/health/ready/route";

beforeEach(() => {
  db.queue = [];
  db.calls = 0;
  db.sql = [];
  resetReadyCache();
  process.env.WORKER_SECRET = "worker-secret-for-tests";
});

describe("GET /health", () => {
  it("returns ok with round trip time and worker age, using one query", async () => {
    db.queue.push([{ heartbeat: null, periodic: 42.4 }]);
    const response = await healthGet();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "edwyz-wa", db: { ok: true }, worker: { lastTickAgeSeconds: 42, state: "ok" } });
    expect(typeof body.db.rttMs).toBe("number");
    expect(db.calls).toBe(1);
  });

  it("prefers the explicit heartbeat over periodic lease rows", async () => {
    db.queue.push([{ heartbeat: 5, periodic: 4000 }]);
    expect((await healthReport()).worker.lastTickAgeSeconds).toBe(5);
  });

  it("flags a stale or unknown worker without failing the probe", () => {
    expect(workerState(null)).toBe("unknown");
    expect(workerState(1200)).toBe("stale");
    expect(workerState(30)).toBe("ok");
  });

  it("returns 503 without any error text when the database is down", async () => {
    db.queue.push(new Error('password authentication failed for user "edwyz_wa_app"'));
    const response = await healthGet();
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('"degraded"');
    expect(text).not.toMatch(/password|edwyz_wa_app/);
  });
});

describe("GET /health/ready", () => {
  it("is ready when the schema exists and migrations are complete", async () => {
    db.queue.push([{ tracked: true, core: true, latest: true }], [{ applied: 5, pending: 0 }]);
    const response = await readyGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { database: true, schema: true, migrations: true } });
  });

  it("is not ready while a migration is unfinished", async () => {
    db.queue.push([{ tracked: true, core: true, latest: true }], [{ applied: 5, pending: 1 }]);
    const response = await readyGet();
    expect(response.status).toBe(503);
    expect((await response.json()).checks.migrations).toBe(false);
  });

  it("falls back to the schema check and the newest migration's marker when migrations were applied by hand", async () => {
    db.queue.push([{ tracked: false, core: true, latest: true }]);
    expect((await readyReport()).status).toBe("ready");
    resetReadyCache();
    db.queue.push([{ tracked: false, core: false, latest: true }]);
    expect((await readyReport()).status).toBe("not_ready");
  });

  it("is not ready when the newest migration was skipped, although the core tables exist (the hand-applied VPS case)", async () => {
    db.queue.push([{ tracked: false, core: true, latest: false }]);
    const response = await readyGet();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", checks: { database: true, schema: true, migrations: false } });
    resetReadyCache();
    db.queue.push([{ tracked: true, core: true, latest: false }], [{ applied: 11, pending: 0 }]);
    expect((await readyReport()).checks.migrations).toBe(false);
  });

  it("checks the marker with bound parameters, never by pasting names into the SQL", async () => {
    db.queue.push([{ tracked: false, core: true, latest: true }]);
    await readyReport();
    const { text, values } = db.sql[0];
    expect(values).toEqual([LATEST_MIGRATION.kind, LATEST_MIGRATION.object, LATEST_MIGRATION.object, LATEST_MIGRATION.detail ?? "", LATEST_MIGRATION.object, LATEST_MIGRATION.detail ?? ""]);
    expect(text).not.toContain(LATEST_MIGRATION.object);
    for (const kind of ["'table'", "'column'", "'enum'"]) expect(text).toContain(kind);
  });

  it("is not ready, with no detail, when the database is unreachable", async () => {
    db.queue.push(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const response = await readyGet();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("ECONNREFUSED");
  });

  it("caches a ready answer briefly so probes stay cheap", async () => {
    db.queue.push([{ tracked: false, core: true, latest: true }]);
    await readyReport(1000);
    await readyReport(2000);
    expect(db.calls).toBe(1);
    db.queue.push([{ tracked: false, core: true, latest: true }]);
    await readyReport(7000);
    expect(db.calls).toBe(2);
  });
});

describe("LATEST_MIGRATION (update it with every new migration)", () => {
  const dir = path.join(__dirname, "..", "prisma", "migrations");
  const folders = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()).sort();
  /** An index-only follow-up (0010, 0013): applied WITHOUT -1, off-peak, after the restart; the code works before it lands. */
  const indexOnly = (name: string) => {
    const parts = splitSqlStatements(readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
    return parts.length > 0 && parts.every((s) => /^CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS "\w+"/.test(s) || /^ALTER TABLE "\w+" VALIDATE CONSTRAINT "\w+"$/.test(s));
  };
  const needed = folders.filter((name) => !indexOnly(name));

  it("names the newest folder in prisma/migrations the code needs (only index-only follow-ups may come after it)", () => {
    expect(LATEST_MIGRATION.name, `a new migration was added: point LATEST_MIGRATION in src/app/health/checks.ts at ${needed.at(-1)}`).toBe(needed.at(-1));
    expect(indexOnly("0010_spend_message_indexes")).toBe(true);
    expect(indexOnly("0011_template_flagged")).toBe(false);
  });

  it("names something that migration's SQL really creates", () => {
    const sql = readFileSync(path.join(dir, LATEST_MIGRATION.name, "migration.sql"), "utf8");
    const { kind, object, detail } = LATEST_MIGRATION;
    if (kind === "table") expect(sql).toMatch(new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${object}"`));
    if (kind === "column") expect(sql).toMatch(new RegExp(`ALTER TABLE "${object}"[^;]*ADD COLUMN (IF NOT EXISTS )?"${detail}"`));
    if (kind === "enum") expect(sql).toMatch(new RegExp(`ALTER TYPE "${object}" ADD VALUE (IF NOT EXISTS )?'${detail}'`));
    if (kind !== "table") expect(detail).toBeTruthy();
  });
});

describe("metrics", () => {
  it("shapes queue depths, oldest due age, failures and periodic runs", () => {
    const metrics = shapeMetrics(
      [
        { queue: "send", status: "queued", n: 7, oldestDueSeconds: 31.6, stuck: 0 },
        { queue: "send", status: "running", n: 2, oldestDueSeconds: null, stuck: 1 },
        { queue: "send", status: "failed", n: 3, oldestDueSeconds: null, stuck: 0, recentFailed: 1 },
        { queue: "webhook", status: "queued", n: 1, oldestDueSeconds: 4, stuck: 0 },
      ],
      [{ key: "periodic:billing-renew", ageSeconds: 120.2, lastRunAt: "2026-10-27T01:00:00Z" }],
      9.4,
      12,
      new Date("2026-10-27T01:02:00Z"),
      45.2,
    );
    expect(metrics.queues.send).toEqual({ queued: 7, running: 2, failed: 3, failedRecent: 1, oldestDueSeconds: 32, stuckRunning: 1 });
    expect(metrics.totals).toEqual({ queued: 8, running: 2, failed: 3, failedRecent: 1, oldestDueSeconds: 32, stuckRunning: 1 });
    expect(metrics.periodic).toEqual([{ name: "billing-renew", lastRunAt: "2026-10-27T01:00:00Z", ageSeconds: 120 }]);
    expect(metrics.worker.heartbeatAgeSeconds).toBe(9);
    expect(metrics.worker.daemonAgeSeconds).toBe(45);
  });

  it("rejects requests without the worker secret", async () => {
    for (const headers of [{} as Record<string, string>, { "x-worker-secret": "wrong" }]) {
      const response = await metricsGet(new Request("http://x/api/internal/metrics", { headers }));
      expect(response.status).toBe(403);
    }
    expect(db.calls).toBe(0);
  });

  it("serves metrics for the right secret and never includes it", async () => {
    db.queue.push([{ queue: "send", status: "queued", n: 1, oldestDueSeconds: 2, stuck: 0 }], [], []);
    const response = await metricsGet(new Request("http://x/api/internal/metrics", { headers: { "x-worker-secret": "worker-secret-for-tests" } }));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('"send"');
    expect(text).not.toContain("worker-secret-for-tests");
  });

  it("refuses everything when WORKER_SECRET is unset", async () => {
    delete process.env.WORKER_SECRET;
    const response = await metricsGet(new Request("http://x/api/internal/metrics", { headers: { "x-worker-secret": "" } }));
    expect(response.status).toBe(403);
  });
});
