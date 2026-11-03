import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const m = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() });
  return { job: m(), metaAsset: m(), leadSequenceRun: m(), leadSequence: m(), lead: m(), contact: m(), conversation: m(), phoneNumber: m(), template: m(), platformSetting: m(), adCampaign: m(), ad: m(), auditLog: m() };
});
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), audit: vi.fn(), ingest: vi.fn(), allowed: new Set<string>() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/auth/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => mocks.allowed.has(id) }));
vi.mock("@/lib/graph", () => ({ graphFetchAs: vi.fn() }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn() }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: vi.fn() }));
vi.mock("@/lib/leads/ingest", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/ingest")>()), ingestForTenant: mocks.ingest }));

import { BLOCKED_DEFER_MS, BLOCKED_GIVE_UP_MS, processRun, runDueSequences } from "@/lib/leads/runner";
import { CATCH_UP_EVERY_MS, CATCH_UP_WINDOW_MS, handleLeadJobForActiveTenants, LEAD_DEFER_MS, MAX_LEAD_DEFERRALS, runSequenceCatchUp, worker } from "@/lib/leads/worker";

const MIN = 60_000;
const DAY = 86_400_000;
const now = new Date("2026-10-27T10:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.allowed.clear();
  mocks.allowed.add("live");
  mocks.audit.mockResolvedValue(undefined);
});

describe("lead fetch jobs of a blocked workspace", () => {
  it("are re-queued 15 minutes later for that workspace only, and the live workspace is ingested now", async () => {
    expect(LEAD_DEFER_MS).toBe(15 * MIN);
    db.metaAsset.findMany.mockResolvedValue([
      { id: "a1", tenantId: "blocked" },
      { id: "a2", tenantId: "live" },
    ]);
    const before = Date.now();
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.ingest.mock.calls.map((c) => c[0])).toEqual(["live"]);
    const [queue, payload, opts] = mocks.enqueue.mock.calls[0] as [string, Record<string, unknown>, { runAt: Date }];
    expect(queue).toBe("lead-fetch");
    expect(payload).toMatchObject({ leadgenId: "L1", pageId: "p1", deferrals: 1, deferredFor: ["blocked"] });
    expect(opts.runAt.getTime() - before).toBeGreaterThanOrEqual(15 * MIN);
    expect(opts.runAt.getTime() - before).toBeLessThan(15 * MIN + 5_000);
  });

  it("keep being re-queued for 7 days (672 times at 15 minutes), then are given up with an audit entry", async () => {
    expect(MAX_LEAD_DEFERRALS * LEAD_DEFER_MS).toBe(7 * DAY);
    expect(MAX_LEAD_DEFERRALS).toBe(672);
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "blocked" }]);
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: MAX_LEAD_DEFERRALS - 1, deferredFor: ["blocked"] });
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ deferrals: MAX_LEAD_DEFERRALS });
    mocks.enqueue.mockClear();
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: MAX_LEAD_DEFERRALS, deferredFor: ["blocked"] });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "blocked", action: "leads.fetch_given_up" }));
  });

  it("are ingested once the workspace is active again, with no further re-queue", async () => {
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "live" }]);
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: 40, deferredFor: ["live"] });
    expect(mocks.ingest).toHaveBeenCalledWith("live", "a1", expect.objectContaining({ leadgenId: "L1" }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("sequence runs of a blocked workspace", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    createdAt: new Date(now.getTime() - DAY),
    stepIndex: 0,
    sequence: { steps: [{ delayMinutes: 0, templateId: "tp1" }, { delayMinutes: 7200, templateId: "tp1" }] },
    ...over,
  });
  const lastUpdate = () => {
    const calls = db.leadSequenceRun.updateMany.mock.calls;
    return calls[calls.length - 1][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
  };

  it("are pushed back 15 minutes, scoped to the tenant", async () => {
    expect(BLOCKED_DEFER_MS).toBe(15 * MIN);
    db.leadSequenceRun.findMany.mockResolvedValue([{ id: "r1", tenantId: "blocked" }]);
    db.leadSequenceRun.findFirst.mockResolvedValue(run());
    expect(await runDueSequences(now)).toBe(0);
    const u = lastUpdate();
    expect(u.where).toMatchObject({ id: "r1", tenantId: "blocked", status: "active" });
    expect((u.data.nextRunAt as Date).getTime()).toBe(now.getTime() + 15 * MIN);
    expect(u.data).not.toHaveProperty("status");
  });

  it("are stopped, not sent late, once the current step is more than 7 days overdue", async () => {
    expect(BLOCKED_GIVE_UP_MS).toBe(7 * DAY);
    db.leadSequenceRun.findMany.mockResolvedValue([{ id: "r1", tenantId: "blocked" }]);
    db.leadSequenceRun.findFirst.mockResolvedValue(run({ createdAt: new Date(now.getTime() - 8 * DAY - MIN) }));
    await runDueSequences(now);
    expect(lastUpdate().data).toMatchObject({ status: "stopped", nextRunAt: null });
  });

  it("measure the 7 days from when the step was due, so a long delay before a later step is not counted as lock time", async () => {
    db.leadSequenceRun.findMany.mockResolvedValue([{ id: "r1", tenantId: "blocked" }]);
    db.leadSequenceRun.findFirst.mockResolvedValue(run({ stepIndex: 1, createdAt: new Date(now.getTime() - 10 * DAY) }));
    await runDueSequences(now);
    expect(lastUpdate().data).toHaveProperty("nextRunAt");
    expect(lastUpdate().data).not.toHaveProperty("status");
  });

  it("processRun releases the lease 15 minutes out when the workspace became blocked", async () => {
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 1 });
    db.leadSequenceRun.findUnique.mockResolvedValue({ id: "r1", tenantId: "blocked", stepIndex: 0, leadId: "l1", createdAt: now, sequence: { steps: [], enabled: true } });
    db.leadSequenceRun.findFirst.mockResolvedValue(run({ createdAt: now }));
    expect(await processRun("r1", now)).toBe(false);
    expect(db.lead.findFirst).not.toHaveBeenCalled();
    expect((lastUpdate().data.nextRunAt as Date).getTime()).toBe(now.getTime() + 15 * MIN);
  });
});

