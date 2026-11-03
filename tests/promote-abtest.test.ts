import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.8, D12, 4.8 and PRM-12 acceptance 3 and 4 (promote-abtest): the compare verdict needs at least 7
 * days, at least 15 results per version and a cost per result at least 20% lower ("Version B gets chats at ₹38 vs ₹55: likely
 * winner."), otherwise "Too early to tell." [Keep B, pause the others] pauses every other version through ads/actions.pauseAdSet
 * and the Spend Book's recordLowering, also while spending is stopped (reserveAds would refuse), marks the test decided with the
 * numbers, and returns the undo: an activate card. The winner route refuses other sites and agents.
 */
const h = vi.hoisted(() => ({
  test: null as Record<string, unknown> | null,
  breakdowns: [] as Record<string, unknown>[],
  snaps: [] as Record<string, unknown>[],
  adSetRows: [] as Record<string, unknown>[],
  testUpdates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  claimCount: 1,
  getActor: vi.fn(),
  recordLowering: vi.fn(),
  reserveAds: vi.fn(),
  settleAds: vi.fn(),
  setStatus: vi.fn(),
  audit: vi.fn(),
  auditLog: [] as { action: string; target: string | null }[],
}));

const inList = (v: unknown, c: unknown) => (c && typeof c === "object" && "in" in (c as object) ? ((c as { in: unknown[] }).in.includes(v)) : v === c);
vi.mock("@/lib/db", () => ({
  prisma: {
    adTest: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        h.test && h.test.tenantId === where.tenantId && (where.id === undefined || h.test.id === where.id) && (where.campaignId === undefined || h.test.campaignId === where.campaignId) ? h.test : null,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        h.testUpdates.push(args);
        return { count: h.testUpdates.length === 1 ? h.claimCount : 1 };
      },
    },
    insightBreakdown: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        h.breakdowns.filter((r) => r.tenantId === where.tenantId && (r.entityType ?? "ad") === where.entityType && inList(r.entityMetaId, where.entityMetaId) && r.dimension === where.dimension),
    },
    // ads/actions.resumeAdSet's strict audit rows.
    auditLog: { create: async ({ data }: { data: { action: string; target: string | null } }) => void h.auditLog.push(data) },
    insightSnapshot: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => h.snaps.filter((r) => r.tenantId === where.tenantId && r.entityType === where.entityType && inList(r.entityMetaId, where.entityMetaId)),
    },
    // ads/actions.pauseAdSet's own reads and writes.
    adSet: {
      findFirst: async ({ where }: { where: { tenantId: string; metaAdSetId: string } }) => h.adSetRows.find((s) => s.tenantId === where.tenantId && s.metaAdSetId === where.metaAdSetId) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = h.adSetRows.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    adCampaign: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === "k1" && where.tenantId === "t1" ? { id: "k1", tenantId: "t1", adAccountAssetId: "acc1", status: "active", dailyBudgetMinor: 90_000, currency: "INR", name: "Diwali chats" } : null,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/auth/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: async () => ({ assetId: "acc1", type: "ad_account", externalId: "999", name: "Main", token: "user-token" }) }));
vi.mock("@/lib/spend/sandbox", () => ({ sandboxFlagFor: async () => false }));
vi.mock("@/lib/ads/client", () => ({ adsClient: () => ({ setStatus: (...a: unknown[]) => h.setStatus(...a) }) }));
vi.mock("@/lib/spend/book", () => ({
  recordLowering: (...a: unknown[]) => h.recordLowering(...a),
  reserveAds: (...a: unknown[]) => h.reserveAds(...a),
  settleAds: (...a: unknown[]) => h.settleAds(...a),
  noteBudgetWriteError: vi.fn(),
}));

import { Prisma } from "@/generated/prisma/client";
import { SpendBlockedError } from "@/lib/spend/errors";
import { ABTEST_COPY, MIN_DAYS, MIN_MARGIN_PCT, MIN_RESULTS, daysRunning, getComparison, pickWinner, undoWinner, versionVerdict, type VersionStat } from "@/lib/promote/abtest";
import { PROMOTE_START_CLOSED } from "@/lib/promote/route-guard";

const NOW = new Date("2026-10-31T06:00:00.000Z");
const ORIGIN = "https://wa.edwyz.com";
const SETS = { A: "120200000000201", B: "120200000000202", C: "120200000000203" } as const;
const ADS = { A: "120200000000101", B: "120200000000102", C: "120200000000103" } as const;
const ADMIN = { userId: "u1", tenantId: "t1", role: "admin" as const };

