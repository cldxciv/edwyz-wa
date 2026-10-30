import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  brand: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  creativeBrief: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  creativeAngle: { findFirst: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  creativeAsset: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  approvalRequest: { findMany: vi.fn() },
}));
const usage = vi.hoisted(() => ({ recordUsage: vi.fn() }));
const approvals = vi.hoisted(() => ({ createApproval: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/usage", async () => ({ CREDIT_COST: { text: 1, image: 5, video: 25 }, recordUsage: usage.recordUsage }));
vi.mock("@/lib/approvals", () => approvals);
const limits = vi.hoisted(() => ({ reserveCredits: vi.fn(async (..._a: unknown[]) => () => undefined) }));
vi.mock("@/lib/billing/limits", () => limits);

import { createBrand, generateAngles, generateCopy, generateMedia, getAsset, getBrand, getBrief, getBriefView, latestClientFeedback, readAssetFile, runResearch, sendForApproval, updateAngle } from "@/lib/creative/service";
import { registerImageProvider } from "@/lib/creative/providers";
import { setStorageForTests } from "@/lib/creative/storage";

const brand = { id: "b1", tenantId: "t1", name: "Acme", colors: ["#112233"], bannedWords: [], tone: null, industry: null, specialAdCategory: "none", websiteUrl: null };
const brief = { id: "br1", tenantId: "t1", brandId: "b1", goal: "leads", offer: "o", status: "draft", researchSummary: { offer: "x", audience: "y", tone: "z", proofPoints: [] }, brand, angles: [], assets: [] };
const angleJson = JSON.stringify({ angles: [1, 2, 3].map((n) => ({ hook: `h${n}`, audience: "a", cta: "c", rationale: "r" })) });
const files = new Map<string, Buffer>();

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  setStorageForTests({
    put: async (t, n, d) => (files.set(`${t}/${n}`, d), n),
    get: async (t, k) => {
      const f = files.get(`${t}/${k}`);
      if (!f) throw Object.assign(new Error("nf"), { status: 404 });
      return f;
    },
    remove: async () => undefined,
  });
  db.creativeBrief.findFirst.mockResolvedValue(brief);
  db.creativeAngle.findMany.mockResolvedValue([]);
  db.creativeAsset.create.mockImplementation(async ({ data }) => ({ id: "as1", ...data }));
  db.creativeAsset.findFirst.mockResolvedValue({ id: "as1", tenantId: "t1", briefId: "br1", status: "ready" });
});

describe("tenant isolation", () => {
  it("scopes every lookup by the actor tenant", async () => {
    db.brand.findFirst.mockResolvedValue(null);
    await expect(getBrand("t1", "b-other")).rejects.toMatchObject({ status: 404 });
    expect(db.brand.findFirst).toHaveBeenCalledWith({ where: { id: "b-other", tenantId: "t1" } });
    db.creativeBrief.findFirst.mockResolvedValue(null);
    await expect(getBrief("t1", "x")).rejects.toMatchObject({ status: 404 });
    expect(db.creativeBrief.findFirst.mock.calls[0][0].where).toEqual({ id: "x", tenantId: "t1" });
    db.creativeAsset.findFirst.mockResolvedValue(null);
    await expect(getAsset("t1", "x")).rejects.toMatchObject({ status: 404 });
    await expect(readAssetFile("t1", "x")).rejects.toMatchObject({ status: 404 });
    expect(db.creativeAsset.findFirst.mock.calls.every((c) => c[0].where.tenantId === "t1")).toBe(true);
  });

  it("angle updates are tenant scoped and 404 when nothing matches", async () => {
    db.creativeAngle.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateAngle("t1", "a9", { selected: true })).rejects.toMatchObject({ status: 404 });
    expect(db.creativeAngle.updateMany.mock.calls[0][0].where).toEqual({ id: "a9", tenantId: "t1" });
  });

  it("creating a brand ignores any tenant in the body", async () => {
    db.brand.create.mockImplementation(async ({ data }) => ({ id: "n", ...data }));
    await createBrand("t1", { name: "X", tenantId: "evil", industry: "Real estate" });
    const data = db.brand.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe("t1");
    expect(data.specialAdCategory).toBe("housing");
  });

  it("serving a file never uses a client-provided key", async () => {
    files.set("t2/as1.svg", Buffer.from("secret"));
    db.creativeAsset.findFirst.mockResolvedValue({ id: "as1", tenantId: "t1", storageKey: "as1.svg" });
    await expect(readAssetFile("t1", "as1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("credit accounting", () => {
  it("angles cost one text credit and only after a valid answer", async () => {
    await generateAngles("t1", "br1", { ask: vi.fn().mockResolvedValueOnce("garbage").mockResolvedValueOnce(angleJson) });
    expect(usage.recordUsage).toHaveBeenCalledTimes(1);
    expect(usage.recordUsage).toHaveBeenCalledWith("t1", "ai_credits", 1, { type: "creative_brief", id: "br1" });
  });

  it("charges nothing when the AI keeps returning invalid JSON", async () => {
    await expect(generateAngles("t1", "br1", { ask: vi.fn().mockResolvedValue("nope") })).rejects.toMatchObject({ status: 502 });
    expect(usage.recordUsage).not.toHaveBeenCalled();
  });

  it("copy costs one credit and each variant gets a policy check", async () => {
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "h", audience: "a", cta: "c" });
    const ask = vi.fn().mockResolvedValue(JSON.stringify({ variants: [{ placement: "feed", headline: "Guaranteed returns!!!", primaryText: "Join now", description: "d" }] }));
    const out = await generateCopy("t1", "br1", { angleId: "an1", placements: ["feed"] }, { ask });
    expect(usage.recordUsage).toHaveBeenCalledWith("t1", "ai_credits", 1, expect.anything());
    expect((out[0].policyCheck as { result: string }).result).toBe("block");
  });

  it("placeholder images are free; metered providers cost CREDIT_COST.image", async () => {
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "Hook" });
    const free = await generateMedia("t1", "br1", { angleId: "an1", placement: "feed" });
    expect(free).toBeTruthy();
    expect(usage.recordUsage).not.toHaveBeenCalled();
    expect(files.has("t1/as1.svg")).toBe(true);

    registerImageProvider({ name: "paid", metered: true, generate: async () => ({ data: Buffer.from("x"), contentType: "image/png", ext: "png" }) });
    process.env.CREATIVE_IMAGE_PROVIDER = "paid";
    await generateMedia("t1", "br1", { angleId: "an1", placement: "feed" });
    delete process.env.CREATIVE_IMAGE_PROVIDER;
    expect(usage.recordUsage).toHaveBeenCalledWith("t1", "ai_credits", 5, { type: "creative_asset", id: "as1" });
  });

  it("video is unavailable and costs nothing", async () => {
    await expect(generateMedia("t1", "br1", { kind: "video", angleId: "an1" })).rejects.toMatchObject({ status: 501 });
    expect(usage.recordUsage).not.toHaveBeenCalled();
  });
});