describe("lead fetch deferral is idempotent, not tied to the first attempt", () => {
  beforeEach(() => {
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "blocked" }]);
    db.job.findFirst.mockResolvedValue(null);
  });

  it("a retry after the first attempt died before queueing (asset lookup threw) still schedules the deferral", async () => {
    db.metaAsset.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" })).rejects.toThrow("db down");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a retry after enqueue itself failed schedules again, and the failed attempt surfaces the error so the queue retries", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("queue down"));
    await expect(handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" })).rejects.toThrow("queue down");
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("a job reclaimed after a crash (a later attempt of the same payload) schedules the deferral", async () => {
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ leadgenId: "L1", deferrals: 1, deferredFor: ["blocked"] });
  });

  it("does not queue a second copy while the same deferral is already waiting or running", async () => {
    db.job.findFirst.mockResolvedValue({ id: "queued" });
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const where = db.job.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ queue: "lead-fetch", status: { in: ["queued", "running"] } });
    expect(where.AND).toEqual([
      { payload: { path: ["leadgenId"], equals: "L1" } },
      { payload: { path: ["deferrals"], equals: 1 } },
      { payload: { path: ["deferredFor"], equals: ["blocked"] } },
    ]);
  });

  it("queues anyway when the lookup fails, because a duplicate is harmless (ingest is idempotent) and losing the lead is not", async () => {
    db.job.findFirst.mockRejectedValue(new Error("db down"));
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("lists the blocked workspaces in a stable order so the same deferral is recognised", async () => {
    db.metaAsset.findMany.mockResolvedValue([
      { id: "a1", tenantId: "zeta" },
      { id: "a2", tenantId: "alpha" },
    ]);
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ deferredFor: ["alpha", "zeta"] });
  });
});