const v = (key: string, spendMinor: number, results: number): VersionStat => ({ adSetId: `set-${key.toLowerCase()}`, key, spendMinor: BigInt(spendMinor), results });
const verdict = (days: number, versions: VersionStat[]) => versionVerdict({ days, versions, currency: "INR", resultKey: "whatsapp_chats" });

const testRow = (o: Record<string, unknown> = {}, statuses: Partial<Record<"A" | "B" | "C", string>> = {}) => ({
  id: "test1",
  tenantId: "t1",
  campaignId: "k1",
  kind: "creative",
  mode: "fair_split",
  status: "running",
  minDays: 7,
  minResults: 15,
  winnerAdSetId: null,
  verdict: null,
  decidedAt: null,
  createdAt: new Date("2026-10-20T00:00:00.000Z"),
  campaign: {
    id: "k1",
    name: "Diwali chats",
    goal: "whatsapp_chats",
    template: "click_to_whatsapp",
    objective: "OUTCOME_ENGAGEMENT",
    currency: "INR",
    status: "active",
    startsAt: new Date("2026-10-20T00:00:00.000Z"),
    launchedAt: new Date("2026-10-20T00:00:00.000Z"),
    endsAt: null,
    adSets: (["C", "A", "B"] as const).map((k) => ({ id: `set-${k.toLowerCase()}`, name: `Version ${k}`, metaAdSetId: SETS[k], variantKey: k, status: statuses[k] ?? "active", ads: [{ metaAdId: ADS[k] }] })),
  },
  ...o,
});

beforeEach(() => {
  h.test = testRow();
  // Version A: 20 chats for ₹1,100 (₹55 each); B: 20 for ₹760 (₹38); C: 20 for ₹1,300 (₹65).
  h.breakdowns = [
    { tenantId: "t1", entityMetaId: ADS.A, dimension: "placement", spendMinor: 60_000n, impressions: 1000, clicks: 10, results: 12 },
    { tenantId: "t1", entityMetaId: ADS.A, dimension: "placement", spendMinor: 50_000n, impressions: 1000, clicks: 10, results: 8 },
    { tenantId: "t1", entityMetaId: ADS.B, dimension: "placement", spendMinor: 76_000n, impressions: 1000, clicks: 10, results: 20 },
    { tenantId: "t1", entityMetaId: ADS.C, dimension: "placement", spendMinor: 130_000n, impressions: 1000, clicks: 10, results: 20 },
  ];
  h.snaps = [];
  h.adSetRows = (["A", "B", "C"] as const).map((k) => ({ id: `set-${k.toLowerCase()}`, tenantId: "t1", campaignId: "k1", metaAdSetId: SETS[k], name: `Version ${k}`, status: "active", dailyBudgetMinor: 30_000 }));
  h.testUpdates = [];
  h.claimCount = 1;
  h.auditLog = [];
  h.getActor.mockReset().mockResolvedValue(ADMIN);
  h.audit.mockReset();
  h.settleAds.mockReset().mockResolvedValue(undefined);
  h.setStatus.mockReset().mockResolvedValue(undefined);
  h.recordLowering.mockReset().mockImplementation(async (_t: string, _intent: unknown, _actor: unknown, _reason: string, run: (p: unknown) => Promise<void>) => {
    await run({ kind: "lowering_permit" });
    return { correlationId: "corr", bookkeeping: "done" };
  });
  // Spending is stopped for this workspace: every raise is refused. Lowerings never ask.
  h.reserveAds.mockReset().mockRejectedValue(new SpendBlockedError("spend.frozen"));
  process.env.PROMOTE_ENABLED = "on";
  process.env.SITE_URL = ORIGIN;
  delete process.env.SPEND_ENFORCE;
  delete process.env.SPEND_TRIPWIRE;
});

// =====================================================================================================================
// The verdict (3.8)
// =====================================================================================================================

