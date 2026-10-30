import { beforeEach, describe, expect, it, vi } from "vitest";

type Post = { id: string; tenantId: string; body: string; mediaKeys: string[]; scheduledAt: Date; status: string; createdAt: Date };
type Target = { id: string; tenantId: string; postId: string; assetId: string; channel: string; status: string; externalId: string | null; error: string | null; publishedAt: Date | null };

const store = vi.hoisted(() => ({ posts: [] as Post[], targets: [] as Target[] }));
const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(row[k]);
    if (v && typeof v === "object" && "lte" in (v as object)) return (row[k] as Date) <= (v as { lte: Date }).lte;
    return row[k] === v;
  });

const db = vi.hoisted(() => ({
  scheduledPost: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const p = store.posts.find((x) => matches(x as never, where));
      return p ? { ...p, targets: store.targets.filter((t) => t.postId === p.id) } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store.posts.filter((x) => matches(x as never, where))),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = store.posts.filter((x) => matches(x as never, where));
      hit.forEach((x) => Object.assign(x, data));
      return { count: hit.length };
    }),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  postTarget: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => store.targets.filter((x) => matches(x as never, where)).map((t) => ({ ...t }))),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = store.targets.filter((x) => matches(x as never, where));
      hit.forEach((x) => Object.assign(x, data));
      return { count: hit.length };
    }),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn() }));
const meta = vi.hoisted(() => ({ getAssetAccess: vi.fn(), listAssets: vi.fn() }));
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
const media = vi.hoisted(() => ({ exists: vi.fn(async () => true) }));
const approvals = vi.hoisted(() => ({ expire: vi.fn(async () => 0), list: vi.fn(async (): Promise<{ status: string }[]> => []) }));

vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", async () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false, public ambiguous = false) {
      super(message);
    }
  }
  return { ...graph, GraphError };
});
vi.mock("@/lib/meta-connect", () => meta);
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/auth/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/approvals", () => ({ createApproval: vi.fn(async () => ({ id: "a1", url: "https://x/approve/tok" })), expireDecidedApprovals: approvals.expire, listApprovals: approvals.list }));
vi.mock("@/lib/content/media", async (orig) => ({ ...(await orig<typeof import("@/lib/content/media")>()), mediaExists: media.exists }));

import { GraphError } from "@/lib/graph";
import { mediaPublicUrl, resolveMediaPath, verifySignature } from "@/lib/content/media";
import { claimDue, processPost } from "@/lib/content/publish";
import { assertSchedulable, parseRange } from "@/lib/content/schedule";
import { cancelPost, createPost, getPost, publishNow, reschedulePost, updatePost } from "@/lib/content/service";

const KEY = "0123456789abcdef0123456789abcdef.jpg";
const now = new Date("2026-03-01T12:00:00Z");
const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

function seed(channels: string[], extra: Partial<Post> = {}) {
  store.posts.push({ id: "p1", tenantId: "t1", body: "Hello", mediaKeys: [KEY], scheduledAt: new Date(now.getTime() - 1000), status: "publishing", createdAt: now, ...extra });
  channels.forEach((c, i) => store.targets.push({ id: `g${i}`, tenantId: "t1", postId: "p1", assetId: `a${i}`, channel: c, status: "pending", externalId: null, error: null, publishedAt: null }));
}

beforeEach(() => {
  process.env.CONTENT_MEDIA_SECRET = "9f3a6c1e8b2d47f05a7e9c3b1d6f4a82c5e0b7391d8a6f2e4c7b0a9d3e5f1862";
  process.env.DATA_DIR = "./data-test";
  store.posts.length = 0;
  store.targets.length = 0;
  vi.clearAllMocks();
  approvals.list.mockResolvedValue([]);
  meta.getAssetAccess.mockImplementation(async (_t: string, id: string) => ({ assetId: id, type: "page", externalId: `ext-${id}`, name: null, token: "tok" }));
});