describe("approval handoff", () => {
  it("refuses blocked assets", async () => {
    db.creativeAsset.findMany.mockResolvedValue([{ id: "as1", policyCheck: { result: "block" } }]);
    await expect(sendForApproval("t1", "br1", "as1")).rejects.toMatchObject({ status: 409 });
    expect(approvals.createApproval).not.toHaveBeenCalled();
  });
  it("creates an approval for a clean asset", async () => {
    db.creativeAsset.findMany.mockResolvedValue([{ id: "as1", policyCheck: { result: "warn" } }]);
    approvals.createApproval.mockResolvedValue({ id: "ap1", url: "https://x/approve/tok" });
    expect(await sendForApproval("t1", "br1", "as1")).toEqual({ id: "ap1", url: "https://x/approve/tok" });
    expect(approvals.createApproval).toHaveBeenCalledWith("t1", { subjectType: "creative_asset", subjectId: "as1" });
    expect(db.creativeAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });
});

describe("plan AI credit limit", () => {
  beforeEach(() => {
    limits.reserveCredits.mockReset();
    limits.reserveCredits.mockResolvedValue(() => undefined);
  });
  const refuse = () => limits.reserveCredits.mockRejectedValue(Object.assign(new Error("Your AI credits are used up."), { status: 402 }));

  it("research, angles and copy check one text credit before asking the model", async () => {
    const ask = vi.fn().mockResolvedValue(angleJson);
    await generateAngles("t1", "br1", { ask });
    expect(limits.reserveCredits).toHaveBeenCalledWith("t1", 1);
    limits.reserveCredits.mockClear();
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "h", audience: "a", cta: "c" });
    await generateCopy("t1", "br1", { angleId: "an1", placements: ["feed"] }, { ask: vi.fn().mockResolvedValue(JSON.stringify({ variants: [{ placement: "feed", headline: "Hi", primaryText: "Join", description: "d" }] })) });
    expect(limits.reserveCredits).toHaveBeenCalledWith("t1", 1);
  });

  it("a workspace out of credits gets a 402 and nothing is asked, stored or charged", async () => {
    refuse();
    const ask = vi.fn();
    await expect(generateAngles("t1", "br1", { ask })).rejects.toMatchObject({ status: 402 });
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "h" });
    await expect(generateCopy("t1", "br1", { angleId: "an1", placements: ["feed"] }, { ask })).rejects.toMatchObject({ status: 402 });
    await expect(runResearch("t1", "br1", { ask })).rejects.toMatchObject({ status: 402 });
    expect(ask).not.toHaveBeenCalled();
    expect(usage.recordUsage).not.toHaveBeenCalled();
    expect(db.creativeAsset.create).not.toHaveBeenCalled();
    expect(db.creativeBrief.updateMany).not.toHaveBeenCalled();
  });

  it("a metered image checks the image price first; the free placeholder checks nothing", async () => {
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "Hook" });
    await generateMedia("t1", "br1", { angleId: "an1", placement: "feed" });
    expect(limits.reserveCredits).not.toHaveBeenCalled();

    const generate = vi.fn(async () => ({ data: Buffer.from("x"), contentType: "image/png", ext: "png" }));
    registerImageProvider({ name: "paid2", metered: true, generate });
    process.env.CREATIVE_IMAGE_PROVIDER = "paid2";
    try {
      refuse();
      await expect(generateMedia("t1", "br1", { angleId: "an1", placement: "feed" })).rejects.toMatchObject({ status: 402 });
      expect(limits.reserveCredits).toHaveBeenCalledWith("t1", 5);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      delete process.env.CREATIVE_IMAGE_PROVIDER;
    }
  });

  it("a metered provider that fell back to the placeholder is stored as placeholder and costs nothing", async () => {
    db.creativeAngle.findFirst.mockResolvedValue({ id: "an1", hook: "Hook" });
    registerImageProvider({ name: "flaky", metered: true, generate: async () => ({ data: Buffer.from("<svg/>"), contentType: "image/svg+xml", ext: "svg", fallback: true }) });
    process.env.CREATIVE_IMAGE_PROVIDER = "flaky";
    try {
      await generateMedia("t1", "br1", { angleId: "an1", placement: "feed" });
    } finally {
      delete process.env.CREATIVE_IMAGE_PROVIDER;
    }
    expect(db.creativeAsset.create.mock.calls[0][0].data).toMatchObject({ provider: "placeholder", creditCost: 0 });
    expect(usage.recordUsage).not.toHaveBeenCalled();
  });

  it("serves stored pictures with their real content type", async () => {
    for (const [key, type] of [["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.webp", "image/webp"], ["a.svg", "image/svg+xml"]] as const) {
      files.set(`t1/${key}`, Buffer.from("x"));
      db.creativeAsset.findFirst.mockResolvedValue({ id: "as1", tenantId: "t1", storageKey: key });
      expect((await readAssetFile("t1", "as1")).contentType).toBe(type);
    }
  });
});

