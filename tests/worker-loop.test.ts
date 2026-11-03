import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $executeRaw: vi.fn(async () => 1),
  platformSetting: { findUnique: vi.fn(async (): Promise<unknown> => null) },
  webhookEvent: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
  // What the Eddy module's own sweepers touch (src/worker/eddy.ts).
  actionRecord: { updateMany: vi.fn(async (_args?: unknown) => ({ count: 0 })) },
  eddyTurn: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []), updateMany: vi.fn(async (_args?: unknown) => ({ count: 0 })) },
  eddyConversation: { findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null) },
  membership: { findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null) },
  // The promote opt-out sweep's one lookup: does any customer-list audience exist (src/lib/promote/forget.ts). promote.audiences
  // and the sweep itself (PRM-11) are no longer stubs: each first reads the audiences to work on (findMany), and with none it
  // does nothing else (no write, no Meta call).
  adAudience: { findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null), findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
  // promote.audiences.uploads (PRM-11) first reads the open customer-list uploads, and with none it does nothing else.
  adAudienceUpload: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
  // promote.audience.forget (PRM-11) runs the forget jobs through runDueJobs (mocked below), then deletes the done ones.
  job: { deleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })) },
  // promote.media (PRM-06, src/lib/promote/tasks/media.ts) is no longer a stub: it reads AdMedia for due sends and checks, and
  // with none due it does nothing else (no write, no Meta call).
  adMedia: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []), updateMany: vi.fn(async (_args?: unknown) => ({ count: 0 })) },
  // promote.review and promote.review.sweep (PRM-08, src/lib/promote/review.ts) are no longer stubs: each first reads the platform
  // ads to check, and with none it does nothing else (no write, no Meta call).
  ad: { findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []) },
}));
const eddyDeps = vi.hoisted(() => ({
  reconcileJob: vi.fn(async () => undefined),
  runNoticeScan: vi.fn(async () => ({ tenants: 0, published: 0, resolved: 0, failed: 0 })),
  runEddyRetention: vi.fn(async (_o?: unknown) => ({})),
  runEddyErasureSweep: vi.fn(async () => ({ contactsErased: 0, noticesDeleted: 0, membersForgotten: 0 })),
  loadHistory: vi.fn(async (_c: string, _t: string): Promise<unknown[]> => []),
  repairTail: vi.fn((_e: unknown[]): unknown[] => []),
  appendEntries: vi.fn(async (..._a: unknown[]) => undefined),
  visibilityHashOf: vi.fn((_f: unknown) => "vh_now"),
  viewerRules: vi.fn(async (_a: unknown) => ({ onlyAssigned: false, teamIds: ["tm_1"], includeUnteamed: true, maskPhone: true })),
}));
vi.mock("@/lib/actions/reconcile", () => ({ reconcileQueues: { "actions.reconcile": eddyDeps.reconcileJob } }));
vi.mock("@/lib/notices/scan", () => ({ NOTICE_SCAN_EVERY_MS: 120_000, runNoticeScan: eddyDeps.runNoticeScan }));
vi.mock("@/lib/eddy/retention", () => ({ runEddyRetention: eddyDeps.runEddyRetention }));
vi.mock("@/lib/eddy/erasure-sweep", () => ({ runEddyErasureSweep: eddyDeps.runEddyErasureSweep }));
vi.mock("@/lib/eddy/history", () => ({ loadHistory: eddyDeps.loadHistory, repairTail: eddyDeps.repairTail, appendEntries: eddyDeps.appendEntries }));
vi.mock("@/lib/eddy/conversations", () => ({ STALE_TURN_MS: 3 * 60_000, visibilityHashOf: eddyDeps.visibilityHashOf }));
vi.mock("@/lib/teams/visibility", () => ({ viewerRules: eddyDeps.viewerRules }));
const queue = vi.hoisted(() => ({ runDueJobs: vi.fn(async (_queue: string, _handler: unknown, _batch?: number) => 0) }));
const broadcasts = vi.hoisted(() => ({ runBroadcastQueue: vi.fn(async () => 0) }));
const periodic = vi.hoisted(() => ({ runPeriodic: vi.fn(async (_task: { name: string }) => false) }));
const modulesRan = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/broadcasts/process", () => broadcasts);
vi.mock("@/lib/inbox/send", () => ({ processSendJob: vi.fn() }));
const processor = vi.hoisted(() => ({ processWebhookEvent: vi.fn(async (_id: string) => undefined) }));
vi.mock("@/lib/webhooks/processor", () => processor);
vi.mock("@/lib/wiring", () => ({ wireModules: vi.fn() }));
vi.mock("@/worker/periodic", () => periodic);
vi.mock("@/lib/automation/worker", () => ({ worker: { queues: { automation: vi.fn() }, periodic: [{ name: "automation-task", everyMs: 1, run: vi.fn() }] } }));
vi.mock("@/lib/billing/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/chatbots/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/commerce/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/content/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/conversions/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/inbox/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/integrations/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/leads/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/lifecycle/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/meta-connect/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/onboarding/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/optimizer/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/reports/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/routing/worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/ads/insights-worker", () => ({ worker: { queues: {}, periodic: [] } }));
vi.mock("@/lib/spend/worker", () => ({ worker: { queues: { "spend.stop": vi.fn() }, periodic: [{ name: "spend.commitments.reconcile", everyMs: 120_000, run: vi.fn() }] } }));
vi.mock("@/worker/eddy", () => ({
  worker: {
    queues: { "actions.reconcile": vi.fn() },
    periodic: ["notices.scan", "actions.expire", "eddy.turns.stale", "eddy.retention", "eddy.erasure-sweep"].map((name) => ({ name, everyMs: 60_000, run: vi.fn() })),
  },
}));
// The promote module stands in with one task here; the real module is checked in its own block below (vi.importActual).
vi.mock("@/lib/promote/worker", () => ({ worker: { queues: {}, periodic: [{ name: "promote.media", everyMs: 60_000, run: vi.fn() }] } }));