describe("signed media URLs", () => {
  const url = () => new URL(mediaPublicUrl("t1", KEY, now.getTime()));
  const parts = (u: URL) => ({ exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") });

  it("accepts a fresh signature and rejects it after one hour", () => {
    const { exp, sig } = parts(url());
    expect(verifySignature("t1", KEY, exp, sig, now.getTime() + 60_000)).toBe(true);
    expect(verifySignature("t1", KEY, exp, sig, now.getTime() + 3_601_000)).toBe(false);
  });

  it("rejects tampered signature, expiry, tenant and file", () => {
    const { exp, sig } = parts(url());
    const at = now.getTime() + 1000;
    expect(verifySignature("t1", KEY, exp, sig!.replace(/.$/, sig!.endsWith("0") ? "1" : "0"), at)).toBe(false);
    expect(verifySignature("t1", KEY, String(Number(exp) + 100), sig, at)).toBe(false);
    expect(verifySignature("t2", KEY, exp, sig, at)).toBe(false);
    expect(verifySignature("t1", "ffffffffffffffffffffffffffffffff.jpg", exp, sig, at)).toBe(false);
    expect(verifySignature("t1", KEY, null, null, at)).toBe(false);
  });

  it("resolves only strictly shaped keys inside the content directory", () => {
    expect(resolveMediaPath("t1", KEY)).toContain("t1");
    expect(resolveMediaPath("t1", "../../etc/passwd")).toBeNull();
    expect(resolveMediaPath("..", KEY)).toBeNull();
    expect(resolveMediaPath("t1/../t2", KEY)).toBeNull();
    expect(resolveMediaPath("t1", `${KEY}/../x.jpg`)).toBeNull();
  });
});

describe("scheduling rules", () => {
  it("requires a future time within 90 days", () => {
    expect(() => assertSchedulable(new Date(now.getTime() - 1), now)).toThrow();
    expect(() => assertSchedulable(new Date(now.getTime() + 91 * 86_400_000), now)).toThrow();
    expect(() => assertSchedulable(new Date(now.getTime() + 3600_000), now)).not.toThrow();
  });
  it("limits calendar ranges to 62 days", () => {
    expect(() => parseRange("2026-03-01T00:00:00Z", "2026-05-02T00:00:00Z")).not.toThrow();
    expect(() => parseRange("2026-03-01T00:00:00Z", "2026-05-04T00:00:00Z")).toThrow();
  });
});

describe("claimDue", () => {
  it("lets exactly one of two concurrent workers claim a post", async () => {
    store.posts.push({ id: "p1", tenantId: "t1", body: "", mediaKeys: [], scheduledAt: new Date(now.getTime() - 1000), status: "scheduled", createdAt: now });
    const [a, b] = await Promise.all([claimDue(now), claimDue(now)]);
    expect(a.length + b.length).toBe(1);
    expect(store.posts[0].status).toBe("publishing");
  });
  it("ignores posts that are not yet due", async () => {
    store.posts.push({ id: "p2", tenantId: "t1", body: "", mediaKeys: [], scheduledAt: new Date(now.getTime() + 5000), status: "scheduled", createdAt: now });
    expect(await claimDue(now)).toEqual([]);
  });
});

describe("processPost", () => {
  it("publishes a Facebook photo and marks the post published", async () => {
    seed(["facebook"]);
    graph.graphFetchAs.mockResolvedValue({ id: "ph1", post_id: "pg_1" });
    await processPost("t1", "p1", { now });
    expect(store.targets[0]).toMatchObject({ status: "published", externalId: "pg_1" });
    expect(store.posts[0].status).toBe("published");
    expect(graph.graphFetchAs.mock.calls[0][1].path).toBe("ext-a0/photos");
  });

  it("never posts twice when run again", async () => {
    seed(["facebook"], { mediaKeys: [] });
    graph.graphFetchAs.mockResolvedValue({ id: "f1" });
    await processPost("t1", "p1", { now });
    store.posts[0].status = "publishing";
    await processPost("t1", "p1", { now });
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(1);
  });

  it("does not run the same target twice under concurrent runs", async () => {
    seed(["facebook"], { mediaKeys: [] });
    graph.graphFetchAs.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { id: "f1" };
    });
    await Promise.all([processPost("t1", "p1", { now }), processPost("t1", "p1", { now })]);
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(1);
  });

  it("reports partial success when one target fails for good", async () => {
    seed(["facebook", "instagram"]);
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path.endsWith("/photos")) return { id: "ph1" };
      throw new GraphError("Invalid parameter", 400, 100);
    });
    await processPost("t1", "p1", { now });
    expect(store.targets.map((t) => t.status)).toEqual(["published", "failed"]);
    expect(store.posts[0].status).toBe("partial");
  });

  it("retries a rate limit with backoff and gives up after three attempts", async () => {
    seed(["facebook"], { mediaKeys: [] });
    graph.graphFetchAs.mockRejectedValue(new GraphError("rate limited", 400, 4, undefined, true));
    await processPost("t1", "p1", { now });
    expect(store.targets[0]).toMatchObject({ status: "retry", error: "#1|rate limited" });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    await processPost("t1", "p1", { now });
    expect(store.targets[0].error).toBe("#2|rate limited");
    await processPost("t1", "p1", { now });
    expect(store.targets[0]).toMatchObject({ status: "failed", error: "rate limited" });
    expect(store.posts[0].status).toBe("failed");
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unconfirmed post request", async () => {
    seed(["facebook"], { mediaKeys: [] });
    graph.graphFetchAs.mockRejectedValue(new GraphError("timeout", 0, undefined, undefined, true, true));
    await processPost("t1", "p1", { now });
    expect(store.targets[0].status).toBe("failed");
    expect(store.targets[0].error).toMatch(/did not confirm/);
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(1);
  });

  it("fails an interrupted target instead of re-posting it", async () => {
    seed(["facebook"], { mediaKeys: [] });
    store.targets[0].status = "processing";
    await processPost("t1", "p1", { now });
    expect(store.targets[0].status).toBe("failed");
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });

  it("publishes an Instagram image through container, status check and publish", async () => {
    seed(["instagram"]);
    meta.getAssetAccess.mockResolvedValue({ assetId: "a0", type: "instagram", externalId: "ig1", name: null, token: "tok" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string; method?: string }) => {
      if (req.path === "ig1/content_publishing_limit") return { data: [{ quota_usage: 3, config: { quota_total: 100 } }] };
      if (req.path === "ig1/media") return { id: "c1" };
      if (req.path === "c1") return { status_code: "FINISHED" };
      if (req.path === "ig1/media_publish") return { id: "m1" };
      throw new Error(req.path);
    });
    await processPost("t1", "p1", { now });
    expect(store.targets[0]).toMatchObject({ status: "published", externalId: "m1" });
  });

  it("waits without creating a container when Instagram's daily limit is reached", async () => {
    seed(["instagram"]);
    meta.getAssetAccess.mockResolvedValue({ assetId: "a0", type: "instagram", externalId: "ig1", name: null, token: "tok" });
    graph.graphFetchAs.mockResolvedValue({ data: [{ quota_usage: 100, config: { quota_total: 100 } }] });
    await processPost("t1", "p1", { now });
    expect(graph.graphFetchAs).toHaveBeenCalledTimes(1);
    expect(store.targets[0].status).toBe("pending");
    expect(store.posts[0].status).toBe("publishing");
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("keeps the container id when processing is slow and reuses it next run", async () => {
    seed(["instagram"], { mediaKeys: ["0123456789abcdef0123456789abcdef.mp4"] });
    meta.getAssetAccess.mockResolvedValue({ assetId: "a0", type: "instagram", externalId: "ig1", name: null, token: "tok" });
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path.endsWith("content_publishing_limit")) return { data: [{ quota_usage: 0, config: { quota_total: 100 } }] };
      if (req.path === "ig1/media") return { id: "c1" };
      return { status_code: "IN_PROGRESS" };
    });
    await processPost("t1", "p1", { now, sleep: async () => undefined });
    expect(store.targets[0]).toMatchObject({ status: "container", externalId: "c1" });
    graph.graphFetchAs.mockClear();
    graph.graphFetchAs.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "c1" ? { status_code: "FINISHED" } : { id: "m9" }));
    await processPost("t1", "p1", { now, sleep: async () => undefined });
    expect(graph.graphFetchAs.mock.calls.some((c) => c[1].path === "ig1/media")).toBe(false);
    expect(store.targets[0]).toMatchObject({ status: "published", externalId: "m9" });
  });

  it("returns a clear error for Threads", async () => {
    seed(["threads"], { mediaKeys: [] });
    await processPost("t1", "p1", { now });
    expect(store.targets[0]).toMatchObject({ status: "failed", error: "Threads publishing is not available yet." });
  });
});

