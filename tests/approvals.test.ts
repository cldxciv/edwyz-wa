import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Row = { id: string; tenantId: string; subjectType: string; subjectId: string; tokenHash: string; status: string; comment: string | null; expiresAt: Date; decidedAt: Date | null; createdAt: Date };

const store = vi.hoisted(() => ({ rows: [] as Row[], n: 0 }));
const fps = vi.hoisted(() => new Map<string, unknown>());
const db = vi.hoisted(() => {
  const m = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), create: vi.fn() });
  return {
    approvalRequest: m(), auditLog: m(), user: m(), creativeAsset: m(), creativeBrief: m(), adCampaign: m(), scheduledPost: m(),
    optimizerProposal: m(), platformSetting: m(), contact: m(), phoneNumber: m(), conversation: m(), template: m(),
  };
});
const email = vi.hoisted(() => ({ queueEmail: vi.fn() }));
const inbox = vi.hoisted(() => ({ sendText: vi.fn(), sendTemplateMessage: vi.fn() }));
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner", userId: "u1" }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => email);
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: auth.userId, tenantId: "t1", role: auth.role }) }));

import { createApproval, decideApproval, expireDecidedApprovals, getApprovalByToken, getOptimizerClientDecision, isCampaignClientApproved, loadApprovalPage, reissueApproval, listApprovals, repairStuckOptimizerProposals } from "@/lib/approvals";
import { consumeNonce, createNonce, decideIpLimiter, resetApprovalLimits } from "@/lib/approvals/guards";
import { clean, safeHttpsUrl } from "@/lib/approvals/summary";
import { resendApproval } from "@/lib/approvals/resend";
import { hashToken } from "@/lib/auth/tokens";
import { SummaryCard } from "@/components/approvals/ApprovalPage";
import { POST as decideRoute } from "@/app/api/approvals/[id]/decide/route";
import { POST as createRoute } from "@/app/api/approvals/route";

const ORIGIN = "https://wa.edwyz.com";
const tokenOf = (url: string) => url.split("/approve/")[1];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = "x".repeat(40);
  resetApprovalLimits();
  store.rows = [];
  fps.clear();
  auth.role = "admin";
  auth.userId = "u1";
  db.approvalRequest.create.mockImplementation(async ({ data }: { data: Omit<Row, "id"> }) => {
    const row = { ...({ comment: null, decidedAt: null, status: "pending", createdAt: new Date() } as object), ...data, id: `a${++store.n}` } as Row;
    store.rows.push(row);
    return row;
  });
  db.approvalRequest.findUnique.mockImplementation(async ({ where }: { where: { tokenHash: string } }) => store.rows.find((r) => r.tokenHash === where.tokenHash) ?? null);
  db.approvalRequest.findFirst.mockImplementation(async ({ where }: { where: Record<string, any> }) =>
    store.rows.find((r) => (!where.id || r.id === where.id) && (!where.tenantId || r.tenantId === where.tenantId) && (!where.status || r.status === where.status)) ?? null);
  db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string; value: unknown } }) => {
    fps.set(data.key, data.value);
    return data;
  });
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (fps.has(where.key) ? { key: where.key, value: fps.get(where.key) } : null));
  db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    fps.set(where.key, create.value);
    return create;
  });
  db.approvalRequest.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, any>; data: Partial<Row> }) => {
    const hit = store.rows.filter(
      (r) =>
        (!where.tokenHash || r.tokenHash === where.tokenHash) &&
        (!where.id || r.id === where.id) &&
        (!where.tenantId || r.tenantId === where.tenantId) &&
        (!where.status || (typeof where.status === "string" ? r.status === where.status : where.status.in.includes(r.status))) &&
        (!where.expiresAt?.gt || r.expiresAt > where.expiresAt.gt),
    );
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  db.creativeAsset.findFirst.mockImplementation(async ({ where, select }: { where: { id: string; tenantId: string }; select: Record<string, unknown> }) => {
    if (where.tenantId !== "t1" || where.id !== "asset1") return null;
    return select.brief ? { brief: { createdByUserId: "creator" } } : { kind: "image", placement: "feed", headline: "Big <b>sale</b>", body: "Hello\n<script>alert(1)</script>", storageKey: "https://cdn.example.com/a.png" };
  });
  db.creativeAsset.updateMany.mockResolvedValue({ count: 1 });
  db.user.findFirst.mockResolvedValue({ email: "creator@example.com" });
  db.auditLog.create.mockResolvedValue({});
});