import { daemonIsAlive } from "@/worker/daemon";
import { resetSweepState, runPass, startWorker, workDone, writeHeartbeat, type PassResult } from "@/worker/loop";

const result = (over: Partial<PassResult> = {}): PassResult => ({ webhook: 0, send: 0, broadcast: 0, swept: 0, queues: {}, periodic: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetSweepState();
  processor.processWebhookEvent.mockResolvedValue(undefined);
  modulesRan.names = [];
  db.$executeRaw.mockResolvedValue(1);
  db.webhookEvent.findMany.mockResolvedValue([]);
  queue.runDueJobs.mockResolvedValue(0);
  periodic.runPeriodic.mockResolvedValue(false);
});
afterEach(() => vi.useRealTimers());

describe("workDone", () => {
  it("is zero for an idle pass and counts every kind of work", () => {
    expect(workDone(result())).toBe(0);
    expect(workDone(result({ webhook: 2, send: 3, broadcast: 1, swept: 1, queues: { a: 2, b: 1 }, periodic: ["x"] }))).toBe(10);
  });

  it("does not count the stale-event sweep, so a bad event cannot hold the daemon on its fast cadence", () => {
    expect(workDone(result({ swept: 10 }))).toBe(0);
  });
});

describe("runPass", () => {
  it("drains the webhook and send queues first and reports what each handled", async () => {
    queue.runDueJobs.mockImplementation(async (q: string) => (q === "webhook" ? 4 : q === "send" ? 2 : 0));
    const r = await runPass();
    expect(r).toMatchObject({ webhook: 4, send: 2 });
    expect(queue.runDueJobs.mock.calls.slice(0, 2).map((c) => c[0])).toEqual(["webhook", "send"]);
  });

  it("runs module queues and, unless told not to, their scheduled tasks", async () => {
    periodic.runPeriodic.mockResolvedValue(true);
    const withTasks = await runPass();
    expect(withTasks.periodic).toEqual(["automation-task", "spend.commitments.reconcile", "notices.scan", "actions.expire", "eddy.turns.stale", "eddy.retention", "eddy.erasure-sweep", "promote.media"]);
    expect(queue.runDueJobs.mock.calls.map((c) => c[0])).toContain("automation");

    periodic.runPeriodic.mockClear();
    const without = await runPass({ periodic: false });
    expect(without.periodic).toEqual([]);
    expect(periodic.runPeriodic).not.toHaveBeenCalled();
  });

  it("claims no further scheduled task once its tasks have run for the budget; the rest stay due, and every queue is still drained", async () => {
    // 10 s per task against the 15 s budget: the second still starts, the third is never claimed (so it is still due next pass)
    periodic.runPeriodic.mockImplementation(async () => {
      vi.advanceTimersByTime(10_000);
      return true;
    });
    const r = await runPass();
    expect(r.periodic).toEqual(["automation-task", "spend.commitments.reconcile"]);
    expect(periodic.runPeriodic).toHaveBeenCalledTimes(2);
    expect(queue.runDueJobs.mock.calls.map((c) => c[0])).toContain("actions.reconcile");
  });
});

