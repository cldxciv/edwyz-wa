import { beforeEach, describe, expect, it, vi } from "vitest";

type Snap = {
  tenantId: string;
  entityType: string;
  entityMetaId: string;
  date: Date;
  spendMinor: number;
  impressions: number;
  clicks: number;
  results: number;
  frequency: number | null;
  qualityRanking: string | null;
  raw?: unknown;
};

const db = vi.hoisted(() => ({
  snaps: [] as Snap[],
  campaigns: [] as { id: string; tenantId: string; metaCampaignId: string | null; name: string; status: string; currency: string; dailyBudgetMinor: number; adAccountAssetId?: string }[],
  adSets: [] as { tenantId: string; metaAdSetId: string; name: string }[],
  ads: [] as { tenantId: string; metaAdId: string; name: string }[],
  assets: [] as { tenantId: string; type: string; status: string; meta: unknown; id?: string; externalId?: string; name?: string | null }[],
  connections: [] as { tenantId: string; status: string }[],
  settings: new Map<string, unknown>(),
  jobs: [] as unknown[],
  daily: [] as Record<string, unknown>[],
  commitments: [] as { tenantId: string; adAccountAssetId: string; objectLevel: string; metaObjectId: string }[],
}));

const inIds = (arr: string[] | undefined, v: string | null) => !arr || (v !== null && arr.includes(v));

vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({
  prisma: {
    insightSnapshot: {
      upsert: async ({ where, create, update }: { where: { tenantId_entityType_entityMetaId_date: Pick<Snap, "tenantId" | "entityType" | "entityMetaId" | "date"> }; create: Snap; update: Partial<Snap> }) => {
        const k = where.tenantId_entityType_entityMetaId_date;
        const hit = db.snaps.find((s) => s.tenantId === k.tenantId && s.entityType === k.entityType && s.entityMetaId === k.entityMetaId && s.date.getTime() === k.date.getTime());
        if (hit) Object.assign(hit, update);
        else db.snaps.push({ ...create });
      },
      findMany: async ({ where }: { where: { tenantId: string; entityType: string; date: { gte: Date; lte: Date }; entityMetaId?: { in: string[] } } }) =>
        db.snaps.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.entityType === where.entityType &&
            s.date >= where.date.gte &&
            s.date <= where.date.lte &&
            inIds(where.entityMetaId?.in, s.entityMetaId),
        ),
    },
    adCampaign: {
      findMany: async ({ where }: { where: { tenantId: string; status?: string; metaCampaignId?: { in: string[] } | { not: null } } }) =>
        db.campaigns.filter((c) => {
          if (c.tenantId !== where.tenantId) return false;
          if (where.status && c.status !== where.status) return false;
          const m = where.metaCampaignId;
          if (m && "in" in m) return m.in.includes(c.metaCampaignId ?? "");
          if (m && "not" in m) return c.metaCampaignId !== null;
          return true;
        }),
    },
    adSet: { findMany: async ({ where }: { where: { tenantId: string; metaAdSetId: { in: string[] } } }) => db.adSets.filter((a) => a.tenantId === where.tenantId && where.metaAdSetId.in.includes(a.metaAdSetId)) },
    ad: { findMany: async ({ where }: { where: { tenantId: string; metaAdId: { in: string[] } } }) => db.ads.filter((a) => a.tenantId === where.tenantId && where.metaAdId.in.includes(a.metaAdId)) },
    metaAsset: {
      findMany: async ({ where }: { where: { tenantId: string; type: string } }) => db.assets.filter((a) => a.tenantId === where.tenantId && a.type === where.type),
      count: async ({ where }: { where: { tenantId: string; type: string; status: string } }) => db.assets.filter((a) => a.tenantId === where.tenantId && a.type === where.type && a.status === where.status).length,
    },
    metaConnection: {
      count: async ({ where }: { where: { tenantId: string; status: string } }) => db.connections.filter((c) => c.tenantId === where.tenantId && c.status === where.status).length,
      findMany: async ({ where }: { where: { status: string } }) => [...new Set(db.connections.filter((c) => c.status === where.status).map((c) => c.tenantId))].map((tenantId) => ({ tenantId })),
    },
    platformSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (db.settings.has(where.key) ? { value: db.settings.get(where.key) } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void db.settings.set(where.key, create.value),
    },
    // The spend controls' SpendDaily (SET for older days, docs/SPEND-CONTROLS-SPEC.md 6.1) and campaign-level commitments.
    spendDaily: {
      upsert: async ({ where, create, update }: { where: { tenantId_pot_scopeType_scopeId_day_origin: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = where.tenantId_pot_scopeType_scopeId_day_origin;
        const hit = db.daily.find((r) => ["tenantId", "pot", "scopeType", "scopeId", "origin"].every((f) => r[f] === k[f]) && (r.day as Date).getTime() === (k.day as Date).getTime());
        if (hit) Object.assign(hit, update);
        else db.daily.push({ ...create });
      },
    },
    spendCommitment: {
      findMany: async ({ where }: { where: { tenantId: string; adAccountAssetId: string; objectLevel: string } }) =>
        db.commitments.filter((c) => c.tenantId === where.tenantId && c.adAccountAssetId === where.adAccountAssetId && c.objectLevel === where.objectLevel),
    },
  },
}));

const graph = vi.hoisted(() => ({ fetchAs: vi.fn() }));
vi.mock("@/lib/graph", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graph")>("@/lib/graph");
  return { ...actual, graphFetchAs: graph.fetchAs };
});

const connect = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/queue", () => ({ enqueue: async (...a: unknown[]) => void db.jobs.push(a) }));