describe("the compare verdict (3.8, D12)", () => {
  it("7 days, 15 results each and a cost at least 20% lower: likely winner", () => {
    expect([MIN_DAYS, MIN_RESULTS, MIN_MARGIN_PCT]).toEqual([7, 15, 20]);
    const r = verdict(7, [v("A", 82_500, 15), v("B", 57_000, 15)]);
    expect(r).toMatchObject({ state: "likely_winner", reasons: [], days: 7, winner: { key: "B", costPerResult: "₹38" }, runnerUp: { key: "A", costPerResult: "₹55" } });
    expect(r.text).toBe("Version B gets chats at ₹38 vs ₹55: likely winner.");
  });

  it("6 days, 14 results or 19% better each give 'Too early to tell'", () => {
    const sixDays = verdict(6, [v("A", 110_000, 20), v("B", 76_000, 20)]);
    expect(sixDays).toMatchObject({ state: "too_early", text: "Too early to tell.", reasons: ["days"], winner: null });
    expect(sixDays.hint).toBe("Each version needs at least 7 days and 15 chats before the results can be compared.");

    const fourteen = verdict(9, [v("A", 110_000, 20), v("B", 53_200, 14)]);
    expect(fourteen).toMatchObject({ state: "too_early", text: "Too early to tell.", reasons: ["results"] });

    // ₹81 against ₹100 is 19% cheaper: not enough.
    const nineteen = verdict(9, [v("A", 200_000, 20), v("B", 162_000, 20)]);
    expect(nineteen).toMatchObject({ state: "too_early", text: "Too early to tell.", reasons: ["margin"] });
    expect(nineteen.hint).toBe("No version is at least 20% cheaper per chat yet.");

    // ₹80 against ₹100 is exactly 20% cheaper: a likely winner.
    expect(verdict(7, [v("A", 200_000, 20), v("B", 160_000, 20)]).text).toBe("Version B gets chats at ₹80 vs ₹100: likely winner.");
  });

  it("compares the winner with the next cheapest version, exactly, and needs two versions", () => {
    const three = verdict(10, [v("A", 110_000, 20), v("B", 76_000, 20), v("C", 130_000, 20)]);
    expect(three.text).toBe("Version B gets chats at ₹38 vs ₹55: likely winner.");
    // 19.99% cheaper once rounded to whole rupees would look like 20%: the check is on the exact amounts.
    expect(verdict(9, [v("A", 100_000, 20), v("B", 80_010, 20)]).state).toBe("too_early");
    expect(verdict(30, [v("A", 50_000, 40)])).toMatchObject({ state: "too_early", reasons: ["results"] });
    // The noun follows the goal.
    expect(versionVerdict({ days: 8, versions: [v("A", 100_000, 20), v("B", 50_000, 20)], currency: "INR", resultKey: "lead_form" }).text).toBe("Version B gets leads at ₹25 vs ₹50: likely winner.");
  });

  it("counts whole days from the start, to the end when it ended earlier", () => {
    const start = new Date("2026-10-24T06:00:00.000Z");
    expect(daysRunning(start, new Date("2026-10-31T05:59:00.000Z"))).toBe(6);
    expect(daysRunning(start, new Date("2026-10-31T06:00:00.000Z"))).toBe(7);
    expect(daysRunning(start, NOW, new Date("2026-10-27T06:00:00.000Z"))).toBe(3);
    expect(daysRunning(null, NOW)).toBe(0);
  });
});

// =====================================================================================================================
// The comparison (GET /api/promote/tests/[id])
// =====================================================================================================================

