import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import { backfillCommitments, planTenantBackfill } from "../scripts/spend-backfill-commitments";

// 02:00 UTC on 28 Oct is still 27 Oct (22:00) in New York and already 28 Oct (07:30) in Kolkata.
const NOW = new Date("2026-10-28T02:00:00Z");
const quiet = () => undefined;
const utcDay = (d: string) => new Date(`${d}T00:00:00Z`);

function seed() {
  h.db.seed("tenant", [
    { id: "t1", name: "Shop", slug: "shop", status: "active" },
    { id: "t2", name: "Other", slug: "other", status: "active" },
  ]);
  h.db.seed("metaAsset", [
    { id: "acc_ny", tenantId: "t1", type: "ad_account", externalId: "act_1", name: "US", status: "active", meta: { currency: "USD", timezone: "America/New_York" }, sandbox: false, createdAt: new Date("2026-01-01") },
    { id: "acc_sb", tenantId: "t1", type: "ad_account", externalId: "act_2", name: "Test", status: "active", meta: { currency: "USD" }, sandbox: true, createdAt: new Date("2026-02-01") },
    { id: "acc_in", tenantId: "t2", type: "ad_account", externalId: "act_3", name: "India", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") },
  ]);
  h.db.seed("spendControl", [{ tenantId: "t1", timezone: "Europe/London" }]);
  const campaign = (id: string, tenantId: string, account: string, o: Record<string, unknown> = {}) => ({
    id,
    tenantId,
    adAccountAssetId: account,
    metaCampaignId: `m_${id}`,
    name: id,
    status: "active",
    dailyBudgetMinor: 50_000,
    currency: tenantId === "t2" ? "INR" : "USD",
    endsAt: null,
    origin: "human",
    assistantKey: null,
    lifetimeBudgetMinor: null,
    sandbox: false,
    ...o,
  });
  h.db.seed("adCampaign", [
    campaign("c1", "t1", "acc_ny"),
    campaign("c2", "t1", "acc_ny", { dailyBudgetMinor: 30_000, origin: "assistant", assistantKey: "ads_launcher", endsAt: new Date("2026-11-15T00:00:00Z") }),
    campaign("c3", "t1", "acc_ny", { status: "paused" }),
    campaign("c4", "t1", "acc_ny", { endsAt: new Date("2026-10-20T00:00:00Z") }),
    campaign("c5", "t1", "acc_ny"),
    campaign("c6", "t1", "acc_sb", { dailyBudgetMinor: 1_000 }),
    campaign("c7", "t2", "acc_in", { dailyBudgetMinor: 100_000 }),
  ]);
  h.db.seed("adSet", [
    { id: "s1a", tenantId: "t1", campaignId: "c1", metaAdSetId: "m_s1a", name: "A", status: "active", dailyBudgetMinor: 20_000, lifetimeBudgetMinor: null },
    { id: "s1b", tenantId: "t1", campaignId: "c1", metaAdSetId: "m_s1b", name: "B", status: "active", dailyBudgetMinor: null, lifetimeBudgetMinor: null },
    { id: "s1c", tenantId: "t1", campaignId: "c1", metaAdSetId: "m_s1c", name: "C", status: "archived", dailyBudgetMinor: 99_000, lifetimeBudgetMinor: null },
    { id: "s5", tenantId: "t1", campaignId: "c5", metaAdSetId: "m_s5", name: "E", status: "active", dailyBudgetMinor: 10_000, lifetimeBudgetMinor: null },
    { id: "s7", tenantId: "t2", campaignId: "c7", metaAdSetId: "m_s7", name: "G", status: "active", dailyBudgetMinor: null, lifetimeBudgetMinor: 900_000n },
  ]);
  // c5 already has an open commitment.
  h.db.seed("spendCommitment", [{ id: "cm5", tenantId: "t1", adAccountAssetId: "acc_ny", campaignId: "c5", adSetId: "s5", metaObjectId: "m_s5", objectLevel: "adset", origin: "human", currency: "USD", timezone: "America/New_York", dailyBudgetMinor: 10_000n, status: "live" }]);
}

const created = () => h.db.rows("spendCommitment").filter((r) => r.id !== "cm5");

beforeEach(() => {
  h.db.reset();
  seed();
});

describe("spend-backfill-commitments", () => {
  it("turns every DB-active campaign into live commitments in the ad account's time zone", async () => {
    const out = await backfillCommitments({ now: NOW, log: quiet });
    expect(out).toMatchObject({ tenants: 2, planned: 5, created: 5, skipped: 0 });
    const by = (id: string) => created().find((r) => r.metaObjectId === id)!;
    // Ad sets of c1 (the archived one is left out); the budget-less ad set uses the campaign's.
    expect(by("m_s1a")).toMatchObject({ tenantId: "t1", campaignId: "c1", adSetId: "s1a", objectLevel: "adset", status: "live", currency: "USD", timezone: "America/New_York", dailyBudgetMinor: 20_000n, peakDailyBudgetMinor: 20_000n, weekPeakDailyBudgetMinor: 20_000n, dayStartBudgetMinor: 20_000n });
    expect(by("m_s1a").dayKey).toEqual(utcDay("2026-10-27"));
    expect(by("m_s1a").weekStart).toEqual(utcDay("2026-10-25"));
    expect(by("m_s1b")).toMatchObject({ dailyBudgetMinor: 50_000n });
    expect(created().some((r) => r.metaObjectId === "m_s1c")).toBe(false);
    // A campaign without ad sets is one campaign-level commitment; an assistant campaign keeps its origin and end date.
    expect(by("m_c2")).toMatchObject({ objectLevel: "campaign", origin: "assistant", assistantKey: "ads_launcher", dailyBudgetMinor: 30_000n, endsAt: new Date("2026-11-15T00:00:00Z") });
    // A sandbox account's rows are flagged; an account without a zone uses the workspace's.
    expect(by("m_c6")).toMatchObject({ sandbox: true, timezone: "Europe/London" });
    // The other workspace: Kolkata is already on 28 Oct; an ad set with only a lifetime budget is lifetime-only.
    expect(by("m_s7")).toMatchObject({ tenantId: "t2", timezone: "Asia/Kolkata", dailyBudgetMinor: null, lifetimeBudgetMinor: 900_000n });
    expect(by("m_s7").dayKey).toEqual(utcDay("2026-10-28"));
    // Paused, ended and already committed campaigns get nothing.
    expect(created().some((r) => ["c3", "c4", "c5"].includes(String(r.campaignId)))).toBe(false);
  });

  it("is idempotent: a second run adds nothing", async () => {
    await backfillCommitments({ now: NOW, log: quiet });
    const again = await backfillCommitments({ now: NOW, log: quiet });
    expect(again).toMatchObject({ planned: 0, created: 0 });
    expect(created()).toHaveLength(5);
  });

  it("a dry run plans and writes nothing, not even a control row", async () => {
    const log = vi.fn();
    const out = await backfillCommitments({ now: NOW, dryRun: true, log });
    expect(out.planned).toBe(5);
    expect(out.rows.map((r) => r.metaObjectId).sort()).toEqual(["m_c2", "m_c6", "m_s1a", "m_s1b", "m_s7"]);
    expect(created()).toHaveLength(0);
    expect(h.db.rows("spendControl").map((r) => r.tenantId)).toEqual(["t1"]);
    expect(log).toHaveBeenCalledWith("Would add 5 live commitments for 2 workspaces.");
  });

  it("leaves out an ad set paused since the campaign last changed, and adds it when the campaign changed after the pause", async () => {
    h.db.rows("adCampaign").find((r) => r.id === "c1")!.updatedAt = new Date(NOW.getTime() - 86_400_000);
    h.db.seed("spendCommitment", [
      { id: "cm_stop", tenantId: "t1", adAccountAssetId: "acc_ny", campaignId: "c1", adSetId: "s1a", metaObjectId: "m_s1a", objectLevel: "adset", origin: "human", currency: "USD", timezone: "America/New_York", dailyBudgetMinor: 20_000n, status: "stopped", updatedAt: new Date(NOW.getTime() - 3_600_000) },
    ]);
    const out = await backfillCommitments({ now: NOW, dryRun: true, log: quiet });
    expect(out.rows.map((r) => r.metaObjectId).sort()).toEqual(["m_c2", "m_c6", "m_s1b", "m_s7"]);
    // The campaign was turned on again after that pause: the ad set may be running, so it is backfilled.
    h.db.rows("adCampaign").find((r) => r.id === "c1")!.updatedAt = new Date(NOW.getTime() - 60_000);
    const again = await backfillCommitments({ now: NOW, dryRun: true, log: quiet });
    expect(again.rows.map((r) => r.metaObjectId)).toContain("m_s1a");
  });

  it("can run for one workspace", async () => {
    const out = await backfillCommitments({ now: NOW, tenantId: "t2", log: quiet });
    expect(out).toMatchObject({ tenants: 1, created: 1 });
    expect(created().map((r) => r.tenantId)).toEqual(["t2"]);
    expect((await planTenantBackfill("t2", h.db.prisma as never, NOW))).toHaveLength(0);
  });
});