import { GraphError } from "@/lib/graph";
import { HttpError } from "@/lib/tenancy";
import { costPerResultMinor, currencyExponent, decimalToMinor } from "@/lib/ads/insights-money";
import { normalizeRanking, pickResults } from "@/lib/ads/insights-map";
import { MAX_PAGES, exactSpendMinor, fetchLevel, isRateLimit } from "@/lib/ads/insights-fetch";
import { setLogSink } from "@/lib/log";
import { toSnapshot, upsertSnapshots } from "@/lib/ads/insights-store";
import { MANUAL_COOLDOWN_MS, requestManualSync, syncTenant, syncWindow } from "@/lib/ads/insights-sync";
import { accountScope, breakdownByLevel, dailySeries, fatigueCandidates, insightAccounts, spendPacing, summaryByCurrency, summaryByPeriod, tenantCurrency, topAndBottomAds } from "@/lib/ads/insights-queries";
import { BASE_FIELDS, LEVEL_FIELDS } from "@/lib/ads/insights-fetch";
import { worker } from "@/lib/ads/insights-worker";
import { BREAKDOWN_FIELDS, BREAKDOWN_FILTER_MAX, RUN_TOTAL_FIELDS, VIDEO_FIELDS, breakdownQuery, fetchBreakdown, type InsightsPace } from "@/lib/ads/insights-fetch";
import { CHAT_STARTED, RESULT_ACTIONS, leadCount, pickRowResults, resultActionsFor, resultActionsForOptimization, sumActions } from "@/lib/ads/insights-map";
import { goalRow } from "@/lib/promote/catalog/goals";
import { PROMOTE_GOAL_KEYS } from "@/lib/promote/flags";

const snap = (o: Omit<Partial<Snap>, "date"> & { entityMetaId: string; date: string }): Snap => ({
  tenantId: "t1",
  entityType: "ad",
  spendMinor: 0,
  impressions: 0,
  clicks: 0,
  results: 0,
  frequency: null,
  qualityRanking: null,
  ...o,
  date: new Date(`${o.date}T00:00:00.000Z`),
});

beforeEach(() => {
  db.snaps.length = 0;
  db.campaigns.length = 0;
  db.adSets.length = 0;
  db.ads.length = 0;
  db.assets.length = 0;
  db.connections.length = 0;
  db.settings.clear();
  db.jobs.length = 0;
  db.daily.length = 0;
  db.commitments.length = 0;
  graph.fetchAs.mockReset();
  connect.listAssets.mockReset();
  connect.getAssetAccess.mockReset();
});

describe("money conversion", () => {
  it("converts decimal strings to minor units with integers", () => {
    expect(decimalToMinor("12.34", 2)).toBe(1234);
    expect(decimalToMinor("0.1", 2)).toBe(10);
    expect(decimalToMinor("0.29", 2)).toBe(29);
    expect(decimalToMinor("19.99", 2)).toBe(1999);
    expect(decimalToMinor("1.005", 2)).toBe(101);
    expect(decimalToMinor("1.004", 2)).toBe(100);
    expect(decimalToMinor("7", 2)).toBe(700);
    expect(decimalToMinor("1234.5", 0)).toBe(1235);
    expect(decimalToMinor("1.2345", 3)).toBe(1235);
    expect(decimalToMinor("", 2)).toBe(0);
    expect(decimalToMinor(undefined, 2)).toBe(0);
  });
  it("rejects non-decimal input and clamps to the 32-bit column", () => {
    expect(() => decimalToMinor("1e3", 2)).toThrow();
    expect(() => decimalToMinor("-5", 2)).toThrow();
    expect(() => decimalToMinor("abc", 2)).toThrow();
    expect(decimalToMinor("999999999999", 2)).toBe(2_147_483_647);
  });
  it("knows currency exponents", () => {
    expect(currencyExponent("INR")).toBe(2);
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent(null)).toBe(2);
  });
  it("computes cost per result in integers", () => {
    expect(costPerResultMinor(1000, 3)).toBe(333);
    expect(costPerResultMinor(1001, 2)).toBe(501);
    expect(costPerResultMinor(500, 0)).toBeNull();
  });
});

describe("result mapping", () => {
  it("uses the objective's primary action and never double counts", () => {
    const actions = [{ action_type: "link_click", value: "40" }, { action_type: "lead", value: "5" }, { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "9" }];
    expect(pickResults("OUTCOME_LEADS", actions)).toEqual({ results: 5, actionType: "lead" });
    expect(pickResults("OUTCOME_ENGAGEMENT", actions)).toEqual({ results: 9, actionType: "onsite_conversion.messaging_conversation_started_7d" });
    expect(pickResults("OUTCOME_AWARENESS", actions).results).toBe(0);
    expect(pickResults(undefined, actions).results).toBe(5);
    expect(pickResults("OUTCOME_LEADS", undefined).results).toBe(0);
  });
  it("normalizes quality rankings", () => {
    expect(normalizeRanking("BELOW_AVERAGE_20")).toBe("below_average_20");
    expect(normalizeRanking("UNKNOWN")).toBeNull();
    expect(normalizeRanking(undefined)).toBeNull();
  });
  it("maps a Graph row to a snapshot", () => {
    const s = toSnapshot("t1", "ad", { ad_id: "a1", date_start: "2026-10-01", spend: "12.34", impressions: "1000", clicks: "25", frequency: "1.456", objective: "OUTCOME_LEADS", actions: [{ action_type: "lead", value: "2" }], quality_ranking: "ABOVE_AVERAGE" }, 2);
    expect(s).toMatchObject({ entityMetaId: "a1", spendMinor: 1234, impressions: 1000, clicks: 25, results: 2, frequency: 1.46, qualityRanking: "above_average" });
    expect(toSnapshot("t1", "ad", { date_start: "2026-10-01" }, 2)).toBeNull();
    expect(toSnapshot("t1", "campaign", { campaign_id: "c", date_start: "2026-10-01", spend: "1e5" }, 2)).toBeNull();
    expect(toSnapshot("t1", "campaign", { campaign_id: "c", date_start: "2026-10-01", spend: "1", quality_ranking: "AVERAGE" }, 2)?.qualityRanking).toBeNull();
  });
});

describe("upsert idempotency", () => {
  it("writing the same window twice keeps one row per key and overwrites values", async () => {
    const row = { campaign_id: "c1", date_start: "2026-10-01", spend: "10.00", impressions: "100", clicks: "5" };
    const first = toSnapshot("t1", "campaign", row, 2)!;
    await upsertSnapshots([first]);
    await upsertSnapshots([toSnapshot("t1", "campaign", { ...row, spend: "11.50" }, 2)!]);
    expect(db.snaps).toHaveLength(1);
    expect(db.snaps[0].spendMinor).toBe(1150);
    await upsertSnapshots([toSnapshot("t2", "campaign", row, 2)!]);
    expect(db.snaps).toHaveLength(2);
  });
});