describe("the comparison", () => {
  it("shows each version's numbers in A, B, C order with the verdict, from the placement rows", async () => {
    const c = await getComparison("t1", "test1", NOW);
    expect(c.versions.map((x) => x.text)).toEqual(["Version A: 20 chats, ₹55 each", "Version B: 20 chats, ₹38 each", "Version C: 20 chats, ₹65 each"]);
    expect(c).toMatchObject({ days: 11, resultNoun: "chats", canPickWinner: true, verdict: { state: "likely_winner", winner: { adSetId: "set-b" } } });
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    await expect(getComparison("t2", "test1", NOW)).rejects.toMatchObject({ status: 404, message: ABTEST_COPY.notFound });
  });

  it("falls back to the level sync's ad set rows before any breakdown row exists", async () => {
    h.breakdowns = [];
    h.snaps = [
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.A, spendMinor: 110_000, impressions: 1, clicks: 1, results: 20, messagingStarts: 20 },
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.B, spendMinor: 76_000, impressions: 1, clicks: 1, results: 20, messagingStarts: 20 },
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.C, spendMinor: 130_000, impressions: 1, clicks: 1, results: 20, messagingStarts: 20 },
    ];
    expect((await getComparison("t1", "test1", NOW)).verdict.text).toBe("Version B gets chats at ₹38 vs ₹55: likely winner.");
  });

  it("never compares a level-sync row's results that aren't the goal's: post engagements are not chats", async () => {
    h.breakdowns = [];
    // Old rows (no messagingStarts) counted by objective: version B's row counted post engagements, not chats.
    const snap = (set: string, spendMinor: number, results: number, resultAction: string) => ({ tenantId: "t1", entityType: "adset", entityMetaId: set, spendMinor, impressions: 1, clicks: 1, results, raw: { objective: "OUTCOME_ENGAGEMENT", resultAction } });
    const CHAT = "onsite_conversion.messaging_conversation_started_7d";
    h.snaps = [snap(SETS.A, 110_000, 20, CHAT), snap(SETS.B, 76_000, 400, "post_engagement"), snap(SETS.C, 130_000, 20, CHAT)];
    const c = await getComparison("t1", "test1", NOW);
    // Chats come first in the objective's list, so a row that counted post engagements had no chats: 0, never 400.
    expect(c.versions.find((v) => v.version === "B")).toMatchObject({ results: 0, counted: true, text: "Version B: no chats yet, ₹760 spent" });
    expect(c.verdict).toMatchObject({ state: "too_early", reasons: ["results"] });

    // A Page-likes campaign: likes are not in the objective's list at all, so the row can't say. Not counted, no verdict.
    h.test = testRow({ campaign: { ...testRow().campaign, goal: "page_likes", template: "page_likes" } });
    h.snaps = [snap(SETS.A, 110_000, 300, "post_engagement"), snap(SETS.B, 76_000, 300, "post_engagement"), snap(SETS.C, 130_000, 300, "post_engagement")];
    const likes = await getComparison("t1", "test1", NOW);
    expect(likes.versions.map((v) => v.text)).toEqual(["Version A: Page likes not counted yet, ₹1,100 spent", "Version B: Page likes not counted yet, ₹760 spent", "Version C: Page likes not counted yet, ₹1,300 spent"]);
    expect(likes.versions.every((v) => v.results === 0 && v.counted === false)).toBe(true);
    expect(likes.verdict).toMatchObject({ state: "too_early", winner: null });
    expect(likes.verdict.reasons).toContain("not_counted");
  });

  it("uses the placement rows day by day and the level sync's rows only on days without them", async () => {
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
    h.breakdowns = [
      { tenantId: "t1", entityMetaId: ADS.A, dimension: "placement", date: day("2026-10-30"), spendMinor: 30_000n, impressions: 1, clicks: 1, results: 6 },
      { tenantId: "t1", entityMetaId: ADS.B, dimension: "placement", date: day("2026-10-30"), spendMinor: 20_000n, impressions: 1, clicks: 1, results: 10 },
    ];
    h.snaps = [
      // 30 Oct is in the placement rows: never counted twice.
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.A, date: day("2026-10-30"), spendMinor: 30_000, impressions: 1, clicks: 1, results: 6, messagingStarts: 6 },
      // 29 Oct has no placement row yet: the level sync's row counts.
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.A, date: day("2026-10-29"), spendMinor: 40_000, impressions: 1, clicks: 1, results: 4, messagingStarts: 4 },
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.B, date: day("2026-10-29"), spendMinor: 10_000, impressions: 1, clicks: 1, results: 5, messagingStarts: 5 },
    ];
    const c = await getComparison("t1", "test1", NOW);
    expect(c.versions.find((v) => v.version === "A")).toMatchObject({ spendMinor: "70000", results: 10 });
    expect(c.versions.find((v) => v.version === "B")).toMatchObject({ spendMinor: "30000", results: 15 });
  });

  it("an awareness comparison counts each version's people reached from its own run total, never the sum of daily reach", async () => {
    h.test = testRow({ campaign: { ...testRow().campaign, goal: "awareness", template: "awareness", objective: "OUTCOME_AWARENESS" } });
    // The placement rows' daily reach adds up to far more people than were reached.
    h.breakdowns = [
      { tenantId: "t1", entityMetaId: ADS.A, dimension: "placement", spendMinor: 100_000n, impressions: 50_000, clicks: 1, results: 40_000 },
      { tenantId: "t1", entityMetaId: ADS.B, dimension: "placement", spendMinor: 100_000n, impressions: 50_000, clicks: 1, results: 40_000 },
      { tenantId: "t1", entityMetaId: ADS.C, dimension: "placement", spendMinor: 100_000n, impressions: 50_000, clicks: 1, results: 40_000 },
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.A, dimension: "run_total", spendMinor: 100_000n, impressions: 50_000, clicks: 1, reach: 10_000 },
      { tenantId: "t1", entityType: "adset", entityMetaId: SETS.B, dimension: "run_total", spendMinor: 100_000n, impressions: 50_000, clicks: 1, reach: 20_000 },
    ];
    const c = await getComparison("t1", "test1", NOW);
    expect(c.versions.map((v) => v.text)).toEqual(["Version A: 10,000 people reached, ₹0.10 each", "Version B: 20,000 people reached, ₹0.05 each", "Version C: people reached not counted yet, ₹1,000 spent"]);
    // Version C has no run total yet: no verdict on summed daily reach.
    expect(c.verdict).toMatchObject({ state: "too_early", reasons: ["not_counted"] });
    expect(c.verdict.hint).toBe("Each version's people reached aren't counted yet. Check again in a few hours.");

    h.breakdowns.push({ tenantId: "t1", entityType: "adset", entityMetaId: SETS.C, dimension: "run_total", spendMinor: 100_000n, impressions: 50_000, clicks: 1, reach: 12_000 });
    expect((await getComparison("t1", "test1", NOW)).verdict.text).toBe("Version B gets people reached at ₹0.05 vs ₹0.08: likely winner.");
  });
});

