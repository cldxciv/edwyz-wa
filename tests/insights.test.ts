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
  campaigns: [] as { id: string; tenantId: string; metaCampaignId: string | null; name: string; status: string; currency: string; dailyBudgetMinor: number }[],
  adSets: [] as { tenantId: string; metaAdSetId: string; name: string }[],
  ads: [] as { tenantId: string; metaAdId: string; name: string }[],
  assets: [] as { tenantId: string; type: string; status: string; meta: unknown }[],
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
import { breakdownByLevel, dailySeries, fatigueCandidates, spendPacing, summaryByPeriod, tenantCurrency, topAndBottomAds } from "@/lib/ads/insights-queries";
import { worker } from "@/lib/ads/insights-worker";

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