describe("pagination caps", () => {
  it("follows cursors until there is no next page", async () => {
    graph.fetchAs
      .mockResolvedValueOnce({ data: [{ campaign_id: "a" }], paging: { cursors: { after: "X" }, next: "https://next" } })
      .mockResolvedValueOnce({ data: [{ campaign_id: "b" }] });
    const res = await fetchLevel("tok", "123", "campaign", "2026-10-01", "2026-10-03");
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(false);
    expect(graph.fetchAs.mock.calls[1][1].query.after).toBe("X");
    expect(graph.fetchAs.mock.calls[0][1].path).toBe("act_123/insights");
    expect(JSON.parse(graph.fetchAs.mock.calls[0][1].query.time_range)).toEqual({ since: "2026-10-01", until: "2026-10-03" });
  });
  it("stops at the page cap even when Meta keeps returning cursors", async () => {
    graph.fetchAs.mockResolvedValue({ data: [{ campaign_id: "a" }], paging: { cursors: { after: "X" }, next: "https://next" } });
    const res = await fetchLevel("tok", "act_123", "campaign", "2026-10-01", "2026-10-03");
    expect(graph.fetchAs).toHaveBeenCalledTimes(MAX_PAGES);
    expect(res.truncated).toBe(true);
    expect(graph.fetchAs.mock.calls[0][1].path).toBe("act_123/insights");
  });
  it("turns rate limit errors into a distinct error", async () => {
    graph.fetchAs.mockRejectedValue(new GraphError("limit", 400, 80004));
    await expect(fetchLevel("tok", "1", "ad", "2026-10-01", "2026-10-01")).rejects.toThrow("rate limit");
    expect(isRateLimit(new GraphError("x", 429))).toBe(true);
    expect(isRateLimit(new GraphError("x", 400, 190))).toBe(false);
  });
});