// =====================================================================================================================
// Keep the winner
// =====================================================================================================================

describe("pickWinner: [Keep B, pause the others]", () => {
  it("pauses every other version through recordLowering, also while spending is stopped, and returns the activate card as undo", async () => {
    const r = await pickWinner(ADMIN, "test1", "set-b", { now: NOW });
    // A lowering per other version: recordLowering with a pause intent at ad set level, and Meta's PAUSED inside its permit.
    expect(h.recordLowering).toHaveBeenCalledTimes(2);
    expect(h.recordLowering.mock.calls.map((c) => c[1])).toEqual([
      { kind: "pause", metaObjectId: SETS.A },
      { kind: "pause", metaObjectId: SETS.C },
    ]);
    for (const call of h.recordLowering.mock.calls) {
      expect(call[0]).toBe("t1");
      expect(call[2]).toEqual({ type: "user", userId: "u1", role: "admin" });
      expect(call[5]).toEqual({ objectLevel: "adset" });
    }
    expect(h.setStatus.mock.calls).toEqual([
      [SETS.A, "PAUSED", { kind: "lowering_permit" }],
      [SETS.C, "PAUSED", { kind: "lowering_permit" }],
    ]);
    // Spending was stopped (reserveAds refuses), and nothing asked it.
    expect(h.reserveAds).not.toHaveBeenCalled();
    expect(h.adSetRows.map((s) => [s.id, s.status])).toEqual([
      ["set-a", "paused"],
      ["set-b", "active"],
      ["set-c", "paused"],
    ]);

    // The test is claimed and decided with the numbers at decision time.
    expect(h.testUpdates).toHaveLength(1);
    expect(h.testUpdates[0].where).toEqual({ id: "test1", tenantId: "t1", status: "running", winnerAdSetId: null });
    expect(h.testUpdates[0].data).toMatchObject({
      status: "decided",
      winnerAdSetId: "set-b",
      decidedAt: NOW,
      decidedByUserId: "u1",
      verdict: { state: "likely_winner", kept: "B", keptVerdictWinner: true, days: 11, versions: expect.arrayContaining([{ key: "B", adSetId: "set-b", spendMinor: "76000", results: 20, costPerResultMinor: "3800" }]) },
    });

    expect(r).toMatchObject({
      test: { id: "test1", status: "decided", winnerAdSetId: "set-b" },
      winner: { adSetId: "set-b", key: "B" },
      paused: [
        { adSetId: "set-a", key: "A" },
        { adSetId: "set-c", key: "C" },
      ],
      message: "Kept version B. Paused versions A and C.",
      verdict: { text: "Version B gets chats at ₹38 vs ₹55: likely winner." },
    });
    expect(r.undo).toEqual({
      kind: "activate_card",
      action: "resume_versions",
      risk: "confirm",
      testId: "test1",
      campaignId: "k1",
      versions: [
        { adSetId: "set-a", metaAdSetId: SETS.A, key: "A", previousStatus: "active" },
        { adSetId: "set-c", metaAdSetId: SETS.C, key: "C", previousStatus: "active" },
      ],
      intents: [
        { kind: "resume_adset", adSetId: "set-a", metaAdSetId: SETS.A },
        { kind: "resume_adset", adSetId: "set-c", metaAdSetId: SETS.C },
      ],
      request: { method: "DELETE", path: "/api/promote/tests/test1/winner", body: { confirm: true } },
      title: "Turn versions A and C back on?",
      body: ABTEST_COPY.undoBody,
    });
    // The versions the undo turns back on are kept with the decision.
    expect(h.testUpdates[0].data.verdict).toMatchObject({ resume: ["set-a", "set-c"] });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "promote.test.winner_kept", target: "test1", meta: { version: "B", paused: 2, verdict: "likely_winner" } }));
  });

  it("a version already paused is left alone and is not in the undo; keeping against the verdict is recorded as such", async () => {
    h.test = testRow({}, { C: "paused" });
    const r = await pickWinner(ADMIN, "test1", "set-a", { now: NOW });
    expect(h.recordLowering.mock.calls.map((c) => (c[1] as { metaObjectId: string }).metaObjectId)).toEqual([SETS.B]);
    expect(r.undo?.intents).toEqual([{ kind: "resume_adset", adSetId: "set-b", metaAdSetId: SETS.B }]);
    expect(r.undo?.title).toBe("Turn version B back on?");
    expect(h.testUpdates[0].data.verdict).toMatchObject({ kept: "A", keptVerdictWinner: false });
  });

  it("refuses what it can't do, before any pause", async () => {
    await expect(pickWinner({ ...ADMIN, role: "agent" }, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 403 });
    await expect(pickWinner(ADMIN, "test1", undefined, { now: NOW })).rejects.toMatchObject({ status: 400, message: ABTEST_COPY.chooseVersion });
    await expect(pickWinner(ADMIN, "test1", "set-x", { now: NOW })).rejects.toMatchObject({ status: 400, message: ABTEST_COPY.notAVersion });
    await expect(pickWinner(ADMIN, "nope", "set-b", { now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(pickWinner({ ...ADMIN, tenantId: "t2" }, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 404 });
    h.test = testRow({ status: "draft" });
    await expect(pickWinner(ADMIN, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.notRunning });
    h.test = testRow({ status: "decided", winnerAdSetId: "set-a" });
    await expect(pickWinner(ADMIN, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.decided });
    h.test = testRow({ mode: "meta_study" });
    await expect(pickWinner(ADMIN, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.metaStudy });
    expect(h.recordLowering).not.toHaveBeenCalled();
    expect(h.testUpdates).toHaveLength(0);
  });

  it("someone else kept a version first: nothing is paused", async () => {
    h.claimCount = 0;
    await expect(pickWinner(ADMIN, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.raced });
    expect(h.recordLowering).not.toHaveBeenCalled();
  });

  it("a pause Meta refuses reopens the test; the version already paused stays paused, and a retry pauses the rest", async () => {
    h.recordLowering.mockImplementation(async (_t: string, intent: { metaObjectId: string }, _a: unknown, _r: string, run: (p: unknown) => Promise<void>) => {
      if (intent.metaObjectId === SETS.C) throw new Error("Meta said no");
      await run({ kind: "lowering_permit" });
      return { correlationId: "corr", bookkeeping: "done" };
    });
    await expect(pickWinner(ADMIN, "test1", "set-b", { now: NOW })).rejects.toMatchObject({ status: 502 });
    expect(h.testUpdates).toHaveLength(2);
    expect(h.testUpdates[1]).toMatchObject({ where: { id: "test1", tenantId: "t1", status: "decided", winnerAdSetId: "set-b" }, data: { status: "running", winnerAdSetId: null, decidedAt: null } });
    expect(h.adSetRows.find((s) => s.id === "set-a")?.status).toBe("paused");
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "promote.test.winner_kept" }));
  });
});

