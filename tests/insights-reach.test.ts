import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.10 and 4.2 R3a, PRM-12 acceptance 5 (insights-reach): the Overview's reach for a run comes from
 * the run total (one InsightBreakdown row per campaign, dimension run_total, dimKey 'all', date = the run's start), read with
 * time_range over the run and no time_increment. Daily reach counts a person once per day, so it is never added up: in a
 * fixture where the two differ, the Overview shows the run total. A day's own reach shows only on a one-day range. Each sync
 * updates the one row per campaign. CTR and CPM come from summed clicks, impressions and spend.
 */
const h = vi.hoisted(() => {
  const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
  const matchValue = (v: unknown, c: unknown): boolean => {
    if (c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c)) {
      const o = c as Record<string, unknown>;
      if ("in" in o) return (o.in as unknown[]).some((x) => eq(v, x));
      if ("not" in o) return !eq(v, o.not);
      return (!("gte" in o) || num(v) >= num(o.gte)) && (!("lte" in o) || num(v) <= num(o.lte));
    }
    return eq(v, c);
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, c]) => (k === "NOT" ? !matches(row, c as Record<string, unknown>) : matchValue(row[k], c)));
  const keyOf = (k: Record<string, unknown>) => [k.tenantId, k.entityType, k.entityMetaId, (k.date as Date).toISOString(), k.dimension, k.dimKey].join("|");
  const store = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    matches,
    keyOf,
    store,
    all: () => [...store.values()],
    nextId: () => `ib${++seq}`,
    campaigns: [] as Record<string, unknown>[],
    snaps: [] as Record<string, unknown>[],
    settings: new Map<string, unknown>(),
    fetchAs: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    insightBreakdown: {
      upsert: async ({ where, create, update }: { where: { tenantId_entityType_entityMetaId_date_dimension_dimKey: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = h.keyOf(where.tenantId_entityType_entityMetaId_date_dimension_dimKey);
        const hit = h.store.get(k);
        if (hit) Object.assign(hit, update);
        else h.store.set(k, { id: h.nextId(), ...create });
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [k, r] of h.store) {
          if (h.matches(r, where)) {
            h.store.delete(k);
            count++;
          }
        }
        return { count };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => h.all().filter((r) => h.matches(r, where)).length,
      findMany: async ({ where }: { where: Record<string, unknown> }) => h.all().filter((r) => h.matches(r, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => h.all().find((r) => h.matches(r, where)) ?? null,
    },
    insightSnapshot: { findMany: async ({ where }: { where: Record<string, unknown> }) => h.snaps.filter((r) => h.matches(r, where)) },
    adCampaign: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => h.campaigns.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
      findMany: async ({ where }: { where: { tenantId: string } }) => h.campaigns.filter((c) => c.tenantId === where.tenantId),
    },
    platformSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (h.settings.has(where.key) ? { value: h.settings.get(where.key) } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void h.settings.set(where.key, create.value),
    },
  },
}));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/meta-connect", () => ({
  listAssets: async () => [{ id: "acc1", type: "ad_account", externalId: "999", name: "Main", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" } }],
  getAssetAccess: async () => ({ assetId: "acc1", type: "ad_account", externalId: "999", name: "Main", token: "user-token" }),
}));
vi.mock("@/lib/graph", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graph")>("@/lib/graph");
  return { ...actual, graphFetchAs: (...a: unknown[]) => h.fetchAs(...a) };
});

import { syncBreakdownsTenant } from "@/lib/ads/insights-sync";
import { dimensionRows, overviewView, RESULTS_COPY } from "@/lib/promote/breakdowns";
import { createThrottle } from "@/lib/promote/throttle";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const C1 = "120200000000001";
const C2 = "120200000000002";
const C3 = "120200000000003";
const AD1 = "120200000000101";
const CHAT = "onsite_conversion.messaging_conversation_started_7d";

const throttle = () => createThrottle({ store: { get: async () => null, set: async () => undefined }, now: () => NOW.getTime() });