describe("the spend module (docs/SPEND-CONTROLS-SPEC.md 4.16)", () => {
  it("is registered in MODULES: its queues are drained and its periodic tasks run in every pass, so tick covers a dead daemon", async () => {
    periodic.runPeriodic.mockResolvedValue(true);
    const r = await runPass();
    expect(queue.runDueJobs.mock.calls.map((c) => c[0])).toContain("spend.stop");
    expect(r.periodic).toContain("spend.commitments.reconcile");
    expect(r.queues).toHaveProperty("spend.stop", 0);
  });

  it("the loop imports the spend worker", () => {
    const loop = readFileSync(path.join(process.cwd(), "src/worker/loop.ts"), "utf8");
    expect(loop).toContain('import { worker as spend } from "@/lib/spend/worker";');
    expect(loop).toMatch(/const MODULES: WorkerModule\[\] = \[[^\]]*\bspend\b[^\]]*\]/);
  });
});

describe("the promote module (docs/IG-PAGE-ADS-SPEC.md 5.5, PRM-00)", () => {
  it("is registered in MODULES: its periodic tasks run in every pass, so tick covers a dead daemon", async () => {
    periodic.runPeriodic.mockResolvedValue(true);
    const r = await runPass();
    expect(r.periodic).toContain("promote.media");
    expect(r.periodic.at(-1)).toBe("promote.media");
  });

  it("the loop imports the promote worker module", () => {
    const loop = readFileSync(path.join(process.cwd(), "src/worker/loop.ts"), "utf8");
    expect(loop).toContain('import { worker as promote } from "@/lib/promote/worker";');
    expect(loop).toMatch(/const MODULES: WorkerModule\[\] = \[[^\]]*\bpromote\b[^\]]*\]/);
  });
});

describe("the Eddy module (docs/EDDY-SPEC.md 8.4, EDDY-16)", () => {
  it("is registered in MODULES: its reconcile queue is drained and its periodic tasks run in every pass, so tick covers a dead daemon", async () => {
    periodic.runPeriodic.mockResolvedValue(true);
    const r = await runPass();
    expect(queue.runDueJobs.mock.calls.map((c) => c[0])).toContain("actions.reconcile");
    expect(r.queues).toHaveProperty("actions.reconcile", 0);
    expect(r.periodic).toEqual(expect.arrayContaining(["notices.scan", "actions.expire", "eddy.turns.stale", "eddy.retention", "eddy.erasure-sweep"]));
  });

  it("the loop imports the Eddy worker module", () => {
    const loop = readFileSync(path.join(process.cwd(), "src/worker/loop.ts"), "utf8");
    expect(loop).toContain('import { worker as eddy } from "./eddy";');
    expect(loop).toMatch(/const MODULES: WorkerModule\[\] = \[[^\]]*\beddy\b[^\]]*\]/);
  });
});