// =====================================================================================================================
// The undo: the activate card
// =====================================================================================================================

describe("undoWinner: the undo card of [Keep B, pause the others]", () => {
  /** Keeps B, then makes the stored test look as it does after the decision (A and C paused). */
  const keepB = async () => {
    const r = await pickWinner(ADMIN, "test1", "set-b", { now: NOW });
    h.test = testRow({ ...h.testUpdates[0].data }, { A: "paused", C: "paused" });
    h.testUpdates = [];
    h.recordLowering.mockClear();
    h.setStatus.mockClear();
    return r;
  };

  it("turns the paused versions back on through reserveAds resume_adset and runs the test again", async () => {
    const kept = await keepB();
    expect(kept.undo?.request).toEqual({ method: "DELETE", path: "/api/promote/tests/test1/winner", body: { confirm: true } });
    // Spending is allowed again: each resume is reserved, then sent with its permit.
    h.reserveAds.mockImplementation(async (_t: string, intent: { metaAdSetId: string }) => ({ kind: "ads_permit", for: intent.metaAdSetId }));

    const r = await undoWinner(ADMIN, "test1", true);
    expect(h.reserveAds.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["t1", { kind: "resume_adset", adSetId: "set-a", metaAdSetId: SETS.A }, { type: "user", userId: "u1", role: "admin" }],
      ["t1", { kind: "resume_adset", adSetId: "set-c", metaAdSetId: SETS.C }, { type: "user", userId: "u1", role: "admin" }],
    ]);
    // The card's intents are exactly what was reserved.
    expect(h.reserveAds.mock.calls.map((c) => c[1])).toEqual(kept.undo?.intents);
    expect(h.setStatus.mock.calls).toEqual([
      [SETS.A, "ACTIVE", { kind: "ads_permit", for: SETS.A }],
      [SETS.C, "ACTIVE", { kind: "ads_permit", for: SETS.C }],
    ]);
    expect(h.settleAds.mock.calls.map((c) => c[1])).toEqual(["applied", "applied"]);
    expect(h.adSetRows.map((s) => [s.id, s.status])).toEqual([
      ["set-a", "active"],
      ["set-b", "active"],
      ["set-c", "active"],
    ]);
    expect(h.auditLog.map((a) => a.action)).toEqual(["ads.adset.resume_requested", "ads.adset.resumed", "ads.adset.resume_requested", "ads.adset.resumed"]);

    // The test runs again: no winner, no verdict, so [Keep B] is offered again.
    expect(h.testUpdates).toHaveLength(1);
    expect(h.testUpdates[0]).toEqual({
      where: { id: "test1", tenantId: "t1", status: "decided", winnerAdSetId: "set-b" },
      data: { status: "running", winnerAdSetId: null, verdict: Prisma.DbNull, decidedAt: null, decidedByUserId: null },
    });
    expect(r).toEqual({
      test: { id: "test1", status: "running", winnerAdSetId: null },
      resumed: [
        { adSetId: "set-a", key: "A" },
        { adSetId: "set-c", key: "C" },
      ],
      message: "Turned versions A and C back on. The comparison is running again.",
    });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "promote.test.winner_undone", target: "test1", meta: { version: "B", resumed: 2 } }));
    h.test = testRow({ ...h.testUpdates[0].data });
    expect((await getComparison("t1", "test1", NOW)).canPickWinner).toBe(true);
  });

  it("all or nothing: a refused resume pauses the versions already back on and keeps B kept, with the refusal's reason", async () => {
    await keepB();
    const decided = { ...(h.test as Record<string, unknown>) };
    h.reserveAds.mockImplementation(async (_t: string, intent: { metaAdSetId: string }) => {
      if (intent.metaAdSetId === SETS.C) throw new SpendBlockedError("spend.frozen");
      return { kind: "ads_permit", for: intent.metaAdSetId };
    });
    await expect(undoWinner(ADMIN, "test1", true)).rejects.toBeInstanceOf(SpendBlockedError);
    // A came back on, then was paused again (a lowering); C was never sent.
    expect(h.setStatus.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [SETS.A, "ACTIVE"],
      [SETS.A, "PAUSED"],
    ]);
    expect(h.recordLowering.mock.calls.map((c) => c[1])).toEqual([{ kind: "pause", metaObjectId: SETS.A }]);
    expect(h.adSetRows.map((s) => [s.id, s.status])).toEqual([
      ["set-a", "paused"],
      ["set-b", "active"],
      ["set-c", "paused"],
    ]);
    // The claim, then the decision put back as it was.
    expect(h.testUpdates).toHaveLength(2);
    expect(h.testUpdates[1]).toEqual({
      where: { id: "test1", tenantId: "t1", status: "running", winnerAdSetId: null },
      data: { status: "decided", winnerAdSetId: "set-b", verdict: decided.verdict, decidedAt: NOW, decidedByUserId: "u1" },
    });
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "promote.test.winner_undone" }));
  });

  it("refuses what it can't undo, before anything is reserved", async () => {
    h.reserveAds.mockResolvedValue({ kind: "ads_permit" });
    // Nothing kept yet.
    await expect(undoWinner(ADMIN, "test1", true)).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.nothingToUndo });
    await keepB();
    await expect(undoWinner({ ...ADMIN, role: "agent" }, "test1", true)).rejects.toMatchObject({ status: 403 });
    await expect(undoWinner(ADMIN, "test1", undefined)).rejects.toMatchObject({ status: 400, message: ABTEST_COPY.confirmUndo });
    await expect(undoWinner({ ...ADMIN, tenantId: "t2" }, "test1", true)).rejects.toMatchObject({ status: 404 });
    // A Promote campaign turns back on only while Start is open (SPEND_ENFORCE and SPEND_TRIPWIRE enforcing).
    h.test = { ...(h.test as Record<string, unknown>), campaign: { ...((h.test as Record<string, unknown>).campaign as object), surface: "promote" } };
    await expect(undoWinner(ADMIN, "test1", true)).rejects.toMatchObject({ status: 403, message: PROMOTE_START_CLOSED });
    expect(h.reserveAds).not.toHaveBeenCalled();
    expect(h.testUpdates).toHaveLength(0);
    // Someone else undid it first.
    h.test = { ...(h.test as Record<string, unknown>), campaign: { ...((h.test as Record<string, unknown>).campaign as object), surface: "wizard" } };
    h.claimCount = 0;
    await expect(undoWinner(ADMIN, "test1", true)).rejects.toMatchObject({ status: 409, message: ABTEST_COPY.undoRaced });
    expect(h.reserveAds).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