describe("tenant isolation and validation", () => {
  it("does not show or cancel another tenant's post", async () => {
    seed(["facebook"], { status: "scheduled" });
    const other = { userId: "u2", tenantId: "t2", role: "admin" as const };
    await expect(getPost(other, "p1")).rejects.toMatchObject({ status: 404 });
    await expect(cancelPost(other, "p1")).rejects.toMatchObject({ status: 404 });
    expect(store.posts[0].status).toBe("scheduled");
  });

  it("rejects an asset that is not in the tenant's connected list", async () => {
    meta.listAssets.mockResolvedValue([{ id: "mine", type: "page", externalId: "1", name: "P", status: "active", meta: {} }]);
    await expect(createPost(actor, { body: "x", assetIds: ["theirs"], scheduledAt: new Date(now.getTime() + 3600_000).toISOString() }, now)).rejects.toMatchObject({ status: 400 });
    expect(meta.listAssets).toHaveBeenCalledWith("t1");
  });

  it("enforces Instagram limits when creating a post", async () => {
    meta.listAssets.mockResolvedValue([{ id: "ig", type: "instagram", externalId: "1", name: "I", status: "active", meta: {} }]);
    await expect(createPost(actor, { body: "x", assetIds: ["ig"], scheduledAt: new Date(now.getTime() + 3600_000).toISOString() }, now)).rejects.toThrow(/image or video/);
  });
});

