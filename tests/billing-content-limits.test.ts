import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 86_400_000;
const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  plan: { findUnique: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
  scheduledPost: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  postTarget: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
}));
const meta = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/meta-connect", () => meta);
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/approvals", () => ({ createApproval: vi.fn(), expireDecidedApprovals: vi.fn(async () => 0), listApprovals: vi.fn(async () => []) }));

import { createPost, updatePost } from "@/lib/content/service";

const now = new Date("2026-03-01T12:00:00Z");
const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const later = new Date(now.getTime() + 3 * 3_600_000).toISOString();
const NO_LIMITS: Record<"seatLimit" | "contactLimit" | "monthlyBroadcastLimit" | "adAccountLimit" | "scheduledPostLimit" | "connectedChannelLimit", number | null> = { seatLimit: null, contactLimit: null, monthlyBroadcastLimit: null, adAccountLimit: null, scheduledPostLimit: null, connectedChannelLimit: null };

function plan(limits: Partial<typeof NO_LIMITS>) {
  db.tenant.findUnique.mockResolvedValue({
    status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: null,
    subscription: { status: "active", currentPeriodEnd: new Date(Date.now() + DAY), pastDueSince: null, planId: "p1", plan: { name: "Pro" } },
  });
  db.plan.findUnique.mockResolvedValue({ ...NO_LIMITS, ...limits });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.platformSetting.findUnique.mockResolvedValue(null);
  meta.listAssets.mockResolvedValue([
    { id: "pg1", type: "page", externalId: "e1", name: "Page 1", status: "active", meta: {} },
    { id: "pg2", type: "page", externalId: "e2", name: "Page 2", status: "active", meta: {} },
  ]);
  db.scheduledPost.count.mockResolvedValue(0);
  db.postTarget.findMany.mockResolvedValue([]);
  db.scheduledPost.create.mockImplementation(async ({ data }: { data: { targets: { create: object[] } } }) => ({ id: "post1", body: "Hello", mediaKeys: [], scheduledAt: new Date(later), status: "scheduled", createdAt: now, targets: data.targets.create.map((t, i) => ({ id: `t${i}`, ...t, status: "pending", externalId: null, error: null, publishedAt: null })) }));
});

describe("creating a post checks the plan", () => {
  it("refuses the post that would pass the monthly limit and saves nothing", async () => {
    plan({ scheduledPostLimit: 5 });
    db.scheduledPost.count.mockResolvedValue(5);
    await expect(createPost(actor, { body: "Hello", assetIds: ["pg1"], scheduledAt: later }, now)).rejects.toMatchObject({ status: 402, message: expect.stringContaining("5 scheduled posts per month") });
    expect(db.scheduledPost.create).not.toHaveBeenCalled();
    expect(db.scheduledPost.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: { not: "canceled" } });
  });

  it("allows the post that reaches the limit exactly", async () => {
    plan({ scheduledPostLimit: 5 });
    db.scheduledPost.count.mockResolvedValue(4);
    await expect(createPost(actor, { body: "Hello", assetIds: ["pg1"], scheduledAt: later }, now)).resolves.toBeTruthy();
    expect(db.scheduledPost.create).toHaveBeenCalledTimes(1);
  });

  it("drafts count too, so the limit cannot be dodged by saving drafts", async () => {
    plan({ scheduledPostLimit: 1 });
    db.scheduledPost.count.mockResolvedValue(1);
    await expect(createPost(actor, { body: "Hello", assetIds: ["pg1"], draft: true }, now)).rejects.toMatchObject({ status: 402 });
  });

  it("refuses a channel that would pass the connected-channel limit, but not one already in use", async () => {
    plan({ connectedChannelLimit: 1 });
    db.postTarget.findMany.mockResolvedValue([{ assetId: "pg1" }]);
    await expect(createPost(actor, { body: "Hello", assetIds: ["pg1"], scheduledAt: later }, now)).resolves.toBeTruthy();
    await expect(createPost(actor, { body: "Hello", assetIds: ["pg1", "pg2"], scheduledAt: later }, now)).rejects.toMatchObject({ status: 402, message: expect.stringContaining("connected social channels") });
    expect(db.scheduledPost.create).toHaveBeenCalledTimes(1);
  });

  it("a plan without these limits changes nothing", async () => {
    plan({});
    await createPost(actor, { body: "Hello", assetIds: ["pg1", "pg2"], scheduledAt: later }, now);
    expect(db.scheduledPost.count).not.toHaveBeenCalled();
    expect(db.postTarget.findMany).not.toHaveBeenCalled();
  });
});

describe("editing a post's accounts checks the plan", () => {
  const existing = { id: "post1", tenantId: "t1", body: "Hello", mediaKeys: [], scheduledAt: new Date(later), status: "draft", createdAt: now, targets: [{ id: "t0", assetId: "pg1", channel: "facebook", status: "pending", externalId: null, error: null, publishedAt: null }] };

  it("swapping a post to another account is allowed at the limit (its own old account is freed)", async () => {
    plan({ connectedChannelLimit: 1 });
    db.scheduledPost.findFirst.mockResolvedValue(existing);
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    db.postTarget.findMany.mockResolvedValue([]);
    await updatePost(actor, "post1", { assetIds: ["pg2"] }, now);
    expect(db.postTarget.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", postId: { not: "post1" } });
    expect(db.postTarget.createMany).toHaveBeenCalled();
  });

  it("adding a second new account over the limit is refused before anything changes", async () => {
    plan({ connectedChannelLimit: 1 });
    db.scheduledPost.findFirst.mockResolvedValue(existing);
    db.postTarget.findMany.mockResolvedValue([]);
    await expect(updatePost(actor, "post1", { assetIds: ["pg1", "pg2"] }, now)).rejects.toMatchObject({ status: 402 });
    expect(db.scheduledPost.updateMany).not.toHaveBeenCalled();
  });
});