// Routes
// =====================================================================================================================

describe("POST /api/promote/tests/[id]/winner and GET /api/promote/tests/[id] (4.8)", () => {
  const ctx = { params: Promise.resolve({ id: "test1" }) };
  const post = (origin: string | null = ORIGIN, body: unknown = { adSetId: "set-b" }) =>
    new Request(`${ORIGIN}/api/promote/tests/test1/winner`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

  it("refuses requests from another site, or with no origin, and agents; admins keep the winner and get the undo", async () => {
    const { POST } = await import("@/app/api/promote/tests/[id]/winner/route");
    expect((await POST(post("https://evil.example"), ctx)).status).toBe(403);
    expect((await POST(post(null), ctx)).status).toBe(403);
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: "t1", role: "agent" });
    expect((await POST(post(), ctx)).status).toBe(403);
    expect(h.recordLowering).not.toHaveBeenCalled();

    const ok = await POST(post(), ctx);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { undo: { kind: string; intents: unknown[] }; message: string };
    expect(body.undo).toMatchObject({ kind: "activate_card", risk: "confirm" });
    expect(body.undo.intents).toHaveLength(2);
    expect(body.message).toBe("Kept version B. Paused versions A and C.");

    process.env.PROMOTE_ENABLED = "off";
    expect((await POST(post(), ctx)).status).toBe(404);
  });

  it("DELETE runs the undo card: same site, admins, only while Start is open, and it needs the confirmation", async () => {
    const { POST, DELETE } = await import("@/app/api/promote/tests/[id]/winner/route");
    expect((await POST(post(), ctx)).status).toBe(200);
    h.test = testRow({ ...h.testUpdates[0].data }, { A: "paused", C: "paused" });
    h.testUpdates = [];
    h.reserveAds.mockResolvedValue({ kind: "ads_permit" });
    const del = (origin: string | null = ORIGIN, body: unknown = { confirm: true }) =>
      new Request(`${ORIGIN}/api/promote/tests/test1/winner`, { method: "DELETE", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

    expect((await DELETE(del("https://evil.example"), ctx)).status).toBe(403);
    // Start is closed while the spend controls don't enforce: turning versions back on spends.
    const closed = await DELETE(del(), ctx);
    expect(closed.status).toBe(403);
    expect(((await closed.json()) as { error: string }).error).toBe(PROMOTE_START_CLOSED);
    process.env.SPEND_ENFORCE = "enforce";
    process.env.SPEND_TRIPWIRE = "enforce";
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: "t1", role: "agent" });
    expect((await DELETE(del(), ctx)).status).toBe(403);
    const unconfirmed = await DELETE(del(ORIGIN, {}), ctx);
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { error: string }).error).toBe(ABTEST_COPY.confirmUndo);
    expect(h.reserveAds).not.toHaveBeenCalled();

    const ok = await DELETE(del(), ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as { message: string }).message).toBe("Turned versions A and C back on. The comparison is running again.");
    expect(h.reserveAds.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(["resume_adset", "resume_adset"]);
  });

  it("answers bad bodies in plain words", async () => {
    const { POST } = await import("@/app/api/promote/tests/[id]/winner/route");
    const res = await POST(post(ORIGIN, { adSetId: 5 }), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(ABTEST_COPY.chooseVersion);
  });

  it("GET is admin only and answers the comparison", async () => {
    const { GET } = await import("@/app/api/promote/tests/[id]/route");
    const get = () => new Request(`${ORIGIN}/api/promote/tests/test1`);
    const ok = await GET(get(), ctx);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { comparison: { verdict: { text: string } } }).comparison.verdict.text).toBe("Version B gets chats at ₹38 vs ₹55: likely winner.");
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: "t1", role: "agent" });
    expect((await GET(get(), ctx)).status).toBe(403);
    expect((await GET(get(), { params: Promise.resolve({ id: "other" }) })).status).toBe(404);
  });
});