const campaign = (id: string, metaCampaignId: string, startsAt: string, ads: string[] = []) => ({
  id,
  tenantId: "t1",
  name: `Campaign ${id}`,
  metaCampaignId,
  adAccountAssetId: "acc1",
  goal: "whatsapp_chats",
  template: "click_to_whatsapp",
  objective: "OUTCOME_ENGAGEMENT",
  currency: "INR",
  sourceKind: "new",
  status: "active",
  startsAt: new Date(startsAt),
  launchedAt: new Date(startsAt),
  adSets: [{ id: `${id}-set`, name: "Set", metaAdSetId: null, variantKey: null, status: "active", ads: ads.map((metaAdId) => ({ id: `${id}-${metaAdId}`, name: "Ad", metaAdId, variantLabel: null, format: "single_image", creative: {} })) }],
});

/** Three days, two placements a day, each with its own daily reach. Their sum (2,400) over-counts the people reached. */
const DAILY = ["2026-10-28", "2026-10-29", "2026-10-30"].flatMap((day) =>
  ["reels", "stream"].map((position) => ({
    ad_id: AD1,
    campaign_id: C1,
    date_start: day,
    publisher_platform: "instagram",
    platform_position: position,
    spend: "100.00",
    impressions: "1000",
    reach: "400",
    clicks: "20",
    actions: [{ action_type: CHAT, value: "5" }],
  })),
);

type Query = Record<string, string>;
const runReach: Record<string, string> = {};

function fakeMeta(): Query[] {
  const sent: Query[] = [];
  h.fetchAs.mockImplementation(async (_t: string, req: { query: Query }) => {
    sent.push(req.query);
    if (!req.query.breakdowns) {
      const ids = JSON.parse(req.query.filtering)[0].value as string[];
      const { since, until } = JSON.parse(req.query.time_range) as { since: string; until: string };
      return { data: ids.map((campaign_id) => ({ campaign_id, date_start: since, date_stop: until, reach: runReach[campaign_id] ?? "0", frequency: "1.6", spend: "600.00", impressions: "6000" })) };
    }
    if (req.query.breakdowns === "publisher_platform,platform_position") return { data: DAILY.filter((r) => JSON.parse(req.query.filtering)[0].value.includes(r.campaign_id)) };
    return { data: [] };
  });
  return sent;
}

beforeEach(() => {
  h.store.clear();
  h.campaigns.length = 0;
  h.snaps.length = 0;
  h.settings.clear();
  h.fetchAs.mockReset();
  for (const k of Object.keys(runReach)) delete runReach[k];
});