const postRow = (over: Record<string, unknown> = {}) => ({
  createdByUserId: null, body: "Text A", scheduledAt: new Date("2030-01-01T10:00:00Z"), mediaKeys: [], targets: [{ assetId: "pg1" }], ...over,
});
const campaignRow = (over: Record<string, unknown> = {}) => ({
  createdByUserId: null, name: "Spring", objective: "LEADS", dailyBudgetMinor: 100000, currency: "INR", startsAt: null, endsAt: null, ...over,
});

async function newApproval(type = "creative_asset", id = "asset1", tenant = "t1") {
  const { url } = await createApproval(tenant, { subjectType: type as never, subjectId: id });
  return tokenOf(url);
}

describe("tokens and expiry", () => {
  it("stores only the hash, defaults to 7 days, caps at 30", async () => {
    const { url } = await createApproval("t1", { subjectType: "creative_asset", subjectId: "asset1" });
    const token = tokenOf(url);
    expect(url).toBe(`${ORIGIN}/approve/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = store.rows[0];
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    await createApproval("t1", { subjectType: "creative_asset", subjectId: "asset1", expiresInHours: 99999 });
    expect((store.rows[1].expiresAt.getTime() - Date.now()) / 86_400_000).toBeLessThan(30.01);
  });

  it("refuses subjects from another tenant", async () => {
    await expect(createApproval("t2", { subjectType: "creative_asset", subjectId: "asset1" })).rejects.toMatchObject({ status: 404 });
    expect(store.rows).toHaveLength(0);
  });

  it("treats an expired token as unknown", async () => {
    const token = await newApproval();
    store.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await getApprovalByToken(token)).toBeNull();
    expect(await decideApproval(token, "approved")).toEqual({ ok: false });
    expect(db.creativeAsset.updateMany).not.toHaveBeenCalled();
  });
});

describe("deciding", () => {
  it("applies the decision once, audits and notifies the creator", async () => {
    const token = await newApproval();
    expect(await decideApproval(token, "approved", "  looks good ")).toEqual({ ok: true });
    expect(store.rows[0]).toMatchObject({ status: "approved", comment: "looks good" });
    expect(db.creativeAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "asset1", tenantId: "t1" }), data: { status: "approved" } }));
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", action: "approval.decided" }) });
    expect(email.queueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "creator@example.com" }));
  });

  it("cannot be decided twice", async () => {
    const token = await newApproval();
    expect((await decideApproval(token, "rejected")).ok).toBe(true);
    expect((await decideApproval(token, "approved")).ok).toBe(false);
    expect(store.rows[0].status).toBe("rejected");
    expect(db.creativeAsset.updateMany).toHaveBeenCalledTimes(1);
  });

  it("needs a comment to request changes and rejects bad input", async () => {
    const token = await newApproval();
    expect((await decideApproval(token, "changes_requested", "  ")).ok).toBe(false);
    expect((await decideApproval(token, "hack" as never)).ok).toBe(false);
    expect((await decideApproval("short", "approved")).ok).toBe(false);
    expect(store.rows[0].status).toBe("pending");
    expect((await decideApproval(token, "changes_requested", "Use a blue background")).ok).toBe(true);
  });

  it("an optimiser approval records the client decision beside the proposal and never changes the proposal (P3-14a)", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue({ id: "p1" });
    const token = await newApproval("optimizer_proposal", "p1");
    await decideApproval(token, "approved");
    expect(db.optimizerProposal.updateMany).not.toHaveBeenCalled();
    const call = db.platformSetting.upsert.mock.calls.find((c) => c[0].where.key === "approval:optimizer_proposal:t1:p1")![0];
    expect(call.create.value).toMatchObject({ decision: "approved", approved: true });
    for (const decision of ["rejected", "changes_requested"] as const) {
      const t = await newApproval("optimizer_proposal", "p1");
      await decideApproval(t, decision, "comment");
    }
    expect(db.optimizerProposal.updateMany).not.toHaveBeenCalled();
    expect(db.platformSetting.upsert.mock.calls.at(-1)![0].create.value).toMatchObject({ decision: "changes_requested", approved: false });
    expect(await getOptimizerClientDecision("t1", "p1")).toMatchObject({ decision: "changes_requested", approved: false });
  });

  it("editing approved content expires its approvals, and clears the campaign launch flag (P3-14b)", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    const token = await newApproval("scheduled_post", "p1");
    store.rows[0].status = "approved";
    expect(await expireDecidedApprovals("t1", "scheduled_post", "p1", "u1")).toBe(1);
    expect(db.approvalRequest.updateMany).toHaveBeenLastCalledWith({ where: { tenantId: "t1", subjectType: "scheduled_post", subjectId: "p1", status: { in: ["pending", "approved"] } }, data: { status: "expired", expiresAt: expect.any(Date) } });
    expect(store.rows[0].status).toBe("expired");
    expect((await decideApproval(token, "approved")).ok).toBe(false);
    expect(await getApprovalByToken(token)).toBeNull();
    expect(await expireDecidedApprovals("t1", "scheduled_post", "p1")).toBe(0);

    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
    await expireDecidedApprovals("t1", "ad_campaign", "c1");
    expect(db.platformSetting.upsert.mock.calls.find((c) => c[0].where.key === "approval:ad_campaign:t1:c1")![0].create).toMatchObject({ key: "approval:ad_campaign:t1:c1", value: { approved: false } });
  });

  it("a post goes back to draft on changes and campaigns store an approved flag", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    await decideApproval(await newApproval("scheduled_post", "p1"), "changes_requested", "move it");
    expect(db.scheduledPost.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "draft" } }));
    db.adCampaign.findFirst.mockResolvedValue(campaignRow());
    await decideApproval(await newApproval("ad_campaign", "c1"), "approved");
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "approval:ad_campaign:t1:c1" } }));
  });
});

describe("approvals are bound to the content that was shown (P3-14b)", () => {
  it("refuses a decision on a post whose text changed after the link was made, and expires the request", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    const token = await newApproval("scheduled_post", "p1");
    db.scheduledPost.findFirst.mockResolvedValue(postRow({ body: "Text B" }));
    expect(await decideApproval(token, "approved")).toEqual({ ok: false });
    expect(store.rows[0].status).toBe("expired");
    expect(db.scheduledPost.updateMany).not.toHaveBeenCalled();
    expect(await getApprovalByToken(token)).toBeNull();
  });

  it("refuses when the time or the attached accounts changed", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    const t1 = await newApproval("scheduled_post", "p1");
    db.scheduledPost.findFirst.mockResolvedValue(postRow({ scheduledAt: new Date("2030-01-02T10:00:00Z") }));
    expect((await decideApproval(t1, "approved")).ok).toBe(false);
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    const t2 = await newApproval("scheduled_post", "p1");
    db.scheduledPost.findFirst.mockResolvedValue(postRow({ targets: [{ assetId: "other" }] }));
    expect((await decideApproval(t2, "approved")).ok).toBe(false);
  });

  it("applies an unchanged post, and only if it is still the draft that was approved", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    expect((await decideApproval(await newApproval("scheduled_post", "p1"), "approved")).ok).toBe(true);
    expect(db.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", tenantId: "t1", status: "draft", body: "Text A", scheduledAt: new Date("2030-01-01T10:00:00Z") },
      data: { status: "scheduled" },
    });
  });

  it("does not schedule when the post changes between the check and the update", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    const token = await newApproval("scheduled_post", "p1");
    db.scheduledPost.findFirst
      .mockResolvedValueOnce(postRow())
      .mockResolvedValueOnce(postRow())
      .mockResolvedValueOnce(postRow({ body: "Text B" }));
    await decideApproval(token, "approved");
    expect(db.scheduledPost.updateMany).not.toHaveBeenCalled();
  });

  it("keeps working for approvals created before fingerprints existed", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    const token = await newApproval("scheduled_post", "p1");
    fps.clear();
    expect((await decideApproval(token, "approved")).ok).toBe(true);
  });

  it("a reissued link covers the content as it is now", async () => {
    db.scheduledPost.findFirst.mockResolvedValue(postRow());
    db.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
    await newApproval("scheduled_post", "p1");
    db.scheduledPost.findFirst.mockResolvedValue(postRow({ body: "Text B" }));
    const fresh = await reissueApproval("t1", store.rows[0].id);
    expect((await decideApproval(tokenOf(fresh.url), "approved")).ok).toBe(true);
  });

  it("an approved campaign stops counting as approved when the optimiser raises the budget or the campaign is edited", async () => {
    db.adCampaign.findFirst.mockResolvedValue(campaignRow());
    await decideApproval(await newApproval("ad_campaign", "c1"), "approved");
    expect(await isCampaignClientApproved("t1", "c1")).toBe(true);

    db.adCampaign.findFirst.mockResolvedValue(campaignRow({ dailyBudgetMinor: 150000 }));
    expect(await isCampaignClientApproved("t1", "c1")).toBe(false);
    db.adCampaign.findFirst.mockResolvedValue(campaignRow({ dailyBudgetMinor: 60000 }));
    expect(await isCampaignClientApproved("t1", "c1")).toBe(true);
    db.adCampaign.findFirst.mockResolvedValue(campaignRow({ objective: "SALES" }));
    expect(await isCampaignClientApproved("t1", "c1")).toBe(false);
  });

  it("a campaign changed after the link was made cannot be approved", async () => {
    db.adCampaign.findFirst.mockResolvedValue(campaignRow());
    const token = await newApproval("ad_campaign", "c1");
    db.adCampaign.findFirst.mockResolvedValue(campaignRow({ dailyBudgetMinor: 900000 }));
    expect((await decideApproval(token, "approved")).ok).toBe(false);
    expect(await isCampaignClientApproved("t1", "c1")).toBe(false);
  });

  it("a flag written before fingerprints existed is still honoured", async () => {
    fps.set("approval:ad_campaign:t1:c9", { approved: true, decision: "approved" });
    expect(await isCampaignClientApproved("t1", "c9")).toBe(true);
  });
});

describe("optimiser proposals stuck by the old handler", () => {
  it("returns approved proposals nobody acted on to proposed, leaving admin-approved ones alone", async () => {
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 2 });
    const now = Date.now();
    expect(await repairStuckOptimizerProposals("t1", 600_000, now)).toBe(2);
    expect(db.optimizerProposal.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", status: "approved", decidedByUserId: null, appliedAt: null, createdAt: { lt: new Date(now - 600_000) } },
      data: { status: "proposed" },
    });
  });
});

describe("page data and information leaks", () => {
  it("unknown, malformed and expired links are identical", async () => {
    const token = await newApproval();
    store.rows[0].expiresAt = new Date(Date.now() - 1000);
    const a = await loadApprovalPage(token);
    const b = await loadApprovalPage("A".repeat(43));
    const c = await loadApprovalPage("nope");
    expect(a).toEqual({ state: "invalid" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("returns a summary without ids or tokens", async () => {
    const token = await newApproval();
    const data = await loadApprovalPage(token);
    expect(data.state).toBe("pending");
    const html = renderToStaticMarkup(SummaryCard({ summary: (data as unknown as { summary: never }).summary }));
    expect(html).not.toMatch(/asset1|t1|brief|creator/);
    expect(JSON.stringify(data)).not.toContain(token);
  });

  it("escapes hostile strings", async () => {
    const token = await newApproval();
    const data = await loadApprovalPage(token);
    const html = renderToStaticMarkup(SummaryCard({ summary: (data as unknown as { summary: never }).summary }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>sale");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('src="https://cdn.example.com/a.png"');
  });

  it("drops unsafe image urls and control characters", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("http://x.com/a.png")).toBeUndefined();
    expect(safeHttpsUrl('https://x.com/a.png" onerror="x')).toBeUndefined();
    expect(safeHttpsUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(clean("a\u0000b‮c")).toBe("abc");
  });

  it("never resolves a subject for another tenant", async () => {
    const token = await newApproval();
    store.rows[0].tenantId = "t2";
    expect(await loadApprovalPage(token)).toEqual({ state: "invalid" });
  });
});

describe("nonce", () => {
  it("is bound to the token, single use and time limited", () => {
    const h = hashToken("a".repeat(43));
    const n = createNonce(h);
    expect(consumeNonce(hashToken("b".repeat(43)), n)).toBe(false);
    expect(consumeNonce(h, n)).toBe(true);
    expect(consumeNonce(h, n)).toBe(false);
    expect(consumeNonce(h, createNonce(h, Date.now() - 3 * 3_600_000))).toBe(false);
    expect(consumeNonce(h, "garbage")).toBe(false);
  });
});

describe("decide route", () => {
  const post = (token: string, fields: Record<string, string>, origin: string | null = ORIGIN, ip = "1.1.1.1") =>
    decideRoute(
      new Request(`${ORIGIN}/api/approvals/${token}/decide`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip, ...(origin ? { origin } : {}) },
        body: new URLSearchParams(fields).toString(),
      }),
      { params: Promise.resolve({ id: token }) },
    );
  const nonceFor = (token: string) => createNonce(hashToken(token));

  it("accepts a same-origin form post with a valid nonce and redirects", async () => {
    const token = await newApproval();
    const res = await post(token, { decision: "approved", nonce: nonceFor(token) });
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(store.rows[0].status).toBe("approved");
  });

  it("rejects cross-origin and missing-origin posts", async () => {
    const token = await newApproval();
    expect((await post(token, { decision: "approved", nonce: nonceFor(token) }, "https://evil.example")).status).toBe(403);
    expect((await post(token, { decision: "approved", nonce: nonceFor(token) }, null)).status).toBe(403);
    expect(store.rows[0].status).toBe("pending");
  });

  it("does nothing without a valid nonce, and replies the same as for an unknown token", async () => {
    const token = await newApproval();
    const bad = await post(token, { decision: "approved", nonce: "1.x" });
    const unknown = "Z".repeat(43);
    const other = await post(unknown, { decision: "approved", nonce: createNonce(hashToken(unknown)) });
    expect(store.rows[0].status).toBe("pending");
    expect(bad.status).toBe(other.status);
    expect(bad.headers.get("location")).toBe(`/approve/${token}`);
    expect(other.headers.get("location")).toBe(`/approve/${unknown}`);
  });

  it("a replayed nonce cannot change a decided approval", async () => {
    const token = await newApproval();
    const nonce = nonceFor(token);
    await post(token, { decision: "approved", nonce });
    await post(token, { decision: "rejected", nonce });
    await post(token, { decision: "rejected", nonce: nonceFor(token) });
    expect(store.rows[0].status).toBe("approved");
  });

  it("limits attempts per IP and per token", async () => {
    const token = await newApproval();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post(token, { decision: "approved", nonce: "bad" }, ORIGIN, `9.9.9.${i}`)).status;
    expect(last).toBe(429);
    decideIpLimiter.clear();
    let ipLast = 0;
    for (let i = 0; i < 25; i++) ipLast = (await post("Y".repeat(43).replace(/Y/, String.fromCharCode(65 + (i % 26))), { decision: "approved", nonce: "x" }, ORIGIN, "8.8.8.8")).status;
    expect(ipLast).toBe(429);
  });

  it("enforces the 4 KB body limit", async () => {
    const token = await newApproval();
    const res = await post(token, { decision: "approved", nonce: nonceFor(token), comment: "x".repeat(5000) });
    expect(res.status).toBe(413);
  });
});

describe("authenticated side", () => {
  const create = (body: unknown) =>
    createRoute(new Request(`${ORIGIN}/api/approvals`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("admins create links; the creator may; other agents may not", async () => {
    expect((await create({ subjectType: "creative_asset", subjectId: "asset1" })).status).toBe(201);
    auth.role = "agent";
    auth.userId = "creator";
    expect((await create({ subjectType: "creative_asset", subjectId: "asset1" })).status).toBe(201);
    auth.userId = "someone";
    expect((await create({ subjectType: "creative_asset", subjectId: "asset1" })).status).toBe(403);
    expect((await create({ subjectType: "bogus", subjectId: "asset1" })).status).toBe(400);
  });

  it("lists with expired status computed and reissue invalidates the old link", async () => {
    const token = await newApproval();
    db.approvalRequest.findMany.mockResolvedValue([{ id: "a1", status: "pending", comment: null, expiresAt: new Date(Date.now() - 1), decidedAt: null, createdAt: new Date() }]);
    expect((await listApprovals("t1", "creative_asset", "asset1"))[0].status).toBe("expired");
    const fresh = await reissueApproval("t1", store.rows[0].id);
    expect(await getApprovalByToken(token)).toBeNull();
    expect(await getApprovalByToken(tokenOf(fresh.url))).not.toBeNull();
  });
});

describe("resend", () => {
  const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
  beforeEach(() => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: true, optedOutAt: null });
  });

  it("refuses text outside the 24 hour window without rotating the link", async () => {
    const token = await newApproval();
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 30 * 3_600_000) });
    await expect(resendApproval(actor, store.rows[0].id, { mode: "text", phone: "+919876543210" })).rejects.toMatchObject({ status: 409 });
    expect(inbox.sendText).not.toHaveBeenCalled();
    expect(await getApprovalByToken(token)).not.toBeNull();
  });

  it("sends text inside the window", async () => {
    await newApproval();
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    await resendApproval(actor, store.rows[0].id, { mode: "text", phone: "+919876543210" });
    expect(inbox.sendText).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", conversationId: "cv1" }));
  });

  it("requires opt-in and an approved template for template sends", async () => {
    await newApproval();
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: false, optedOutAt: null });
    await expect(resendApproval(actor, store.rows[0].id, { mode: "template", phone: "+919876543210", templateId: "tp1" })).rejects.toMatchObject({ status: 409 });
    db.contact.findFirst.mockResolvedValue({ id: "c1", optIn: true, optedOutAt: null });
    db.template.findFirst.mockResolvedValue({ name: "approval_link", language: "en" });
    await resendApproval(actor, store.rows[0].id, { mode: "template", phone: "+919876543210", templateId: "tp1" });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", templateName: "approval_link", contactId: "c1" }));
    expect(db.template.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", status: "approved" }) }));
  });

  it("refuses unknown contacts", async () => {
    await newApproval();
    db.contact.findFirst.mockResolvedValue(null);
    await expect(resendApproval(actor, store.rows[0].id, { mode: "text", phone: "+919876543210" })).rejects.toMatchObject({ status: 409 });
  });

  it("an opt-out stops marketing only: the link still goes as a reply in the window or as a utility template, never as marketing", async () => {
    await newApproval();
    const optedOut = { id: "c1", optIn: true, optedOutAt: new Date() };
    db.contact.findFirst.mockResolvedValue(optedOut);
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    await resendApproval(actor, store.rows[0].id, { mode: "text", phone: "+919876543210" });
    expect(inbox.sendText).toHaveBeenCalledTimes(1);

    db.template.findFirst.mockResolvedValue({ name: "approval_link", language: "en", category: "UTILITY" });
    await resendApproval(actor, store.rows[0].id, { mode: "template", phone: "+919876543210", templateId: "tp1" });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);

    db.template.findFirst.mockResolvedValue({ name: "offer", language: "en", category: "MARKETING" });
    await expect(resendApproval(actor, store.rows[0].id, { mode: "template", phone: "+919876543210", templateId: "tp2" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/opted out of marketing/) });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
