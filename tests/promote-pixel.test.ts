import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.2 (pixel row), 4.2 C7 and C9, 4.8 and PRM-07 acceptance 6 and 8 (promote-pixel): create_pixel
 * makes at most one pixel per ad account and reuses an existing pixel or dataset, returns Meta's install code, and its route
 * is admin only, same origin and 3 a day per workspace (the 4th gets 429). The readiness status reads last_fired_time (C7):
 * a visit in the last 7 days. Meta is a fake client; there is no network and no database.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  rows: [] as { id: string; tenantId: string; type: string; externalId: string; name: string | null; meta: unknown; status: string; connectionId: string }[],
  db: {
    spendControl: { findUnique: vi.fn() },
    metaAsset: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  meta: { createPixel: vi.fn(), getPixel: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/promote/meta", () => ({ promoteMeta: h.meta }));

import { promoteText } from "@/lib/promote/copy";
import {
  createOrReusePixel,
  currentPixel,
  DEFAULT_PIXEL_NAME,
  firedRecently,
  PIXEL_COPY,
  PIXEL_CREATES_PER_DAY,
  PIXEL_FIRED_WITHIN_MS,
  pixelSnippet,
  pixelStatus,
  type PixelAccount,
  type PixelDataset,
  type PixelDeps,
} from "@/lib/promote/pixel";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const DAY = 86_400_000;
const CODE = "<!-- Meta Pixel Code -->\n<script>fbq('init', '999');</script>";
const ACCOUNT: PixelAccount = { assetId: "acc", externalId: "act_123", connectionId: "conn1", name: "Shop ads" };

function fakeDeps(over: Partial<PixelDeps> = {}) {
  const stored: PixelDataset[] = [];
  const deps: PixelDeps = {
    meta: {
      createPixel: vi.fn(async () => ({ id: "999" })),
      getPixel: vi.fn(async (_ctx, id: string, opts?: { withCode?: boolean }) => ({ id, name: "Website pixel", lastFiredAt: null, unavailable: false, ...(opts?.withCode ? { code: `  ${CODE}  ` } : {}) })),
    },
    spendingAccount: vi.fn(async () => ACCOUNT),
    datasets: vi.fn(async () => [...stored]),
    saveDataset: vi.fn(async (_t: string, _a: PixelAccount, p: { id: string; name: string }) => {
      stored.push({ assetId: `ds_${p.id}`, externalId: p.id, name: p.name });
      return `ds_${p.id}`;
    }),
    audit: vi.fn(async () => undefined),
    now: () => NOW,
    dryRun: false,
    ...over,
  };
  return { deps, stored };
}

const actor = { tenantId: "t1", userId: "u1" };

describe("create_pixel: one pixel per ad account (C9)", () => {
  it("creates the first, stores it, returns the install code, and a second create reuses it", async () => {
    const { deps } = fakeDeps();
    const first = await createOrReusePixel(actor, "Shop pixel", deps);
    expect(first).toMatchObject({ id: "999", reused: false, datasetAssetId: "ds_999", code: CODE });
    expect(deps.meta.createPixel).toHaveBeenCalledWith({ tenantId: "t1", adAccountAssetId: "acc" }, "Shop pixel");
    expect(deps.saveDataset).toHaveBeenCalledWith("t1", ACCOUNT, { id: "999", name: "Shop pixel" });
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "promote.pixel_created", target: "acc" }));
    expect(deps.meta.getPixel).toHaveBeenCalledWith({ tenantId: "t1", adAccountAssetId: "acc" }, "999", { withCode: true });

    const second = await createOrReusePixel(actor, "Another", deps);
    expect(second).toMatchObject({ id: "999", reused: true, datasetAssetId: "ds_999", code: CODE });
    expect(deps.meta.createPixel).toHaveBeenCalledTimes(1);
  });

  it("reuses a pixel or dataset discovery already found on the account", async () => {
    const { deps, stored } = fakeDeps();
    stored.push({ assetId: "ds_old", externalId: "777", name: "Old pixel" });
    const r = await createOrReusePixel(actor, undefined, deps);
    expect(r).toMatchObject({ id: "777", reused: true });
    expect(deps.meta.createPixel).not.toHaveBeenCalled();
  });

  it("two taps at once create one pixel", async () => {
    const { deps } = fakeDeps();
    const [a, b] = await Promise.all([createOrReusePixel(actor, "A", deps), createOrReusePixel(actor, "B", deps)]);
    expect(a.id).toBe(b.id);
    expect(deps.meta.createPixel).toHaveBeenCalledTimes(1);
  });

  it("names it 'Website pixel' when no name is given, and needs a spending ad account", async () => {
    const { deps } = fakeDeps();
    await createOrReusePixel(actor, "   ", deps);
    expect(deps.meta.createPixel).toHaveBeenCalledWith(expect.anything(), DEFAULT_PIXEL_NAME);
    const none = fakeDeps({ spendingAccount: vi.fn(async () => null) });
    await expect(createOrReusePixel(actor, "x", none.deps)).rejects.toMatchObject({ status: 409, message: PIXEL_COPY.noAccount });
    expect(none.deps.meta.createPixel).not.toHaveBeenCalled();
  });

  it("a dry run stores nothing and reads no code", async () => {
    const { deps } = fakeDeps({ dryRun: true });
    const r = await createOrReusePixel(actor, "x", deps);
    expect(r).toMatchObject({ reused: false, datasetAssetId: null, code: null });
    expect(deps.saveDataset).not.toHaveBeenCalled();
    expect(deps.meta.getPixel).not.toHaveBeenCalled();
  });

  it("keeps the new pixel when reading its code fails, so the next tap reuses it", async () => {
    const { deps } = fakeDeps();
    (deps.meta.getPixel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("busy"));
    const r = await createOrReusePixel(actor, "x", deps);
    expect(r).toMatchObject({ id: "999", code: null, datasetAssetId: "ds_999" });
    expect((await createOrReusePixel(actor, "x", deps)).reused).toBe(true);
  });
});