describe("sync", () => {
  const NOW = new Date("2026-10-27T10:00:00Z");
  const setup = () => {
    db.connections.push({ tenantId: "t1", status: "active" });
    connect.listAssets.mockResolvedValue([{ id: "as1", type: "ad_account", externalId: "999", name: "A", status: "active", meta: { currency: "INR" } }]);
    connect.getAssetAccess.mockResolvedValue({ assetId: "as1", type: "ad_account", externalId: "999", name: "A", token: "secret-token" });
  };

  it("backfills 30 days first, then refreshes 3 days", () => {
    expect(syncWindow(false, NOW)).toEqual({ since: "2026-09-28", until: "2026-10-27" });
    expect(syncWindow(true, NOW)).toEqual({ since: "2026-10-25", until: "2026-10-27" });
  });

  it("syncs three levels, stores rows, and is idempotent across runs", async () => {
    setup();
    graph.fetchAs.mockImplementation(async (_t: string, req: { query: { level: string } }) => {
      const level = req.query.level;
      const key = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
      return { data: [{ [key]: `${level}1`, date_start: "2026-10-26", spend: "5.25", impressions: "10", clicks: "1", objective: "OUTCOME_LEADS", actions: [{ action_type: "lead", value: "1" }] }] };
    });
    const r1 = await syncTenant("t1", NOW);
    expect(r1).toMatchObject({ accounts: 1, rows: 3, rateLimited: false });
    expect(db.snaps).toHaveLength(3);
    expect(graph.fetchAs.mock.calls[0][1].query.time_range).toContain("2026-09-28");
    await syncTenant("t1", NOW);
    expect(db.snaps).toHaveLength(3);
    expect(graph.fetchAs.mock.calls[3][1].query.time_range).toContain("2026-10-25");
    expect(JSON.stringify([...db.settings.values()])).not.toContain("secret-token");
  });

  it("backs off on rate limit and resumes on a later run", async () => {
    setup();
    graph.fetchAs.mockRejectedValueOnce(new GraphError("limit", 400, 17));
    const r1 = await syncTenant("t1", NOW);
    expect(r1.rateLimited).toBe(true);
    expect(db.snaps).toHaveLength(0);
    graph.fetchAs.mockClear();
    const r2 = await syncTenant("t1", new Date(NOW.getTime() + 10 * 60_000));
    expect(r2.rateLimited).toBe(true);
    expect(graph.fetchAs).not.toHaveBeenCalled();
    graph.fetchAs.mockResolvedValue({ data: [] });
    const r3 = await syncTenant("t1", new Date(NOW.getTime() + 31 * 60_000));
    expect(r3.rateLimited).toBe(false);
    expect(graph.fetchAs.mock.calls[0][1].query.time_range).toContain("2026-09-28");
  });

  it("records other errors without leaking details and keeps going", async () => {
    setup();
    graph.fetchAs.mockRejectedValue(new GraphError("Invalid OAuth access token", 400, 190));
    const r = await syncTenant("t1", NOW);
    expect(r.errors).toHaveLength(1);
    expect(r.accounts).toBe(0);
  });

  it("enforces the 15 minute manual cooldown and requires a connection", async () => {
    await expect(requestManualSync("t1", NOW)).rejects.toMatchObject({ status: 409 });
    db.connections.push({ tenantId: "t1", status: "active" });
    const ok = await requestManualSync("t1", NOW);
    expect(ok.nextAllowedAt.getTime()).toBe(NOW.getTime() + MANUAL_COOLDOWN_MS);
    expect(db.jobs).toHaveLength(1);
    await expect(requestManualSync("t1", new Date(NOW.getTime() + 5 * 60_000))).rejects.toBeInstanceOf(HttpError);
    await expect(requestManualSync("t1", new Date(NOW.getTime() + 5 * 60_000))).rejects.toMatchObject({ status: 429 });
    await requestManualSync("t1", new Date(NOW.getTime() + 16 * 60_000));
    expect(db.jobs).toHaveLength(2);
  });

  it("also SETs SpendDaily for older days of Edwyz's own ad sets (origin platform), never today or yesterday, never outside campaigns", async () => {
    setup();
    connect.listAssets.mockResolvedValue([{ id: "as1", type: "ad_account", externalId: "999", name: "A", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" } }]);
    db.campaigns.push({ id: "c1", tenantId: "t1", metaCampaignId: "mc1", name: "Diwali", status: "active", currency: "INR", dailyBudgetMinor: 100_000 });
    const adsetRows = [
      { adset_id: "s1", campaign_id: "mc1", date_start: "2026-10-24", spend: "5.25", impressions: "10", clicks: "1" },
      { adset_id: "s1", campaign_id: "mc1", date_start: "2026-10-26", spend: "9.00" },
      { adset_id: "s1", campaign_id: "mc1", date_start: "2026-10-27", spend: "3.00" },
      { adset_id: "sx", campaign_id: "outside", date_start: "2026-10-24", spend: "7.00" },
    ];
    graph.fetchAs.mockImplementation(async (_t: string, req: { query: { level: string } }) => ({ data: req.query.level === "adset" ? adsetRows : [] }));
    await syncTenant("t1", NOW);
    expect(db.daily).toEqual([expect.objectContaining({ tenantId: "t1", pot: "ads", scopeType: "adset", scopeId: "s1", origin: "platform", amountMinor: 525n, currency: "INR", source: "insights", impressions: 10n, clicks: 1n })]);
    expect((db.daily[0].day as Date).toISOString().slice(0, 10)).toBe("2026-10-24");
    // Revised by Meta: the next run SETs the new figure, it never adds.
    adsetRows[0].spend = "6.00";
    await syncTenant("t1", NOW);
    expect(db.daily).toHaveLength(1);
    expect(db.daily[0].amountMinor).toBe(600n);
  });

  it("a campaign-budget campaign is stored at campaign level, so its ad sets are never counted twice", async () => {
    setup();
    db.campaigns.push({ id: "c1", tenantId: "t1", metaCampaignId: "mc1", name: "Diwali", status: "active", currency: "INR", dailyBudgetMinor: 100_000 });
    db.commitments.push({ tenantId: "t1", adAccountAssetId: "as1", objectLevel: "campaign", metaObjectId: "mc1" });
    graph.fetchAs.mockImplementation(async (_t: string, req: { query: { level: string } }) => ({
      data: req.query.level === "adset" ? [{ adset_id: "s1", campaign_id: "mc1", date_start: "2026-10-20", spend: "1.00" }, { adset_id: "s2", campaign_id: "mc1", date_start: "2026-10-20", spend: "2.50" }] : [],
    }));
    await syncTenant("t1", NOW);
    expect(db.daily).toEqual([expect.objectContaining({ scopeType: "campaign", scopeId: "mc1", amountMinor: 350n })]);
  });

  it("keeps the exact amount for the spend controls and logs insights.clamped when the 32-bit snapshot clamps", async () => {
    const lines: string[] = [];
    setLogSink((_level, line) => void lines.push(line));
    try {
      expect(exactSpendMinor({ spend: "99999999.99", date_start: "2026-10-20" }, 2, { level: "adset", id: "s1" })).toEqual({ minor: 9_999_999_999n, clamped: true });
      expect(lines.some((l) => l.includes('"msg":"insights.clamped"') && l.includes('"entity":"s1"'))).toBe(true);
      expect(exactSpendMinor({ spend: "12.34" }, 2)).toEqual({ minor: 1234n, clamped: false });
      expect(exactSpendMinor({ spend: "1e5" }, 2)).toBeNull();
      expect(decimalToMinor("99999999.99", 2)).toBe(2_147_483_647);
    } finally {
      setLogSink(null);
    }
  });

  it("the worker exposes the queue and a periodic task", () => {
    expect(Object.keys(worker.queues)).toEqual(["ads.insights.sync"]);
    expect(worker.periodic[0].everyMs).toBeGreaterThan(0);
  });
});

describe("queries on fixtures", () => {
  beforeEach(() => {
    db.snaps.push(
      snap({ entityType: "campaign", entityMetaId: "c1", date: "2026-10-01", spendMinor: 1000, impressions: 1000, clicks: 20, results: 2 }),
      snap({ entityType: "campaign", entityMetaId: "c1", date: "2026-10-02", spendMinor: 2000, impressions: 3000, clicks: 40, results: 3 }),
      snap({ entityType: "campaign", entityMetaId: "c1", date: "2026-09-30", spendMinor: 500, impressions: 500, clicks: 5, results: 1 }),
      snap({ tenantId: "t2", entityType: "campaign", entityMetaId: "c9", date: "2026-10-01", spendMinor: 99999, impressions: 99999, clicks: 999, results: 99 }),
      snap({ entityType: "ad", entityMetaId: "a-good", date: "2026-10-01", spendMinor: 1000, results: 5, frequency: 1.2 }),
      snap({ entityType: "ad", entityMetaId: "a-ok", date: "2026-10-01", spendMinor: 1000, results: 2, frequency: 2.1 }),
      snap({ entityType: "ad", entityMetaId: "a-none", date: "2026-10-01", spendMinor: 800, results: 0, frequency: 3.4 }),
      snap({ entityType: "ad", entityMetaId: "a-none", date: "2026-10-02", spendMinor: 200, results: 0, frequency: 3.6 }),
      snap({ entityType: "ad", entityMetaId: "a-q", date: "2026-10-02", spendMinor: 100, results: 1, frequency: 1.1, qualityRanking: "below_average_20" }),
      snap({ entityType: "ad", entityMetaId: "a-idle", date: "2026-10-02", spendMinor: 0, results: 0, frequency: 9 }),
      snap({ tenantId: "t2", entityType: "ad", entityMetaId: "a-other", date: "2026-10-01", spendMinor: 5000, results: 0, frequency: 8 }),
    );
    db.ads.push({ tenantId: "t1", metaAdId: "a-good", name: "Good ad" }, { tenantId: "t2", metaAdId: "a-other", name: "Other tenant ad" });
  });

  it("summarises a period against the previous one and ignores other tenants", async () => {
    const { current, previous } = await summaryByPeriod("t1", "2026-10-01", "2026-10-02");
    expect(current).toEqual({ spendMinor: 3000, impressions: 4000, clicks: 60, results: 5, ctr: 1.5, costPerResultMinor: 600 });
    expect(previous.spendMinor).toBe(500);
    expect(previous.costPerResultMinor).toBe(500);
    const other = await summaryByPeriod("t3", "2026-10-01", "2026-10-02");
    expect(other.current).toMatchObject({ spendMinor: 0, ctr: null, costPerResultMinor: null });
  });

  it("builds a zero filled daily series", async () => {
    const days = await dailySeries("t1", "2026-09-30", "2026-10-04");
    expect(days.map((d) => d.day)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(days.map((d) => d.spendMinor)).toEqual([500, 1000, 2000, 0, 0]);
  });

  it("ranks top and bottom ads by cost per result", async () => {
    const { top, bottom } = await topAndBottomAds("t1", "2026-10-01", "2026-10-02", 2);
    expect(top[0].entityMetaId).toBe("a-q");
    expect(top[0].costPerResultMinor).toBe(100);
    expect(top[1]).toMatchObject({ entityMetaId: "a-good", name: "Good ad", costPerResultMinor: 200 });
    expect(bottom[0]).toMatchObject({ entityMetaId: "a-none", spendMinor: 1000, costPerResultMinor: null });
    expect(bottom[1].entityMetaId).toBe("a-ok");
    expect([...top, ...bottom].some((r) => r.entityMetaId === "a-idle" || r.entityMetaId === "a-other")).toBe(false);
  });

  it("lists fatigue candidates by latest frequency and low quality, scoped to the tenant", async () => {
    const list = await fatigueCandidates("t1", "2026-10-01", "2026-10-02");
    expect(list.map((f) => f.entityMetaId)).toEqual(["a-none", "a-q"]);
    expect(list[0]).toMatchObject({ frequency: 3.6, reasons: ["frequency"] });
    expect(list[1]).toMatchObject({ reasons: ["quality"] });
  });

  it("breaks down by level with names and tenant isolation", async () => {
    const rows = await breakdownByLevel("t1", "ad", "2026-10-01", "2026-10-02");
    expect(rows.find((r) => r.entityMetaId === "a-good")?.name).toBe("Good ad");
    expect(rows.find((r) => r.entityMetaId === "a-other")).toBeUndefined();
    expect(rows[0].spendMinor).toBeGreaterThanOrEqual(rows[1].spendMinor);
  });

  it("computes spend pacing for active campaigns only", async () => {
    db.campaigns.push(
      { id: "k1", tenantId: "t1", metaCampaignId: "c1", name: "Leads", status: "active", currency: "INR", dailyBudgetMinor: 1000 },
      { id: "k2", tenantId: "t1", metaCampaignId: "c2", name: "Paused", status: "paused", currency: "INR", dailyBudgetMinor: 1000 },
      { id: "k3", tenantId: "t2", metaCampaignId: "c9", name: "Other", status: "active", currency: "USD", dailyBudgetMinor: 1000 },
    );
    const p = await spendPacing("t1", "2026-10-02");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: "Leads", avgDailySpendMinor: 1167, pacingPct: 117, state: "over" });
  });

  it("reports a single or mixed tenant currency", async () => {
    db.campaigns.push({ id: "k1", tenantId: "t1", metaCampaignId: "c1", name: "A", status: "active", currency: "inr", dailyBudgetMinor: 1 });
    expect(await tenantCurrency("t1")).toEqual({ currency: "INR", mixed: false });
    db.assets.push({ tenantId: "t1", type: "ad_account", status: "active", meta: { currency: "USD" } });
    expect(await tenantCurrency("t1")).toEqual({ currency: null, mixed: true });
    expect(await tenantCurrency("t5")).toEqual({ currency: null, mixed: false });
  });
});

describe("names, ad accounts and currencies (campaigns made in Ads Manager, mixed currencies)", () => {
  it("asks Meta for names, the ad account and its currency, and keeps them in raw", async () => {
    expect(BASE_FIELDS).toEqual(expect.arrayContaining(["account_id", "account_currency"]));
    expect(LEVEL_FIELDS.campaign).toContain("campaign_name");
    expect(LEVEL_FIELDS.adset).toEqual(expect.arrayContaining(["adset_name", "campaign_name"]));
    expect(LEVEL_FIELDS.ad).toEqual(expect.arrayContaining(["ad_name", "adset_name", "campaign_name"]));
    graph.fetchAs.mockResolvedValueOnce({ data: [] });
    await fetchLevel("tok", "1", "ad", "2026-10-01", "2026-10-01");
    expect(graph.fetchAs.mock.calls[0][1].query.fields.split(",")).toEqual(expect.arrayContaining(["ad_name", "account_id", "account_currency"]));
    const snap = toSnapshot("t1", "ad", { ad_id: "a1", ad_name: " Summer A ", campaign_id: "c1", campaign_name: "Summer", account_id: "act_77", account_currency: "usd", date_start: "2026-10-01", spend: "1" }, 2)!;
    expect(snap.raw).toMatchObject({ name: "Summer A", campaignName: "Summer", campaignId: "c1", accountId: "77", currency: "USD" });
    expect(toSnapshot("t1", "campaign", { campaign_id: "c1", date_start: "2026-10-01", spend: "1", account_currency: "rupees" }, 2)!.raw).toMatchObject({ name: null, accountId: null, currency: null });
  });

  it("shows Meta's name for a campaign made in Ads Manager, and Edwyz's own name first", async () => {
    db.snaps.push(
      snap({ entityType: "campaign", entityMetaId: "ext1", date: "2026-10-01", spendMinor: 500, raw: { name: "Old name" } }),
      snap({ entityType: "campaign", entityMetaId: "ext1", date: "2026-10-02", spendMinor: 500, raw: { name: "Spring sale" } }),
      snap({ entityType: "campaign", entityMetaId: "own1", date: "2026-10-01", spendMinor: 100, raw: { name: "Meta name" } }),
      snap({ entityType: "campaign", entityMetaId: "bare", date: "2026-10-01", spendMinor: 50 }),
    );
    db.campaigns.push({ id: "k1", tenantId: "t1", metaCampaignId: "own1", name: "Edwyz name", status: "active", currency: "INR", dailyBudgetMinor: 1 });
    const rows = await breakdownByLevel("t1", "campaign", "2026-10-01", "2026-10-02");
    expect(rows.map((r) => [r.entityMetaId, r.name])).toEqual([["ext1", "Spring sale"], ["own1", "Edwyz name"], ["bare", "bare"]]);
  });

  const twoAccounts = () => {
    db.assets.push(
      { tenantId: "t1", type: "ad_account", status: "active", id: "accIN", externalId: "act_100", name: "India", meta: { currency: "INR" } },
      { tenantId: "t1", type: "ad_account", status: "active", id: "accUS", externalId: "200", name: "US", meta: { currency: "USD" } },
    );
    db.campaigns.push({ id: "k1", tenantId: "t1", metaCampaignId: "old1", name: "Legacy", status: "paused", currency: "INR", dailyBudgetMinor: 1000, adAccountAssetId: "accIN" });
    db.snaps.push(
      snap({ entityType: "campaign", entityMetaId: "in1", date: "2026-10-01", spendMinor: 1000, results: 2, raw: { accountId: "100", currency: "INR" } }),
      // Stored before the sync kept the account: matched through Edwyz's own campaign of that account.
      snap({ entityType: "campaign", entityMetaId: "old1", date: "2026-10-02", spendMinor: 300, results: 1, raw: {} }),
      snap({ entityType: "campaign", entityMetaId: "us1", date: "2026-10-01", spendMinor: 700, results: 7, raw: { accountId: "200", currency: "USD" } }),
      snap({ entityType: "ad", entityMetaId: "adUS", date: "2026-10-01", spendMinor: 700, results: 7, raw: { accountId: "200", campaignId: "us1", name: "US ad" } }),
      snap({ entityType: "ad", entityMetaId: "adIN", date: "2026-10-01", spendMinor: 900, results: 3, raw: { campaignId: "old1" } }),
    );
  };

  it("filters every query by ad account, matching old snapshots through Edwyz's campaigns", async () => {
    twoAccounts();
    const india = await accountScope("t1", "accIN");
    expect(india).toMatchObject({ assetId: "accIN", externalId: "100", currency: "INR" });
    expect((await summaryByPeriod("t1", "2026-10-01", "2026-10-02", india)).current).toMatchObject({ spendMinor: 1300, results: 3 });
    const us = await accountScope("t1", "accUS");
    expect((await summaryByPeriod("t1", "2026-10-01", "2026-10-02", us)).current).toMatchObject({ spendMinor: 700, results: 7 });
    expect((await dailySeries("t1", "2026-10-01", "2026-10-02", india)).map((d) => d.spendMinor)).toEqual([1000, 300]);
    const ads = await breakdownByLevel("t1", "ad", "2026-10-01", "2026-10-02", 100, india);
    expect(ads.map((r) => [r.entityMetaId, r.currency])).toEqual([["adIN", "INR"]]);
    expect((await topAndBottomAds("t1", "2026-10-01", "2026-10-02", 5, us)).top.map((r) => r.name)).toEqual(["US ad"]);
    await expect(accountScope("t1", "nope")).rejects.toMatchObject({ status: 404 });
    await expect(accountScope("t2", "accIN")).rejects.toMatchObject({ status: 404 });
  });

  it("totals each currency on its own, and every ad row carries its currency", async () => {
    twoAccounts();
    const split = await summaryByCurrency("t1", "2026-10-01", "2026-10-02");
    expect(split.map((g) => [g.currency, g.current.spendMinor, g.current.results])).toEqual([
      ["INR", 1300, 3],
      ["USD", 700, 7],
    ]);
    const ads = await breakdownByLevel("t1", "ad", "2026-10-01", "2026-10-02");
    expect(Object.fromEntries(ads.map((r) => [r.entityMetaId, r.currency]))).toEqual({ adIN: "INR", adUS: "USD" });
    expect(await insightAccounts("t1")).toEqual([
      { id: "accIN", name: "India", currency: "INR" },
      { id: "accUS", name: "US", currency: "USD" },
    ]);
  });

  it("pacing rows carry their currency and follow the account filter", async () => {
    twoAccounts();
    db.campaigns.push({ id: "k2", tenantId: "t1", metaCampaignId: "us1", name: "US live", status: "active", currency: "usd", dailyBudgetMinor: 1000, adAccountAssetId: "accUS" });
    expect((await spendPacing("t1", "2026-10-02")).map((r) => [r.name, r.currency])).toEqual([["US live", "USD"]]);
    expect(await spendPacing("t1", "2026-10-02", await accountScope("t1", "accIN"))).toEqual([]);
  });

  it("the summary route filters by ?adAccount= and splits mixed currencies when it is not given", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: "admin" }) }));
    const { GET } = await import("@/app/api/ads/insights/summary/route");
    twoAccounts();
    db.connections.push({ tenantId: "t1", status: "active" });
    const all = await (await GET(new Request("https://wa.edwyz.com/api/ads/insights/summary?from=2026-10-01&to=2026-10-02"))).json();
    expect(all).toMatchObject({ mixed: true, currency: null, adAccount: null });
    expect(all.byCurrency.map((g: { currency: string }) => g.currency)).toEqual(["INR", "USD"]);
    expect(all.accounts).toHaveLength(2);
    const one = await (await GET(new Request("https://wa.edwyz.com/api/ads/insights/summary?from=2026-10-01&to=2026-10-02&adAccount=accUS"))).json();
    expect(one).toMatchObject({ mixed: false, currency: "USD", adAccount: "accUS", byCurrency: null, current: { spendMinor: 700 } });
    expect((await GET(new Request("https://wa.edwyz.com/api/ads/insights/summary?from=2026-10-01&to=2026-10-02&adAccount=other"))).status).toBe(404);
    vi.doUnmock("@/lib/auth");
  });
});