describe("stale event sweep", () => {
  const stale = (...ids: string[]) => db.webhookEvent.findMany.mockResolvedValue(ids.map((id) => ({ id })) as never);

  it("reports the events it processed, oldest first and only within the last day", async () => {
    stale("e1", "e2");
    const r = await runPass();
    expect(r.swept).toBe(2);
    const arg = db.webhookEvent.findMany.mock.calls[0][0] as unknown as { orderBy: unknown; where: { receivedAt: { gt: Date; lt: Date } } };
    expect(arg.orderBy).toEqual({ receivedAt: "asc" });
    expect(arg.where.receivedAt.gt.getTime()).toBeLessThan(arg.where.receivedAt.lt.getTime());
  });

  it("counts only successes, and backs a failing event off instead of retrying it on every pass", async () => {
    stale("poison", "good");
    processor.processWebhookEvent.mockImplementation(async (id: string) => {
      if (id === "poison") throw new Error("always fails");
    });
    expect((await runPass()).swept).toBe(1);
    // Within a minute the sweep does not run again at all.
    await vi.advanceTimersByTimeAsync(30_000);
    processor.processWebhookEvent.mockClear();
    expect((await runPass()).swept).toBe(0);
    expect(processor.processWebhookEvent).not.toHaveBeenCalled();
    // After a minute it runs, but the poison event is excluded from the query so it cannot starve the rest.
    await vi.advanceTimersByTimeAsync(31_000);
    await runPass();
    const where = (db.webhookEvent.findMany.mock.calls.at(-1)![0] as unknown as { where: { id?: { notIn: string[] } } }).where;
    expect(where.id).toEqual({ notIn: ["poison"] });
  });

  it("a permanently failing event does not keep the daemon on its fast cadence", async () => {
    stale("poison");
    processor.processWebhookEvent.mockRejectedValue(new Error("always fails"));
    const worker = startWorker({ intervalMs: 2000, busyDelayMs: 100, periodicEveryMs: 1_000_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const passes = queue.runDueJobs.mock.calls.filter((c) => c[0] === "webhook").length;
    expect(passes).toBeLessThanOrEqual(6);
    expect(processor.processWebhookEvent.mock.calls.length).toBe(1);
    await worker.stop();
  });

  it("runs about once a minute, not on every 2 second pass", async () => {
    stale();
    await runPass();
    await runPass();
    expect(db.webhookEvent.findMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await runPass();
    expect(db.webhookEvent.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("daemon heartbeat and tick stand-down", () => {
  it("the daemon heartbeat writes both worker:heartbeat and worker:daemon", async () => {
    await writeHeartbeat();
    const sql = (db.$executeRaw.mock.calls[0] as unknown as [string[]])[0].join("?");
    expect(sql).toContain("worker:heartbeat");
    expect(sql).toContain("worker:daemon");
  });

  it("daemonIsAlive is true only for a fresh heartbeat and false when it cannot be read", async () => {
    const now = Date.now();
    db.platformSetting.findUnique.mockResolvedValue({ updatedAt: new Date(now - 20_000) });
    expect(await daemonIsAlive(now)).toBe(true);
    db.platformSetting.findUnique.mockResolvedValue({ updatedAt: new Date(now - 120_000) });
    expect(await daemonIsAlive(now)).toBe(false);
    db.platformSetting.findUnique.mockResolvedValue(null);
    expect(await daemonIsAlive(now)).toBe(false);
    db.platformSetting.findUnique.mockRejectedValue(new Error("down"));
    expect(await daemonIsAlive(now)).toBe(false);
  });

  it("the tick route stands down while the daemon is alive", () => {
    const tick = readFileSync(path.join(process.cwd(), "src/app/api/internal/tick/route.ts"), "utf8");
    expect(tick).toContain("daemonIsAlive");
    expect(tick.indexOf("daemonIsAlive()")).toBeLessThan(tick.indexOf("await runPass()"));
  });
});

describe("writeHeartbeat", () => {
  it("never throws when the database write fails", async () => {
    db.$executeRaw.mockRejectedValueOnce(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(writeHeartbeat()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("startWorker", () => {
  const passes = () => queue.runDueJobs.mock.calls.filter((c) => c[0] === "webhook").length;

  it("polls again after the interval when idle and writes the heartbeat", async () => {
    const worker = startWorker({ intervalMs: 2000, heartbeatEveryMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2);
    expect(db.$executeRaw).toHaveBeenCalled();
    await worker.stop();
  });

  it("polls again quickly while there is work", async () => {
    queue.runDueJobs.mockImplementation(async (q: string) => (q === "send" ? 1 : 0));
    const worker = startWorker({ intervalMs: 2000, busyDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(passes()).toBeGreaterThanOrEqual(3);
    await worker.stop();
  });

  it("keeps going after a failed pass and does not log message content", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queue.runDueJobs.mockRejectedValueOnce(new Error("boom for +919876543210"));
    const worker = startWorker({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2100);
    expect(passes()).toBeGreaterThanOrEqual(2);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("919876543210");
    spy.mockRestore();
    await worker.stop();
  });

  it("stop waits for the pass in progress and then never polls again", async () => {
    let release: () => void = () => undefined;
    queue.runDueJobs.mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(0))));
    const worker = startWorker({ intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    const before = passes();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(passes()).toBe(before);
  });

  it("never runs two passes at the same time in one process", async () => {
    let active = 0;
    let peak = 0;
    queue.runDueJobs.mockImplementation(async (q: string) => {
      if (q !== "webhook") return 0;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3000));
      active--;
      return 0;
    });
    const worker = startWorker({ intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peak).toBe(1);
    const stopping = worker.stop();
    await vi.advanceTimersByTimeAsync(4000);
    await stopping;
  });
});

describe("wiring of the daemon", () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  it("every src/lib/<area>/worker.ts is registered in the loop", () => {
    const loop = read("src/worker/loop.ts");
    const areas = readdirSync(path.join(root, "src/lib"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((d) => {
        try {
          readFileSync(path.join(root, "src/lib", d, "worker.ts"));
          return true;
        } catch {
          return false;
        }
      });
    expect(areas.length).toBeGreaterThan(10);
    for (const area of areas) expect(loop, area).toContain(`@/lib/${area}/worker`);
  });

  it("the daemon handles SIGTERM and SIGINT, stops the loop and forces an exit after 25 seconds", () => {
    const daemon = read("src/worker/index.ts");
    expect(daemon).toMatch(/process\.on\("SIGTERM"/);
    expect(daemon).toMatch(/process\.on\("SIGINT"/);
    expect(daemon).toContain("await worker.stop()");
    expect(daemon).toContain("25_000");
    expect(daemon).toMatch(/intervalMs: Number\.isFinite\(interval\) && interval >= 250 \? interval : 2000/);
  });

  it("the tick route stays as the documented fallback and uses the same pass", () => {
    const tick = read("src/app/api/internal/tick/route.ts");
    expect(tick).toContain("runPass");
    expect(tick).toContain("x-worker-secret");
  });
});

// =====================================================================================================================
// The real Eddy WorkerModule (src/worker/eddy.ts): schedule, sweepers, and an import graph that never reaches the model
// =====================================================================================================================

describe("src/worker/eddy.ts (docs/EDDY-SPEC.md 8.4, EDDY-16 acceptance 1)", () => {
  type EddyModule = typeof import("@/worker/eddy");
  const real = () => vi.importActual<EddyModule>("@/worker/eddy");

  beforeEach(() => vi.useRealTimers());

  it("consumes actions.reconcile and schedules notices.scan 120 s, actions.expire 60 s, eddy.turns.stale 60 s, retention and erasure daily", async () => {
    const { worker } = await real();
    expect(worker.queues["actions.reconcile"]).toBe(eddyDeps.reconcileJob);
    expect(Object.keys(worker.queues)).toEqual(["actions.reconcile"]);
    expect(worker.periodic.map((p) => [p.name, p.everyMs])).toEqual([
      ["notices.scan", 120_000],
      ["actions.expire", 60_000],
      ["eddy.turns.stale", 60_000],
      ["eddy.retention", 86_400_000],
      ["eddy.erasure-sweep", 86_400_000],
    ]);
    for (const task of worker.periodic) await task.run();
    expect(eddyDeps.runNoticeScan).toHaveBeenCalledTimes(1);
    expect(eddyDeps.runEddyErasureSweep).toHaveBeenCalledTimes(1);
    expect(eddyDeps.runEddyRetention).toHaveBeenCalledWith({ visibilityHashFor: expect.any(Function) });
    expect(db.actionRecord.updateMany).toHaveBeenCalled();
    expect(db.eddyTurn.findMany).toHaveBeenCalled();
  });

  it("actions.expire turns pending and awaiting-approval cards past their expiry into expired, nothing else", async () => {
    const { expireActions } = await real();
    db.actionRecord.updateMany.mockResolvedValueOnce({ count: 3 });
    const now = new Date("2026-10-29T06:30:00.000Z");
    expect(await expireActions(now)).toBe(3);
    expect(db.actionRecord.updateMany).toHaveBeenCalledWith({ where: { status: { in: ["pending", "awaiting_approval"] }, expiresAt: { lt: now } }, data: { status: "expired", updatedAt: now } });
  });

  it("eddy.turns.stale aborts turns running for over 3 minutes and repairs the tail once, only for the turn it moved", async () => {
    const { clearStaleTurns } = await real();
    const now = new Date("2026-10-29T06:30:00.000Z");
    db.eddyTurn.findMany.mockResolvedValueOnce([
      { id: "tu_1", tenantId: "t1", conversationId: "c_1" },
      { id: "tu_2", tenantId: "t1", conversationId: "c_2" },
      { id: "tu_3", tenantId: "t1", conversationId: "c_3" },
      { id: "tu_4", tenantId: "t1", conversationId: null },
    ]);
    // tu_2 was cleared by the turn route meanwhile (count 0): it is not repaired again.
    db.eddyTurn.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    db.eddyConversation.findFirst.mockImplementation(async (args?: unknown) => ((args as { where: { id: string } }).where.id === "c_3" ? { status: "erased" } : { status: "active" }));
    const fix = [{ role: "assistant", kind: "placeholder", content: [] }];
    eddyDeps.repairTail.mockReturnValue(fix);
    expect(await clearStaleTurns(now)).toBe(3);
    const where = (db.eddyTurn.findMany.mock.calls[0][0] as { where: { status: string; startedAt: { lt: Date } } }).where;
    expect(where.status).toBe("running");
    expect(where.startedAt.lt.getTime()).toBe(now.getTime() - 3 * 60_000);
    expect(db.eddyTurn.updateMany.mock.calls[0][0]).toEqual({ where: { id: "tu_1", tenantId: "t1", status: "running" }, data: { status: "aborted", errorCode: "stale", endedAt: now } });
    expect(eddyDeps.loadHistory).toHaveBeenCalledTimes(1);
    expect(eddyDeps.appendEntries).toHaveBeenCalledTimes(1);
    expect(eddyDeps.appendEntries.mock.calls[0].slice(0, 3)).toEqual([{ id: "c_1", tenantId: "t1" }, null, fix]);
  });

  it("the member's visibility hash for retention: the routes' facts, or null when they left", async () => {
    const { memberVisibilityHash } = await real();
    expect(await memberVisibilityHash("t1", "u_gone")).toBeNull();
    db.membership.findFirst.mockResolvedValueOnce({ role: "agent" });
    expect(await memberVisibilityHash("t1", "u_1")).toBe("vh_now");
    expect(eddyDeps.viewerRules).toHaveBeenCalledWith({ tenantId: "t1", userId: "u_1", role: "agent" });
    expect(eddyDeps.visibilityHashOf).toHaveBeenCalledWith({ roleClass: "agent", teamIds: ["tm_1"], includeUnteamed: true, onlyAssigned: false, maskPhone: true });
  });

  it("the worker's import graph (src/worker/eddy.ts and the daemon) never reaches Eddy's loop, its model binding, the streaming gateway or the SDK", { timeout: 120_000 }, async () => {
    const { build } = await import("esbuild");
    const root = process.cwd();
    const result = await build({
      entryPoints: [path.join(root, "src/worker/eddy.ts"), path.join(root, "src/worker/index.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      tsconfig: path.join(root, "tsconfig.json"),
      metafile: true,
      logLevel: "silent",
      absWorkingDir: root,
      outdir: path.join(root, ".worker-loop-graph"),
    });
    const inputs = Object.keys(result.metafile!.inputs).map((p) => p.split(path.sep).join("/"));
    expect(inputs).toContain("src/worker/eddy.ts");
    expect(inputs).toContain("src/lib/notices/scan.ts");
    expect(inputs).toContain("src/lib/actions/reconcile.ts");
    for (const banned of ["src/lib/eddy/loop.ts", "src/lib/eddy/model-binding.ts", "src/lib/spend/exec/ai-stream.ts"]) expect(inputs, banned).not.toContain(banned);
    const externals = Object.values(result.metafile!.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
    expect(externals.filter((e) => /^@anthropic-ai\/sdk(\/|$)/.test(e))).toEqual([]);
    const src = readFileSync(path.join(root, "src/worker/eddy.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/from "@\/lib\/eddy\/(loop|model-binding)"|ai-stream|@anthropic-ai\/sdk/);
  });
});

// =====================================================================================================================
// The real promote WorkerModule (src/lib/promote/worker.ts): schedule, the PROMOTE_ENABLED gate and no-op task stubs
// =====================================================================================================================

describe("src/lib/promote/worker.ts (docs/IG-PAGE-ADS-SPEC.md 5.5, PRM-00 acceptance 5)", () => {
  type PromoteModule = typeof import("@/lib/promote/worker");
  const real = () => vi.importActual<PromoteModule>("@/lib/promote/worker");
  const saved = process.env.PROMOTE_ENABLED;
  const dbCalls = () =>
    [db.$executeRaw, db.platformSetting.findUnique, db.webhookEvent.findMany, db.actionRecord.updateMany, db.eddyTurn.findMany, db.eddyTurn.updateMany, db.eddyConversation.findFirst, db.membership.findFirst]
      .reduce((n, fn) => n + fn.mock.calls.length, 0);

  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    if (saved === undefined) delete process.env.PROMOTE_ENABLED;
    else process.env.PROMOTE_ENABLED = saved;
    db.adAudience.findFirst.mockReset();
    db.adAudience.findFirst.mockResolvedValue(null);
  });

  it("has no queues and the seven tasks of 5.5 at their intervals, plus PRM-11's forget jobs every minute and uploads every 2 minutes", async () => {
    const { worker } = await real();
    expect(worker.queues).toEqual({});
    expect(worker.periodic.map((p) => [p.name, p.everyMs])).toEqual([
      ["promote.media", 60_000],
      ["promote.review", 15 * 60_000],
      ["promote.review.sweep", 2 * 3_600_000],
      ["promote.leads.backfill", 30 * 60_000],
      ["promote.audiences", 6 * 3_600_000],
      ["promote.audiences.optout", 24 * 3_600_000],
      ["promote.breakdowns", 6 * 3_600_000],
      ["promote.audience.forget", 60_000],
      ["promote.audiences.uploads", 2 * 60_000],
    ]);
  });

  // The privacy duties of 5.5 (the opt-out sweep and the forget jobs) run whatever PROMOTE_ENABLED says.
  const PRIVACY_TASKS = ["promote.audiences.optout", "promote.audience.forget"];

  it("every feature task returns at once, with no database call, while PROMOTE_ENABLED is off, unset or unknown", async () => {
    const { worker, SKIPPED_OFF } = await real();
    for (const value of [undefined, "off", "enabled"]) {
      if (value === undefined) delete process.env.PROMOTE_ENABLED;
      else process.env.PROMOTE_ENABLED = value;
      for (const task of worker.periodic.filter((t) => !PRIVACY_TASKS.includes(t.name))) expect(await task.run(), `${task.name} with ${value}`).toEqual(SKIPPED_OFF);
    }
    expect(dbCalls()).toBe(0);
    expect(db.adAudience.findFirst).not.toHaveBeenCalled();
  });

  it("the opt-out sweep is a privacy duty: it runs while PROMOTE_ENABLED is off whenever a customer-list audience exists", async () => {
    const { worker, SKIPPED_NO_CUSTOMER_LISTS } = await real();
    const optout = worker.periodic.find((t) => t.name === "promote.audiences.optout")!;
    for (const value of [undefined, "off", "admins", "on"]) {
      if (value === undefined) delete process.env.PROMOTE_ENABLED;
      else process.env.PROMOTE_ENABLED = value;
      // None exists: one lookup, nothing else (no Meta call, no other table).
      db.adAudience.findFirst.mockClear();
      db.adAudience.findFirst.mockResolvedValueOnce(null);
      expect(await optout.run(), `none with ${value}`).toEqual(SKIPPED_NO_CUSTOMER_LISTS);
      expect(db.adAudience.findFirst).toHaveBeenCalledTimes(1);
      expect(db.adAudience.findFirst).toHaveBeenCalledWith({ where: { kind: "customer_list", deletedAt: null }, select: { id: true } });
      // One exists (a kill switch or rollback after P4): the sweep runs.
      db.adAudience.findFirst.mockResolvedValueOnce({ id: "aud_1" });
      expect(await optout.run(), `one with ${value}`).toEqual({ contacts: 0, queued: 0 });
    }
    expect(dbCalls()).toBe(0);
  });

  it("once enabled, each feature task calls its function in src/lib/promote/tasks, which with nothing to do touches neither the other tables nor Meta", async () => {
    const { worker } = await real();
    db.adAudience.findFirst.mockResolvedValue({ id: "aud_1" });
    for (const value of ["admins", "on"]) {
      process.env.PROMOTE_ENABLED = value;
      const results = Object.fromEntries(await Promise.all(worker.periodic.map(async (t) => [t.name, await t.run()] as const)));
      expect(results).toEqual({
        "promote.media": { uploaded: 0, polled: 0, failed: 0 },
        "promote.review": { checked: 0, changed: 0, failed: 0 },
        "promote.review.sweep": { checked: 0, changed: 0, failed: 0 },
        "promote.leads.backfill": { forms: 0, leads: 0, failed: 0 },
        "promote.audiences": { audiences: 0, updated: 0, failed: 0 },
        "promote.audiences.optout": { contacts: 0, queued: 0 },
        "promote.breakdowns": { campaigns: 0, rows: 0, failed: 0 },
        "promote.audience.forget": { sent: 0, purged: 0 },
        "promote.audiences.uploads": { uploads: 0, done: 0, waiting: 0, failed: 0 },
      });
    }
    expect(dbCalls()).toBe(0);
    // Only the opt-out sweep looked: once per run.
    expect(db.adAudience.findFirst).toHaveBeenCalledTimes(2);
  });

  it("the module, its flags and the task stubs import neither the database nor the Graph client, and call no fetch", () => {
    const dir = path.join(process.cwd(), "src/lib/promote");
    for (const file of ["worker.ts", "flags.ts", ...readdirSync(path.join(dir, "tasks")).map((f) => `tasks/${f}`)]) {
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/from "@\/lib\/(db|graph|ads\/client)"/);
      expect(src, file).not.toMatch(/\bfetch\(/);
    }
    expect(readdirSync(path.join(dir, "tasks")).sort()).toEqual(["audiences.ts", "backfill.ts", "breakdowns.ts", "media.ts", "review.ts"]);
  });
});