describe("the readiness status (C7)", () => {
  it("a visit in the last 7 days is ok; older, none or in the future is not", () => {
    expect(firedRecently(new Date(NOW - DAY).toISOString(), NOW)).toBe(true);
    expect(firedRecently(new Date(NOW - PIXEL_FIRED_WITHIN_MS - 1000).toISOString(), NOW)).toBe(false);
    expect(firedRecently("2026-10-30T10:00:00+0000", NOW)).toBe(true);
    expect(firedRecently(null, NOW)).toBe(false);
    expect(firedRecently("not a date", NOW)).toBe(false);
    expect(firedRecently(new Date(NOW + DAY).toISOString(), NOW)).toBe(false);
  });

  it("no account, no pixel, ok, stale and unknown", async () => {
    expect(await pixelStatus("t1", fakeDeps({ spendingAccount: vi.fn(async () => null) }).deps)).toEqual({ state: "no_account" });
    expect(await pixelStatus("t1", fakeDeps().deps)).toEqual({ state: "none" });
    const { deps, stored } = fakeDeps();
    stored.push({ assetId: "ds", externalId: "999", name: "Pixel" });
    (deps.meta.getPixel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "999", name: "Pixel", lastFiredAt: new Date(NOW - DAY).toISOString(), unavailable: false });
    expect((await pixelStatus("t1", deps)).state).toBe("ok");
    (deps.meta.getPixel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "999", name: "Pixel", lastFiredAt: new Date(NOW - 9 * DAY).toISOString(), unavailable: false });
    expect((await pixelStatus("t1", deps)).state).toBe("stale");
    (deps.meta.getPixel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    expect((await pixelStatus("t1", deps)).state).toBe("unknown");
  });

  it("returns Meta's snippet trimmed and capped", () => {
    expect(pixelSnippet(`  ${CODE}\n`)).toBe(CODE);
    expect(pixelSnippet("")).toBeNull();
    expect(pixelSnippet(null)).toBeNull();
    expect(pixelSnippet("x".repeat(30_000))!.length).toBe(20_000);
  });
});

// =====================================================================================================================
// POST /api/promote/pixel and GET /api/promote/pixel
// =====================================================================================================================

const ORIGIN = "https://wa.edwyz.com";
let tenant = 0;

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.PROMOTE_ENABLED = "on";
  delete process.env.SPEND_DRY_RUN;
  tenant++;
  h.rows.length = 0;
  h.getActor.mockReset().mockResolvedValue({ userId: "u1", tenantId: `t${tenant}`, role: "admin" });
  h.db.spendControl.findUnique.mockReset().mockResolvedValue({ spendingAdAccountAssetId: "acc" });
  h.db.metaAsset.findFirst.mockReset().mockResolvedValue({ id: "acc", externalId: "act_123", connectionId: "conn1", name: "Shop ads" });
  h.db.metaAsset.findMany.mockReset().mockImplementation(async (a: { where: { tenantId: string; type: string } }) => h.rows.filter((r) => r.tenantId === a.where.tenantId && r.type === a.where.type));
  h.db.metaAsset.upsert.mockReset().mockImplementation(async (a: { create: { tenantId: string; type: string; externalId: string; name: string; meta: unknown; connectionId: string } }) => {
    const row = { id: `ds_${a.create.externalId}`, status: "active", ...a.create };
    h.rows.push(row);
    return { id: row.id };
  });
  h.db.auditLog.create.mockReset().mockResolvedValue({});
  h.meta.createPixel.mockReset().mockResolvedValue({ id: "999" });
  h.meta.getPixel.mockReset().mockImplementation(async (_ctx: unknown, id: string, opts?: { withCode?: boolean }) => ({ id, name: "Shop pixel", lastFiredAt: null, unavailable: false, ...(opts?.withCode ? { code: CODE } : {}) }));
});