describe("editing a post after client approval (P3-14b)", () => {
  const edit = { body: "Changed after approval" };
  const later = () => new Date(now.getTime() + 3600_000);

  it("leaves a scheduled post scheduled, and touches no approval, when none exists", async () => {
    seed(["facebook"], { status: "scheduled", scheduledAt: later() });
    const out = await updatePost(actor, "p1", edit, now);
    expect(approvals.expire).not.toHaveBeenCalled();
    expect(out.status).toBe("scheduled");
  });

  it("expires the decided approval and moves the post back to draft", async () => {
    approvals.list.mockResolvedValue([{ status: "approved" }]);
    seed(["facebook"], { status: "scheduled", scheduledAt: later() });
    const out = await updatePost(actor, "p1", edit, now);
    expect(approvals.expire).toHaveBeenCalledWith("t1", "scheduled_post", "p1", "u1");
    expect(out.status).toBe("draft");
    expect(store.posts[0]).toMatchObject({ status: "draft", body: "Changed after approval" });
  });

  it("also expires a link the client has not used yet, so text B cannot be approved as if it were text A", async () => {
    approvals.list.mockResolvedValue([{ status: "pending" }]);
    seed(["facebook"], { status: "draft", scheduledAt: later() });
    await updatePost(actor, "p1", edit, now);
    expect(approvals.expire).toHaveBeenCalledWith("t1", "scheduled_post", "p1", "u1");
    expect(store.posts[0].status).toBe("draft");
  });

  it("does not revoke anything when the edit is rejected by validation", async () => {
    approvals.list.mockResolvedValue([{ status: "approved" }]);
    seed(["facebook"], { status: "scheduled", scheduledAt: later() });
    await expect(updatePost(actor, "p1", { body: "x".repeat(70000) }, now)).rejects.toMatchObject({ status: 400 });
    expect(approvals.expire).not.toHaveBeenCalled();
  });

  it("does not burn the approval when the update loses a race (409)", async () => {
    approvals.list.mockResolvedValue([{ status: "approved" }]);
    seed(["facebook"], { status: "scheduled", scheduledAt: later() });
    db.scheduledPost.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(updatePost(actor, "p1", edit, now)).rejects.toMatchObject({ status: 409 });
    expect(approvals.expire).not.toHaveBeenCalled();
  });

  it("rescheduling a post that has an approval expires it and returns the post to draft", async () => {
    approvals.list.mockResolvedValue([{ status: "approved" }]);
    seed(["facebook"], { status: "scheduled", scheduledAt: later() });
    const out = await reschedulePost(actor, "p1", new Date(now.getTime() + 7200_000).toISOString(), now);
    expect(out.status).toBe("draft");
    expect(approvals.expire).toHaveBeenCalledWith("t1", "scheduled_post", "p1", "u1");
  });

  it("rescheduling a draft that is waiting for approval cannot bypass the approval", async () => {
    approvals.list.mockResolvedValue([{ status: "pending" }]);
    seed(["facebook"], { status: "draft", scheduledAt: later() });
    const out = await reschedulePost(actor, "p1", new Date(now.getTime() + 7200_000).toISOString(), now);
    expect(out.status).toBe("draft");
  });

  it("rescheduling a post with no approval still schedules it", async () => {
    seed(["facebook"], { status: "draft", scheduledAt: later() });
    const out = await reschedulePost(actor, "p1", new Date(now.getTime() + 7200_000).toISOString(), now);
    expect(out.status).toBe("scheduled");
    expect(approvals.expire).not.toHaveBeenCalled();
  });

  it("publish now is refused while a draft is waiting for client approval", async () => {
    approvals.list.mockResolvedValue([{ status: "pending" }]);
    seed(["facebook"], { status: "draft", scheduledAt: later() });
    await expect(publishNow(actor, "p1", now)).rejects.toMatchObject({ status: 409 });
    expect(store.posts[0].status).toBe("draft");
  });
});