describe("what the client said about each ad", () => {
  const at = (s: number) => new Date(2026, 0, 1, 0, 0, s);
  const row = (subjectId: string, status: string, extra: Record<string, unknown> = {}) => ({ subjectId, status, comment: null, decidedAt: null, expiresAt: new Date(Date.now() + 86_400_000), createdAt: at(0), ...extra });

  it("keeps only the newest request per ad and ages out links nobody used", () => {
    const rows = [
      row("a1", "approved", { createdAt: at(1), decidedAt: at(2) }),
      row("a1", "changes_requested", { createdAt: at(5), comment: "Please mention the price.", decidedAt: at(6) }),
      row("a2", "pending", { createdAt: at(1), expiresAt: new Date(Date.now() - 1000) }),
      row("a3", "pending", { createdAt: at(1) }),
    ];
    const out = latestClientFeedback(rows);
    expect(out.get("a1")).toEqual({ status: "changes_requested", comment: "Please mention the price.", decidedAt: at(6) });
    expect(out.get("a2")?.status).toBe("expired");
    expect(out.get("a3")?.status).toBe("pending");
    expect(out.has("a4")).toBe(false);
  });

  it("attaches the client's decision and comment to each ad of the brief, even when the ad itself is untouched", async () => {
    const assets = [
      { id: "a1", briefId: "br1", tenantId: "t1", status: "ready", headline: "Fresh bread" },
      { id: "a2", briefId: "br1", tenantId: "t1", status: "approved", headline: "Hot pies" },
      { id: "a3", briefId: "br1", tenantId: "t1", status: "ready", headline: "Never sent" },
    ];
    db.creativeBrief.findFirst.mockResolvedValue({ ...brief, assets });
    db.approvalRequest.findMany.mockResolvedValue([
      row("a1", "changes_requested", { comment: "Please mention the price.", decidedAt: at(3), createdAt: at(2) }),
      row("a2", "approved", { decidedAt: at(3), createdAt: at(2) }),
    ]);
    const view = await getBriefView("t1", "br1");
    expect(db.approvalRequest.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", subjectType: "creative_asset", subjectId: { in: ["a1", "a2", "a3"] } });
    expect(view.assets.map((a) => a.clientFeedback)).toEqual([
      { status: "changes_requested", comment: "Please mention the price.", decidedAt: at(3) },
      { status: "approved", comment: null, decidedAt: at(3) },
      null,
    ]);
    expect(view.assets[0].status).toBe("ready");
  });

  it("does not query approvals for a brief without ads", async () => {
    db.creativeBrief.findFirst.mockResolvedValue({ ...brief, assets: [] });
    const view = await getBriefView("t1", "br1");
    expect(view.assets).toEqual([]);
    expect(db.approvalRequest.findMany).not.toHaveBeenCalled();
  });
});