const post = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/promote/pixel`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/promote/pixel", () => {
  it("creates once, reuses after, returns the snippet, and the 4th create in a day gets 429", async () => {
    const { POST } = await import("@/app/api/promote/pixel/route");
    expect(PIXEL_CREATES_PER_DAY).toBe(3);
    const first = await POST(post({ name: "Shop pixel" }), undefined);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { pixel: { id: string; reused: boolean; code: string }; installHelp: string };
    expect(body.pixel).toMatchObject({ id: "999", reused: false, code: CODE });
    expect(body.installHelp).toBe(promoteText("readiness.pixel_install"));
    // Stored as a dataset of the spending account's connection, so the next tap reuses it.
    expect(h.db.metaAsset.upsert.mock.calls[0][0].create).toMatchObject({ type: "dataset", externalId: "999", connectionId: "conn1", meta: { adAccountId: "act_123", createdInEdwyz: true } });
    const second = (await (await POST(post({ name: "Again" }), undefined)).json()) as { pixel: { id: string; reused: boolean; code: string } };
    expect(second.pixel).toMatchObject({ id: "999", reused: true, code: CODE });
    expect((await POST(post({}), undefined)).status).toBe(200);
    expect(h.meta.createPixel).toHaveBeenCalledTimes(1);
    const fourth = await POST(post({ name: "x" }), undefined);
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { error: string }).error).toBe(PIXEL_COPY.tooMany);
  });

  it("is admin only and same origin, and hidden while PROMOTE_ENABLED is off", async () => {
    const { POST } = await import("@/app/api/promote/pixel/route");
    expect((await POST(post({ name: "x" }, "https://evil.example"), undefined)).status).toBe(403);
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: `t${tenant}`, role: "agent" });
    expect((await POST(post({ name: "x" }), undefined)).status).toBe(403);
    process.env.PROMOTE_ENABLED = "off";
    expect((await POST(post({ name: "x" }), undefined)).status).toBe(404);
    expect(h.meta.createPixel).not.toHaveBeenCalled();
  });

  it("answers with fake ids and stores nothing under SPEND_DRY_RUN", async () => {
    const { POST } = await import("@/app/api/promote/pixel/route");
    process.env.SPEND_DRY_RUN = "1";
    const body = (await (await POST(post({ name: "x" }), undefined)).json()) as { pixel: { datasetAssetId: string | null; code: string | null }; notice?: string };
    expect(body.pixel).toMatchObject({ datasetAssetId: null, code: null });
    expect(body.notice).toBeUndefined();
    expect(h.db.metaAsset.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/promote/pixel", () => {
  it("returns the stored pixel with its code without creating one, for admins only", async () => {
    const { GET } = await import("@/app/api/promote/pixel/route");
    const get = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/promote/pixel`, { headers });
    expect(((await (await GET(get(), undefined)).json()) as { pixel: unknown }).pixel).toBeNull();
    h.rows.push({ id: "ds_5", tenantId: `t${tenant}`, type: "dataset", externalId: "555", name: "Pixel", meta: { adAccountId: "act_123" }, status: "active", connectionId: "conn1" });
    const body = (await (await GET(get(), undefined)).json()) as { pixel: { id: string; code: string; reused: boolean } };
    expect(body.pixel).toMatchObject({ id: "555", code: CODE, reused: true });
    expect(h.meta.createPixel).not.toHaveBeenCalled();
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: `t${tenant}`, role: "agent" });
    expect((await GET(get(), undefined)).status).toBe(403);
    expect((await GET(get({ origin: "https://evil.example" }), undefined)).status).toBe(403);
  });

  it("ignores another ad account's pixels", async () => {
    const actorT = { tenantId: `t${tenant}` };
    h.rows.push({ id: "ds_6", tenantId: `t${tenant}`, type: "dataset", externalId: "666", name: "Other", meta: { adAccountId: "act_999" }, status: "active", connectionId: "conn1" });
    expect(await currentPixel(actorT)).toBeNull();
  });
});
