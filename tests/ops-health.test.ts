import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queue: [] as unknown[], calls: 0 }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      db.calls += 1;
      const next = db.queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  },
}));

import { healthReport, readyReport, resetReadyCache, workerState } from "@/app/health/checks";
import { shapeMetrics } from "@/app/api/internal/metrics/collect";
import { GET as metricsGet } from "@/app/api/internal/metrics/route";
import { GET as healthGet } from "@/app/health/route";
import { GET as readyGet } from "@/app/health/ready/route";

beforeEach(() => {
  db.queue = [];
  db.calls = 0;
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
    db.queue.push([{ tracked: true, core: true }], [{ applied: 5, pending: 0 }]);
    const response = await readyGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { database: true, schema: true, migrations: true } });
  });

  it("is not ready while a migration is unfinished", async () => {
    db.queue.push([{ tracked: true, core: true }], [{ applied: 5, pending: 1 }]);
    const response = await readyGet();
    expect(response.status).toBe(503);
    expect((await response.json()).checks.migrations).toBe(false);
  });

  it("falls back to the schema check when migrations were applied by hand", async () => {
    db.queue.push([{ tracked: false, core: true }]);
    expect((await readyReport()).status).toBe("ready");
    resetReadyCache();
    db.queue.push([{ tracked: false, core: false }]);
    expect((await readyReport()).status).toBe("not_ready");
  });

  it("is not ready, with no detail, when the database is unreachable", async () => {
    db.queue.push(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const response = await readyGet();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("ECONNREFUSED");
  });

  it("caches a ready answer briefly so probes stay cheap", async () => {
    db.queue.push([{ tracked: false, core: true }]);
    await readyReport(1000);
    await readyReport(2000);
    expect(db.calls).toBe(1);
    db.queue.push([{ tracked: false, core: true }]);
    await readyReport(7000);
    expect(db.calls).toBe(2);
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