describe("run reach (R3a, 3.10)", () => {
  it("comes from the run_total row, read over the run with no time_increment, and differs from the sum of the daily rows", async () => {
    h.campaigns.push(campaign("k1", C1, "2026-10-28T03:00:00.000Z", [AD1]));
    runReach[C1] = "1500";
    const sent = fakeMeta();
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });

    const r3a = sent.filter((q) => !q.breakdowns);
    expect(r3a).toHaveLength(1);
    expect(r3a[0].time_increment).toBeUndefined();
    expect(r3a[0].level).toBe("campaign");
    expect(JSON.parse(r3a[0].time_range)).toEqual({ since: "2026-10-28", until: "2026-10-31" });

    const runRows = h.all().filter((r) => r.dimension === "run_total");
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ entityType: "campaign", entityMetaId: C1, dimKey: "all", reach: 1500 });
    expect((runRows[0].date as Date).toISOString().slice(0, 10)).toBe("2026-10-28");

    // The fixture's daily reach adds up to 2,400; the run reached 1,500 people.
    const dailySum = h
      .all()
      .filter((r) => r.dimension === "placement")
      .reduce((n, r) => n + Number(r.reach), 0);
    expect(dailySum).toBe(2400);

    const res = await dimensionRows("t1", "k1", "overview", { from: "2026-10-28", to: "2026-10-31" });
    expect(res.overview).toMatchObject({ reach: 1500, reachScope: "run", reachLabel: "People reached (whole run)", source: "breakdowns" });
    expect(res.overview!.reach).not.toBe(dailySum);
    // Spend, results, CTR and CPM do add up across days: from the summed rows.
    expect(res.overview).toMatchObject({
      spendMinor: "60000",
      spend: "₹600",
      results: 30,
      resultsText: "30 chats",
      costPerResult: "₹20",
      impressions: 6000,
      clicks: 120,
      ctr: 2,
      ctrLabel: "clicks per 100 views",
      cpmMinor: "10000",
      cpm: "₹100",
      cpmLabel: "cost per 1,000 views",
    });
  });

  it("shows a day's own reach only on a one-day range, never a sum, and says when no run total exists yet", async () => {
    h.campaigns.push(campaign("k1", C1, "2026-10-28T03:00:00.000Z", [AD1]));
    h.snaps.push({ tenantId: "t1", entityType: "campaign", entityMetaId: C1, date: new Date("2026-10-29T00:00:00.000Z"), spendMinor: 20000, impressions: 2000, clicks: 40, results: 10, reach: 700, messagingStarts: 10, raw: { objective: "OUTCOME_ENGAGEMENT", resultAction: CHAT } });
    runReach[C1] = "1500";
    fakeMeta();
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });
    const day = await dimensionRows("t1", "k1", "overview", { from: "2026-10-29", to: "2026-10-29" });
    expect(day.overview).toMatchObject({ reach: 700, reachScope: "day", reachLabel: "People reached that day" });

    // Before the first sync there is no run total: the Overview says so instead of adding days up.
    h.store.clear();
    const none = await dimensionRows("t1", "k1", "overview", { from: "2026-10-28", to: "2026-10-31" });
    expect(none.overview).toMatchObject({ reach: null, reachScope: null, reachLabel: RESULTS_COPY.reachMissing, source: "snapshots", spendMinor: "20000", results: 10 });
  });

  it("each sync updates the one row per campaign; campaigns that start the same day share one read", async () => {
    h.campaigns.push(campaign("k1", C1, "2026-10-28T03:00:00.000Z"), campaign("k2", C2, "2026-10-28T10:00:00.000Z"), campaign("k3", C3, "2026-10-25T10:00:00.000Z"));
    Object.assign(runReach, { [C1]: "1500", [C2]: "300", [C3]: "90" });
    const first = fakeMeta();
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });
    const reads = first.filter((q) => !q.breakdowns).map((q) => ({ ids: JSON.parse(q.filtering)[0].value, range: JSON.parse(q.time_range) }));
    expect(reads).toEqual([
      { ids: [C3], range: { since: "2026-10-25", until: "2026-10-31" } },
      { ids: [C1, C2], range: { since: "2026-10-28", until: "2026-10-31" } },
    ]);
    const runRows = () => h.all().filter((r) => r.dimension === "run_total");
    expect(runRows()).toHaveLength(3);

    // Meta revises the run's reach: the next sync updates the same rows.
    Object.assign(runReach, { [C1]: "1800" });
    fakeMeta();
    await syncBreakdownsTenant("t1", new Date(NOW.getTime() + 6 * 3_600_000), { throttle: throttle() });
    expect(runRows()).toHaveLength(3);
    expect(runRows().find((r) => r.entityMetaId === C1)).toMatchObject({ reach: 1800 });

    // The run's start moves: the old row is replaced, so there is still exactly one per campaign.
    (h.campaigns[0] as { startsAt: Date }).startsAt = new Date("2026-10-27T03:00:00.000Z");
    fakeMeta();
    await syncBreakdownsTenant("t1", new Date(NOW.getTime() + 12 * 3_600_000), { throttle: throttle() });
    const c1 = runRows().filter((r) => r.entityMetaId === C1);
    expect(c1).toHaveLength(1);
    expect((c1[0].date as Date).toISOString().slice(0, 10)).toBe("2026-10-27");
    expect(runRows()).toHaveLength(3);
  });

  it("for an awareness campaign the result is people reached, so it follows the same rule: the run total, never the daily sum", () => {
    // Placement rows of an awareness campaign count each day's reach as that day's result: 2,400 added up.
    const totals = { spendMinor: 60_000n, impressions: 6000, clicks: 120, results: 2400, leads: 0 };
    const run = overviewView({ totals, source: "breakdowns", runReach: 1500, runSpendMinor: 60_000n, dayReach: null, singleDay: false, currency: "INR", resultKey: "awareness" });
    expect(run).toMatchObject({ results: 1500, resultsText: "1,500 people reached", reach: 1500, costPerResultMinor: "40", costScope: "run", costPerResultLabel: "Cost per person reached (whole run)" });
    const day = overviewView({ totals, source: "breakdowns", runReach: 1500, dayReach: 700, singleDay: true, currency: "INR", resultKey: "awareness" });
    expect(day).toMatchObject({ results: 700, reach: 700, reachScope: "day", costScope: "day", costPerResultLabel: "Cost per person reached that day" });
    // Other goals keep their summed results (chats do add up across days).
    expect(overviewView({ totals, source: "breakdowns", runReach: 1500, dayReach: null, singleDay: false, currency: "INR", resultKey: "whatsapp_chats" })).toMatchObject({ results: 2400, costScope: "range", costPerResultLabel: "Cost per chat" });
  });

  it("an awareness campaign on part of its run divides the whole run's spend by the run's reach, never the range's spend", () => {
    // The last 7 days of a 30-day run: ₹140 spent in the range, ₹600 over the run, which reached 1,500 people.
    const lastWeek = { spendMinor: 14_000n, impressions: 1400, clicks: 28, results: 560, leads: 0 };
    const view = overviewView({ totals: lastWeek, source: "breakdowns", runReach: 1500, runSpendMinor: 60_000n, dayReach: null, singleDay: false, currency: "INR", resultKey: "awareness" });
    // ₹600 / 1,500 = ₹0.40 a person, not ₹140 / 1,500 (about 4x too low).
    expect(view).toMatchObject({ spendMinor: "14000", results: 1500, costPerResultMinor: "40", costPerResult: "₹0.40", costScope: "run" });
    // Without the run's own spend there is no honest cost per person: none is shown.
    expect(overviewView({ totals: lastWeek, source: "breakdowns", runReach: 1500, runSpendMinor: null, dayReach: null, singleDay: false, currency: "INR", resultKey: "awareness" })).toMatchObject({ results: 1500, costPerResultMinor: null, costPerResult: null });
    // No run total yet: the result says so instead of 0 people.
    expect(overviewView({ totals: lastWeek, source: "breakdowns", runReach: null, runSpendMinor: null, dayReach: null, singleDay: false, currency: "INR", resultKey: "awareness" })).toMatchObject({ results: null, resultsText: RESULTS_COPY.reachMissing });
  });

  it("the Overview of an awareness campaign uses the run total's own spend; its other tabs show views, never summed reach", async () => {
    h.campaigns.push({ ...campaign("k1", C1, "2026-10-28T03:00:00.000Z", [AD1]), goal: "awareness", template: "awareness", objective: "OUTCOME_AWARENESS" });
    runReach[C1] = "1500";
    fakeMeta();
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });
    // The run total stored its own spend (₹600) with the reach.
    expect(h.all().find((r) => r.dimension === "run_total")).toMatchObject({ reach: 1500, spendMinor: 60_000n });

    // Only the last day of the run: ₹200 spent in the range; the cost per person is the run's ₹600 / 1,500.
    const partial = await dimensionRows("t1", "k1", "overview", { from: "2026-10-30", to: "2026-10-31" });
    expect(partial.overview).toMatchObject({ spendMinor: "20000", results: 1500, resultsText: "1,500 people reached", costPerResultMinor: "40", costScope: "run" });

    // Where it worked: each placement's daily reach (400 a day, 1,200 over 3 days) is not people reached. Views are.
    const where = await dimensionRows("t1", "k1", "placement", { from: "2026-10-28", to: "2026-10-31" });
    expect(where.measure).toBe("views");
    expect(where.rows.map((r) => r.text)).toEqual(["Instagram Reels: 3,000 views, ₹100 per 1,000 views", "Instagram Feed: 3,000 views, ₹100 per 1,000 views"]);
    expect(where.rows[0]).toMatchObject({ measure: "views", results: 3000, costPerResultMinor: "10000" });
    expect(where.rows.some((r) => r.text.includes("people reached"))).toBe(false);
    expect(where.notes).toContain(RESULTS_COPY.viewsNotReach);
    const creative = await dimensionRows("t1", "k1", "creative", { from: "2026-10-28", to: "2026-10-31" });
    expect(creative.rows[0].text).toBe("Ad: 6,000 views, ₹100 per 1,000 views");
  });

  it("a fair test whose result is people reached also reads each version's run total, one row per ad set", async () => {
    const SET_A = "120200000000201";
    const SET_B = "120200000000202";
    const c = campaign("k1", C1, "2026-10-28T03:00:00.000Z");
    h.campaigns.push(
      {
        ...c,
        goal: "awareness",
        template: "awareness",
        objective: "OUTCOME_AWARENESS",
        adSets: [
          { id: "set-a", name: "Version A", metaAdSetId: SET_A, variantKey: "A", status: "active", ads: [] },
          { id: "set-b", name: "Version B", metaAdSetId: SET_B, variantKey: "B", status: "active", ads: [] },
        ],
      },
      // A chats campaign with versions needs no per-version reach.
      { ...campaign("k2", C2, "2026-10-28T03:00:00.000Z"), adSets: [{ id: "x", metaAdSetId: "1", variantKey: "A", ads: [] }, { id: "y", metaAdSetId: "2", variantKey: "B", ads: [] }] },
    );
    const sent: Query[] = [];
    h.fetchAs.mockImplementation(async (_t: string, req: { query: Query }) => {
      sent.push(req.query);
      if (!req.query.breakdowns && req.query.level === "adset") {
        return {
          data: [
            { campaign_id: C1, adset_id: SET_A, date_start: "2026-10-28", date_stop: "2026-10-31", reach: "900", spend: "300.00", impressions: "3000" },
            { campaign_id: C1, adset_id: SET_B, date_start: "2026-10-28", date_stop: "2026-10-31", reach: "700", spend: "300.00", impressions: "3000" },
          ],
        };
      }
      if (!req.query.breakdowns) return { data: [{ campaign_id: C1, date_start: "2026-10-28", reach: "1500", spend: "600.00" }] };
      return { data: [] };
    });
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });
    const perSet = sent.filter((q) => !q.breakdowns && q.level === "adset");
    expect(perSet).toHaveLength(1);
    expect(JSON.parse(perSet[0].filtering)[0]).toEqual({ field: "campaign.id", operator: "IN", value: [C1] });
    expect(perSet[0].time_increment).toBeUndefined();
    expect(perSet[0].fields.split(",")).toContain("adset_id");
    const rows = h.all().filter((r) => r.dimension === "run_total" && r.entityType === "adset");
    expect(rows.map((r) => [r.entityMetaId, r.reach, r.dimKey])).toEqual([
      [SET_A, 900, "all"],
      [SET_B, 700, "all"],
    ]);
    expect((rows[0].date as Date).toISOString().slice(0, 10)).toBe("2026-10-28");
    // The campaign's own run total is still one row.
    expect(h.all().filter((r) => r.dimension === "run_total" && r.entityType === "campaign")).toHaveLength(1);
  });

  it("a campaign that has not started yet gets no run total read", async () => {
    h.campaigns.push(campaign("k1", C1, "2026-11-05T03:00:00.000Z"));
    const sent = fakeMeta();
    await syncBreakdownsTenant("t1", NOW, { throttle: throttle() });
    expect(sent.filter((q) => !q.breakdowns)).toHaveLength(0);
    expect(h.all().filter((r) => r.dimension === "run_total")).toHaveLength(0);
  });
});
