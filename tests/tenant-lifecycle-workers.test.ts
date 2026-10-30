import { beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const fnFor = vi.hoisted(() => (key: string) => {
  let f = fns.get(key);
  if (!f) {
    const method = key.split(".")[1];
    f = vi.fn(async () => (method === "findMany" ? [] : method === "updateMany" ? { count: 1 } : null));
    fns.set(key, f);
  }
  return f;
});
const state = vi.hoisted(() => ({ allowed: new Set<string>() }));
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  graph: vi.fn(),
  enqueue: vi.fn(),
  debugToken: vi.fn(),
  getAssetAccess: vi.fn(),
  listAssets: vi.fn(),
  ingest: vi.fn(),
  publishFacebook: vi.fn(),
  audit: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: (_t, model) => new Proxy({}, { get: (_t2, method) => fnFor(`${String(model)}.${String(method)}`) }) }),
}));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => state.allowed.has(id) }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(), assertWithinLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: mocks.send }));
vi.mock("@/lib/graph", async () => {
  class GraphError extends Error {
    code = 0;
    retryable = false;
  }
  return { graphFetchAs: mocks.graph, GraphError, appGraphFetch: mocks.graph };
});
vi.mock("@/lib/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: mocks.getAssetAccess, listAssets: mocks.listAssets }));
vi.mock("@/lib/meta-connect/service", () => ({ debugToken: mocks.debugToken, healthStatus: () => "active", disconnect: vi.fn() }));
vi.mock("@/lib/ads/service", () => ({ pauseCampaign: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({ openSecret: () => "token", sealSecret: () => "sealed" }));
vi.mock("@/lib/routing", () => ({ assignConversation: vi.fn() }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: vi.fn() }));
vi.mock("@/lib/leads/ingest", async (orig) => ({ ...(await orig<typeof import("@/lib/leads/ingest")>()), ingestForTenant: mocks.ingest }));
vi.mock("@/lib/content/publishers", () => ({
  PublishError: class PublishError extends Error {
    retry = false;
  },
  publishFacebook: mocks.publishFacebook,
  publishInstagram: vi.fn(),
  publishThreads: vi.fn(),
}));

import { processCart, processDueReminders } from "@/lib/commerce/reminders";
import { deliverConversion } from "@/lib/conversions/worker";
import { syncTenant } from "@/lib/ads/insights-sync";
import { checkTokenHealth } from "@/lib/meta-connect/worker";
import { runForTenant } from "@/lib/optimizer/engine";
import { claimDue, expireStalePosts, processPost } from "@/lib/content/publish";
import { handleLeadJobForActiveTenants, MAX_LEAD_DEFERRALS } from "@/lib/leads/worker";
import { processRun, runDueSequences, startSequenceForLead } from "@/lib/leads/runner";

const f = (key: string) => fnFor(key);
const now = new Date("2026-10-27T10:00:00Z");

beforeEach(() => {
  fns.clear();
  vi.clearAllMocks();
  state.allowed = new Set();
});

describe("commerce reminders", () => {
  const cart = { id: "k1", tenantId: "t1", storeId: "s1", phone: "9198", items: {}, totalMinor: 1, currency: "INR", checkoutUrl: "https://x", stage: "cart", remindersSent: 0, nextReminderAt: now, createdAt: now };
  it("defers a cart of a blocked workspace: no message, not expired, not counted as sent", async () => {
    expect(await processCart(cart, now)).toBe("deferred");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(f("contact.findFirst")).not.toHaveBeenCalled();
    const updates = f("abandonedCart.updateMany").mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("nextReminderAt");
    expect(updates[0]).not.toHaveProperty("status");
    expect(updates[0]).not.toHaveProperty("remindersSent");
  });
  it("does not even expire an old cart of a blocked workspace", async () => {
    await processCart({ ...cart, createdAt: new Date(now.getTime() - 10 * 86_400_000) }, now);
    expect(f("abandonedCart.updateMany").mock.calls.every((c) => !("status" in (c[0] as { data: object }).data))).toBe(true);
  });
  it("the batch loop reports the blocked cart as deferred", async () => {
    f("abandonedCart.findMany").mockResolvedValueOnce([cart]);
    expect((await processDueReminders(now)).deferred).toBe(1);
  });
});

describe("lead sequences", () => {
  it("does not start a sequence for a blocked workspace", async () => {
    const lead = { id: "l1", tenantId: "t1", contactId: "c1", fields: {}, status: "new", assignedToId: null, leadFormId: null, campaignMetaId: null };
    expect(await startSequenceForLead("t1", lead, now)).toBeNull();
    expect(f("leadSequence.findMany")).not.toHaveBeenCalled();
    expect(f("leadSequenceRun.create")).not.toHaveBeenCalled();
  });
  it("pushes a blocked tenant's due run back instead of running or stopping it", async () => {
    f("leadSequenceRun.findMany").mockResolvedValueOnce([{ id: "r1", tenantId: "t1" }]);
    expect(await runDueSequences(now)).toBe(0);
    const calls = f("leadSequenceRun.updateMany").mock.calls.map((c) => c[0] as { data: Record<string, unknown> });
    expect(calls).toHaveLength(1);
    expect(calls[0].data).not.toHaveProperty("status");
    expect((calls[0].data.nextRunAt as Date).getTime()).toBeGreaterThan(now.getTime());
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("processRun releases its lease without sending when the workspace became blocked", async () => {
    f("leadSequenceRun.findUnique").mockResolvedValueOnce({ id: "r1", tenantId: "t1", stepIndex: 0, leadId: "l1", createdAt: now, sequence: { steps: [], enabled: true } });
    expect(await processRun("r1", now)).toBe(false);
    expect(f("lead.findFirst")).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    const calls = f("leadSequenceRun.updateMany").mock.calls;
    const last = calls[calls.length - 1][0] as { data: Record<string, unknown> };
    expect(last.data).not.toHaveProperty("status");
  });
  it("lead fetch jobs ingest for active workspaces now and re-queue (not drop) the blocked workspace's copy", async () => {
    f("metaAsset.findMany").mockResolvedValueOnce([
      { id: "a1", tenantId: "blocked" },
      { id: "a2", tenantId: "live" },
    ]);
    state.allowed.add("live");
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(mocks.ingest.mock.calls[0][0]).toBe("live");
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = mocks.enqueue.mock.calls[0] as [string, Record<string, unknown>, { runAt: Date }];
    expect(queue).toBe("lead-fetch");
    expect(payload).toMatchObject({ leadgenId: "L1", pageId: "p1", deferrals: 1, deferredFor: ["blocked"] });
    expect(opts.runAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("a re-queued lead job only touches the workspaces it was deferred for, and ingests once they recover", async () => {
    f("metaAsset.findMany").mockResolvedValueOnce([
      { id: "a1", tenantId: "was-blocked" },
      { id: "a2", tenantId: "already-done" },
    ]);
    state.allowed.add("was-blocked");
    state.allowed.add("already-done");
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: 3, deferredFor: ["was-blocked"] });
    expect(mocks.ingest.mock.calls.map((c) => c[0])).toEqual(["was-blocked"]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("keeps deferring while still blocked, and gives up (audited) after 7 days", async () => {
    f("metaAsset.findMany").mockResolvedValue([{ id: "a1", tenantId: "blocked" }]);
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: 5, deferredFor: ["blocked"] });
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ deferrals: 6 });
    mocks.enqueue.mockClear();
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1", deferrals: MAX_LEAD_DEFERRALS, deferredFor: ["blocked"] });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "blocked", action: "leads.fetch_given_up" }));
  });
  it("a queue retry does not start a second deferral chain while the same deferral is already queued (scheduling is idempotent, not tied to attempt 1)", async () => {
    f("metaAsset.findMany").mockResolvedValueOnce([{ id: "a1", tenantId: "blocked" }]);
    f("job.findFirst").mockResolvedValueOnce({ id: "already-queued" } as never);
    await handleLeadJobForActiveTenants({ leadgenId: "L1", pageId: "p1" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("content publishing", () => {
  it("leaves due posts of a blocked workspace scheduled and claims the others", async () => {
    // The first findMany is expireStalePosts' scan for posts more than 24 hours late; the due scan is the one with lte.
    f("scheduledPost.findMany").mockImplementation((async (arg: { where: { scheduledAt: { lt?: Date } } }) =>
      arg.where.scheduledAt.lt ? [] : [{ id: "p1", tenantId: "blocked" }, { id: "p2", tenantId: "live" }]) as never);
    state.allowed.add("live");
    const claimed = await claimDue(now);
    expect(claimed).toEqual([{ id: "p2", tenantId: "live" }]);
    const claims = f("scheduledPost.updateMany").mock.calls.filter((c) => (c[0] as { data: { status: string } }).data.status === "publishing");
    expect(claims).toHaveLength(1);
  });
  it("blocked workspaces with a large backlog do not starve healthy ones", async () => {
    const backlog = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, tenantId: "blocked" }));
    f("scheduledPost.findMany").mockImplementation((async (arg: { where: { scheduledAt: { lt?: Date }; tenantId?: { notIn: string[] } } }) =>
      arg.where.scheduledAt.lt ? [] : arg.where.tenantId?.notIn.includes("blocked") ? [{ id: "h1", tenantId: "live" }] : backlog) as never);
    state.allowed.add("live");
    expect(await claimDue(now)).toEqual([{ id: "h1", tenantId: "live" }]);
    // stale scan + the two due scans
    expect(f("scheduledPost.findMany")).toHaveBeenCalledTimes(3);
  });
  it("posts more than 24 hours late are failed as missed_window, per workspace, instead of publishing in a burst after recovery", async () => {
    f("scheduledPost.findMany").mockResolvedValueOnce([
      { id: "s1", tenantId: "t1" },
      { id: "s2", tenantId: "t1" },
      { id: "s3", tenantId: "t2" },
    ]);
    await claimDue(now);
    const scan = f("scheduledPost.findMany").mock.calls[0][0] as { where: { status: string; scheduledAt: { lt: Date } } };
    expect(scan.where.status).toBe("scheduled");
    expect(scan.where.scheduledAt.lt.getTime()).toBe(now.getTime() - 24 * 3_600_000);
    const posts = f("scheduledPost.updateMany").mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: { status: string } });
    expect(posts[0]).toEqual({ where: { id: { in: ["s1", "s2"] }, tenantId: "t1", status: "scheduled" }, data: { status: "failed" } });
    expect(posts.some((c) => c.where.tenantId === "t2" && c.data.status === "failed")).toBe(true);
    const targets = f("postTarget.updateMany").mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: { status: string; error: string } });
    expect(targets[0].where).toEqual({ tenantId: "t1", postId: { in: ["s1", "s2"] }, status: { in: ["pending", "retry", "container"] } });
    expect(targets[0].data.status).toBe("failed");
    expect(targets[0].data.error.startsWith("missed_window")).toBe(true);
    expect(mocks.publishFacebook).not.toHaveBeenCalled();
  });
  it("a post that another worker claimed between the scan and the update keeps its waiting targets (only posts actually failed are touched)", async () => {
    f("scheduledPost.findMany")
      .mockResolvedValueOnce([
        { id: "s1", tenantId: "t1" },
        { id: "s2", tenantId: "t1" },
      ])
      .mockResolvedValueOnce([{ id: "s2" }]); // re-read: s2 is no longer "failed", it is being published
    f("scheduledPost.updateMany").mockResolvedValueOnce({ count: 1 });
    expect(await expireStalePosts(now)).toBe(1);
    const reread = f("scheduledPost.findMany").mock.calls[1][0] as { where: Record<string, unknown> };
    expect(reread.where).toEqual({ id: { in: ["s1", "s2"] }, tenantId: "t1", status: { not: "failed" } });
    const targets = f("postTarget.updateMany").mock.calls.map((c) => c[0] as { where: { postId: { in: string[] } } });
    expect(targets).toHaveLength(1);
    expect(targets[0].where.postId).toEqual({ in: ["s1"] });
  });
  it("when no post was won, no target is touched at all", async () => {
    f("scheduledPost.findMany").mockResolvedValueOnce([{ id: "s1", tenantId: "t1" }]);
    f("scheduledPost.updateMany").mockResolvedValueOnce({ count: 0 });
    expect(await expireStalePosts(now)).toBe(0);
    expect(f("postTarget.updateMany")).not.toHaveBeenCalled();
  });
  it("a queued publish for a blocked workspace goes back to scheduled and calls nothing", async () => {
    await processPost("t1", "p1", { now });
    expect(f("scheduledPost.updateMany")).toHaveBeenCalledWith({ where: { id: "p1", tenantId: "t1", status: "publishing" }, data: { status: "scheduled" } });
    expect(f("postTarget.findMany")).not.toHaveBeenCalled();
    expect(mocks.getAssetAccess).not.toHaveBeenCalled();
    expect(mocks.publishFacebook).not.toHaveBeenCalled();
  });
});

describe("conversions delivery", () => {
  it("does not call Meta for a blocked workspace and keeps the event pending (no job, no status change): the sweep re-enqueues it later", async () => {
    f("conversionEvent.findFirst").mockResolvedValueOnce({ id: "e1", status: "pending", attempts: 0, eventTime: new Date() });
    await deliverConversion("t1", "e1", false);
    expect(mocks.graph).not.toHaveBeenCalled();
    expect(f("conversionEvent.update")).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("marks the event skipped with tenant_blocked once it is older than Meta's 7 day window", async () => {
    f("conversionEvent.findFirst").mockResolvedValueOnce({ id: "e1", status: "pending", attempts: 0, eventTime: new Date(Date.now() - 8 * 86_400_000) });
    await deliverConversion("t1", "e1", false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(f("conversionEvent.update")).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "skipped", response: { reason: "tenant_blocked" } }) }));
  });
});

describe("insights sync", () => {
  it("syncs nothing for a blocked workspace", async () => {
    const res = await syncTenant("t1", now);
    expect(res).toMatchObject({ accounts: 0, rows: 0 });
    expect(mocks.listAssets).not.toHaveBeenCalled();
    expect(mocks.getAssetAccess).not.toHaveBeenCalled();
    expect(mocks.graph).not.toHaveBeenCalled();
  });
});

describe("optimizer", () => {
  it("creates no proposals and reads no campaigns for a blocked workspace", async () => {
    expect(await runForTenant("t1", now)).toEqual({ created: 0, expired: 0 });
    expect(f("adCampaign.findMany")).not.toHaveBeenCalled();
    expect(f("optimizerProposal.create")).not.toHaveBeenCalled();
    expect(f("optimizerProposal.updateMany")).not.toHaveBeenCalled();
  });
});

describe("meta token health", () => {
  it("does not check or change a blocked workspace's connection, but moves it to the back of the queue (no starvation)", async () => {
    f("metaConnection.findMany").mockResolvedValueOnce([
      { id: "m1", tenantId: "blocked", tokenEnc: "x", status: "active", scopes: [] },
      { id: "m2", tenantId: "live", tokenEnc: "x", status: "active", scopes: [] },
    ]);
    state.allowed.add("live");
    mocks.debugToken.mockResolvedValue({ valid: true, userId: "u", scopes: ["a"], expiresAt: null });
    await checkTokenHealth(now);
    expect(mocks.debugToken).toHaveBeenCalledTimes(1);
    const calls = f("metaConnection.updateMany").mock.calls.map((c) => c[0] as { where: { tenantId: string }; data: Record<string, unknown> });
    expect(calls.find((c) => c.where.tenantId === "blocked")?.data).toEqual({ lastCheckedAt: now });
    expect(calls.some((c) => c.where.tenantId === "live" && "scopes" in c.data)).toBe(true);
  });
});