describe("the welcome catch-up task (IG-PAGE-ADS-SPEC 3.5, PRM-10 acceptance 2a)", () => {
  it("is scheduled every minute next to the sequence runner", () => {
    expect(worker.periodic.map((p) => [p.name, p.everyMs])).toEqual([
      ["leads.sequences", 30_000],
      ["leads.sequences.catch-up", CATCH_UP_EVERY_MS],
    ]);
    expect(CATCH_UP_EVERY_MS).toBe(MIN);
  });

  it("looks only at running campaigns started in the last 60 minutes, and with none it reads nothing else", async () => {
    db.adCampaign.findMany.mockResolvedValue([]);
    expect(await runSequenceCatchUp(now)).toEqual({ campaigns: 0, started: 0 });
    const since = new Date(now.getTime() - CATCH_UP_WINDOW_MS);
    // First the workspaces with an active campaign changed in the window (Start writes the row), then the campaigns.
    expect(db.adCampaign.findMany.mock.calls[0][0]).toMatchObject({ where: { status: "active", launchedAt: { not: null }, updatedAt: { gte: since } }, distinct: ["tenantId"] });
    const where = db.adCampaign.findMany.mock.calls[1][0].where;
    expect(where).toEqual({ status: "active", launchedAt: { not: null }, OR: [{ launchedAt: { gte: since } }, { startsAt: { gte: since, lte: now } }] });
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.ad.findMany).not.toHaveBeenCalled();
    expect(db.lead.findMany).not.toHaveBeenCalled();
  });

  it("reads Start and resume rows only for workspaces with a changed active campaign, and selects those campaigns by id", async () => {
    const since = new Date(now.getTime() - CATCH_UP_WINDOW_MS);
    db.adCampaign.findMany.mockResolvedValueOnce([{ tenantId: "live" }, { tenantId: "live" }]).mockResolvedValueOnce([]);
    db.auditLog.findMany.mockResolvedValue([
      { tenantId: "live", target: "camp_1", createdAt: new Date(now.getTime() - 30 * MIN) },
      { tenantId: "live", target: "camp_1", createdAt: new Date(now.getTime() - 10 * MIN) },
      { tenantId: "live", target: null, createdAt: new Date(now.getTime() - 5 * MIN) },
    ]);
    expect(await runSequenceCatchUp(now)).toEqual({ campaigns: 0, started: 0 });
    expect(db.auditLog.findMany.mock.calls[0][0].where).toEqual({ tenantId: { in: ["live"] }, action: { in: ["ads.campaign.activated", "ads.campaign.resumed"] }, createdAt: { gte: since, lte: now } });
    expect(db.adCampaign.findMany.mock.calls[1][0].where.OR).toEqual([{ launchedAt: { gte: since } }, { startsAt: { gte: since, lte: now } }, { id: { in: ["camp_1"] } }]);
  });

  it("goes on from the launch time when the audit log cannot be read", async () => {
    db.adCampaign.findMany.mockResolvedValueOnce([{ tenantId: "live" }]).mockResolvedValueOnce([]);
    db.auditLog.findMany.mockRejectedValue(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runSequenceCatchUp(now)).toEqual({ campaigns: 0, started: 0 });
    expect(db.adCampaign.findMany).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("skips a blocked workspace's campaign without reading its ads or leads", async () => {
    db.adCampaign.findMany.mockResolvedValue([{ id: "camp_1", tenantId: "blocked", metaCampaignId: "mc_1", launchedAt: new Date(now.getTime() - 10 * MIN), startsAt: null }]);
    expect(await runSequenceCatchUp(now)).toEqual({ campaigns: 1, started: 0 });
    expect(db.ad.findMany).not.toHaveBeenCalled();
    expect(db.lead.findMany).not.toHaveBeenCalled();
    expect(db.platformSetting.findUnique).not.toHaveBeenCalled();
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });
});