describe("extra metrics, results per goal and the breakdown reads (docs/IG-PAGE-ADS-SPEC.md 4.2, 4.4, PRM-12)", () => {
  const VIDEO = (n: string) => [{ action_type: "video_view", value: n }];

  it("level reads ask Meta for reach, link clicks, ThruPlays and the video quartiles", async () => {
    expect(BASE_FIELDS).toEqual(expect.arrayContaining(["reach", "inline_link_clicks", ...VIDEO_FIELDS]));
    graph.fetchAs.mockResolvedValueOnce({ data: [] });
    await fetchLevel("tok", "1", "campaign", "2026-10-01", "2026-10-01");
    const fields = graph.fetchAs.mock.calls[0][1].query.fields.split(",");
    for (const f of ["reach", "inline_link_clicks", "video_thruplay_watched_actions", "video_p25_watched_actions", "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions"]) expect(fields).toContain(f);
  });

  it("level rows store reach, link clicks, ThruPlays, the quartiles and messaging starts", async () => {
    const row = {
      ad_id: "a1",
      date_start: "2026-10-01",
      spend: "10",
      impressions: "1000",
      clicks: "30",
      reach: "640",
      inline_link_clicks: "22",
      objective: "OUTCOME_ENGAGEMENT",
      actions: [{ action_type: CHAT_STARTED, value: "9" }, { action_type: "post_engagement", value: "50" }],
      video_thruplay_watched_actions: VIDEO("120"),
      video_p25_watched_actions: VIDEO("300"),
      video_p50_watched_actions: VIDEO("200"),
      video_p75_watched_actions: VIDEO("150"),
      video_p100_watched_actions: VIDEO("90"),
    };
    const s = toSnapshot("t1", "ad", row, 2)!;
    const metrics = { reach: 640, linkClicks: 22, thruplays: 120, videoP25: 300, videoP50: 200, videoP75: 150, videoP100: 90, messagingStarts: 9 };
    expect(s).toMatchObject({ ...metrics, results: 9 });
    await upsertSnapshots([s]);
    expect(db.snaps).toHaveLength(1);
    expect(db.snaps[0]).toMatchObject(metrics);
    // A day without video or chats counts zero; a row without reach keeps it null rather than guessing.
    expect(toSnapshot("t1", "campaign", { campaign_id: "c1", date_start: "2026-10-01", spend: "1" }, 2)).toMatchObject({
      reach: null,
      linkClicks: null,
      thruplays: 0,
      videoP25: 0,
      videoP100: 0,
      messagingStarts: 0,
    });
  });

  it("RESULT_ACTIONS covers every goal and picks the right result for each, as the goal catalog says", () => {
    const actions = [
      { action_type: CHAT_STARTED, value: "7" },
      { action_type: "lead", value: "5" },
      { action_type: "landing_page_view", value: "11" },
      { action_type: "link_click", value: "40" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" },
      { action_type: "post_engagement", value: "90" },
      { action_type: "like", value: "13" },
    ];
    const row = { actions, reach: "2500", video_thruplay_watched_actions: VIDEO("321") };
    const expected: Record<string, [number, string | null]> = {
      whatsapp_chats: [7, CHAT_STARTED],
      instagram_dms: [7, CHAT_STARTED],
      messenger_chats: [7, CHAT_STARTED],
      any_chat: [7, CHAT_STARTED],
      lead_form: [5, "lead"],
      website_visits: [11, "landing_page_view"],
      website_sales: [3, "offsite_conversion.fb_pixel_purchase"],
      engagement: [90, "post_engagement"],
      video_views: [321, "video_thruplay_watched_actions"],
      awareness: [2500, "reach"],
      page_likes: [13, "like"],
      // VERIFY V-P17: no action is counted until the runbook records Meta's profile-visit action.
      profile_visits: [0, null],
    };
    for (const goal of PROMOTE_GOAL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(RESULT_ACTIONS, goal), goal).toBe(true);
      expect(pickRowResults(goal, row), goal).toEqual({ results: expected[goal][0], actionType: expected[goal][1] });
      expect(RESULT_ACTIONS[goal][0] ?? null, goal).toBe(goalRow(goal).resultAction);
    }
    // Website visits without a pixel: landing page views stay zero and link clicks count.
    expect(pickRowResults("website_visits", { actions: [{ action_type: "link_click", value: "40" }] })).toEqual({ results: 40, actionType: "link_click" });
    // Old-wizard rows still count by objective; an unknown key never reads the object prototype.
    expect(pickRowResults("OUTCOME_LEADS", row).actionType).toBe("lead");
    expect(resultActionsFor("constructor")).toEqual(resultActionsFor(undefined));
    expect(pickResults("constructor", actions).actionType).toBe("lead");
    expect(leadCount([{ action_type: "onsite_conversion.lead_grouped", value: "4" }])).toBe(4);
    expect(sumActions([{ value: "2" }, { value: "x" }, { value: "3" }])).toBe(5);
  });

  const IDS = ["120200000000001", "120200000000002"];
  const DAYS = { since: "2026-10-02", until: "2026-10-31" };

  it("builds the R3, R3a, R4 and R5 reads: Edwyz's ids only, daily rows except the run total", () => {
    const r3 = breakdownQuery({ dimension: "placement", ...DAYS, campaignIds: IDS });
    expect(r3).toMatchObject({ level: "ad", time_increment: "1", breakdowns: "publisher_platform,platform_position" });
    expect(JSON.parse(r3.filtering)).toEqual([{ field: "campaign.id", operator: "IN", value: IDS }]);
    expect(JSON.parse(r3.time_range)).toEqual(DAYS);
    expect(r3.fields.split(",")).toEqual([...BREAKDOWN_FIELDS.ad]);
    expect(r3.fields.split(",")).toEqual(expect.arrayContaining(["ad_id", "adset_id", "campaign_id", "spend", "impressions", "reach", "clicks", "actions", "cost_per_action_type", ...VIDEO_FIELDS]));

    const r3a = breakdownQuery({ dimension: "run_total", since: "2026-10-20", until: "2026-10-31", campaignIds: IDS });
    expect(r3a.level).toBe("campaign");
    expect(r3a.time_increment).toBeUndefined();
    expect(r3a.breakdowns).toBeUndefined();
    expect(JSON.parse(r3a.time_range)).toEqual({ since: "2026-10-20", until: "2026-10-31" });
    expect(r3a.fields.split(",")).toEqual([...RUN_TOTAL_FIELDS]);
    expect(r3a.fields.split(",")).toEqual(expect.arrayContaining(["campaign_id", "reach", "frequency"]));

    for (const [dimension, breakdowns] of [
      ["asset_body", "body_asset"],
      ["asset_title", "title_asset"],
      ["asset_image", "image_asset"],
      ["asset_video", "video_asset"],
      ["asset_cta", "call_to_action_asset"],
    ] as const) {
      const q = breakdownQuery({ dimension, ...DAYS, adIds: ["120200000000101"] });
      expect(q, dimension).toMatchObject({ level: "ad", breakdowns, time_increment: "1" });
      expect(JSON.parse(q.filtering), dimension).toEqual([{ field: "ad.id", operator: "IN", value: ["120200000000101"] }]);
    }
    expect(breakdownQuery({ dimension: "age_gender", ...DAYS, campaignIds: IDS })).toMatchObject({ level: "campaign", breakdowns: "age,gender", time_increment: "1" });
    expect(breakdownQuery({ dimension: "region", ...DAYS, campaignIds: IDS })).toMatchObject({ level: "campaign", breakdowns: "region", time_increment: "1" });
    expect(breakdownQuery({ dimension: "region", ...DAYS, campaignIds: IDS }).fields.split(",")).not.toContain("ad_id");

    // Never an unfiltered read: no ids, too many, a non-numeric id, a bad range, or R4 without ad ids is refused before any call.
    expect(() => breakdownQuery({ dimension: "placement", ...DAYS, campaignIds: [] })).toThrow(RangeError);
    expect(() => breakdownQuery({ dimension: "placement", ...DAYS, campaignIds: Array.from({ length: BREAKDOWN_FILTER_MAX + 1 }, (_, i) => String(i + 1)) })).toThrow(RangeError);
    expect(() => breakdownQuery({ dimension: "placement", ...DAYS, campaignIds: ["1 OR 1"] })).toThrow(RangeError);
    expect(() => breakdownQuery({ dimension: "placement", since: "2026-10-31", until: "2026-10-01", campaignIds: IDS })).toThrow(RangeError);
    expect(() => breakdownQuery({ dimension: "asset_body", ...DAYS, campaignIds: IDS })).toThrow(RangeError);
  });

  it("reads a version's run total per ad set (R3a at ad set level): still filtered to the campaigns, no time_increment", () => {
    const q = breakdownQuery({ dimension: "run_total", since: "2026-10-20", until: "2026-10-31", campaignIds: IDS, level: "adset" });
    expect(q.level).toBe("adset");
    expect(q.time_increment).toBeUndefined();
    expect(q.breakdowns).toBeUndefined();
    expect(JSON.parse(q.filtering)).toEqual([{ field: "campaign.id", operator: "IN", value: IDS }]);
    expect(q.fields.split(",")).toEqual([...RUN_TOTAL_FIELDS, "adset_id"]);
    // Only the run total is read per ad set.
    expect(() => breakdownQuery({ dimension: "placement", ...DAYS, campaignIds: IDS, level: "adset" })).toThrow(RangeError);
    expect(() => breakdownQuery({ dimension: "run_total", ...DAYS, campaignIds: IDS, level: "campaign" as never })).toThrow(RangeError);
  });

  it("website visits count the action the ad set optimises for, never link clicks on a landing-page-views row", () => {
    const clicksOnly = { actions: [{ action_type: "link_click", value: "5" }] };
    const both = { actions: [{ action_type: "landing_page_view", value: "3" }, { action_type: "link_click", value: "9" }] };
    expect(resultActionsForOptimization("website_visits", "LANDING_PAGE_VIEWS")).toEqual(["landing_page_view"]);
    expect(resultActionsForOptimization("website_visits", "LINK_CLICKS")).toEqual(["link_click"]);
    // 0 landing page views and 5 link clicks in a landing-page-views campaign: 0 visits.
    expect(pickRowResults("website_visits", clicksOnly, resultActionsForOptimization("website_visits", "LANDING_PAGE_VIEWS"))).toEqual({ results: 0, actionType: null });
    expect(pickRowResults("website_visits", both, resultActionsForOptimization("website_visits", "LANDING_PAGE_VIEWS"))).toEqual({ results: 3, actionType: "landing_page_view" });
    expect(pickRowResults("website_visits", both, resultActionsForOptimization("website_visits", "LINK_CLICKS"))).toEqual({ results: 9, actionType: "link_click" });
    // Old-wizard traffic campaigns follow the same rule.
    expect(resultActionsForOptimization("OUTCOME_TRAFFIC", "LANDING_PAGE_VIEWS")).toEqual(["landing_page_view"]);
    // An unknown or deciding-nothing optimisation keeps the goal's list.
    expect(resultActionsForOptimization("website_visits", null)).toEqual(RESULT_ACTIONS.website_visits);
    expect(resultActionsForOptimization("website_visits", "constructor")).toEqual(RESULT_ACTIONS.website_visits);
    expect(resultActionsForOptimization("whatsapp_chats", "CONVERSATIONS")).toEqual([CHAT_STARTED]);
    expect(resultActionsForOptimization("lead_form", "LINK_CLICKS")).toEqual(RESULT_ACTIONS.lead_form);
  });

  it("breakdown reads are paced: the pace runs before each page and sees headers and Meta's rate limit; a held pace calls nothing", async () => {
    const order: string[] = [];
    const pace: InsightsPace = { before: vi.fn(async () => void order.push("before")), onHeaders: vi.fn(), onError: vi.fn(async () => void order.push("error")) };
    const req = { dimension: "placement" as const, since: "2026-10-30", until: "2026-10-31", campaignIds: ["123"] };
    graph.fetchAs.mockResolvedValueOnce({ data: [{ ad_id: "1" }], paging: { cursors: { after: "A" }, next: "https://next" } }).mockResolvedValueOnce({ data: [{ ad_id: "2" }] });
    expect(await fetchBreakdown("tok", "999", req, { pace })).toEqual({ rows: [{ ad_id: "1" }, { ad_id: "2" }], truncated: false });
    expect(pace.before).toHaveBeenCalledTimes(2);
    expect(graph.fetchAs.mock.calls[0][1].path).toBe("act_999/insights");
    expect(graph.fetchAs.mock.calls[1][1].query.after).toBe("A");
    expect(typeof graph.fetchAs.mock.calls[0][2].onHeaders).toBe("function");

    // A row cap cuts the read and says so.
    graph.fetchAs.mockResolvedValueOnce({ data: [{ ad_id: "1" }, { ad_id: "2" }, { ad_id: "3" }] });
    expect(await fetchBreakdown("tok", "999", req, { maxRows: 2 })).toEqual({ rows: [{ ad_id: "1" }, { ad_id: "2" }], truncated: true });

    graph.fetchAs.mockRejectedValueOnce(new GraphError("limit", 400, 17));
    await expect(fetchBreakdown("tok", "999", req, { pace })).rejects.toThrow("rate limit");
    expect(pace.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 17 }));
    expect(order.slice(-2)).toEqual(["before", "error"]);

    graph.fetchAs.mockClear();
    const held: InsightsPace = {
      before: async () => {
        throw new Error("Meta is busy right now.");
      },
    };
    await expect(fetchBreakdown("tok", "999", req, { pace: held })).rejects.toThrow("busy");
    expect(graph.fetchAs).not.toHaveBeenCalled();
  });
});
