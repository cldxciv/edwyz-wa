import { describe, expect, it } from "vitest";
import { simulateSpend, SIM_SCENARIOS, type SimAdSet } from "../scripts/spend-sim";
import { createFakeMeta, FakeMetaNetworkError } from "./helpers/fake-meta";

/**
 * Self-tests of the Meta test double and the spend simulator (docs/SPEND-CONTROLS-SPEC.md 10.3). Nothing here touches the
 * network: fake-meta answers in memory.
 */

const IST = (iso: string) => new Date(`${iso}+05:30`);
const errorOf = (r: { body: unknown }) => (r.body as { error?: { code?: number; error_subcode?: number; message?: string } }).error ?? {};

describe("fake-meta: budget changes", () => {
  it("allows 4 budget changes an hour per ad set and answers the 5th with 613 / 1487632", () => {
    const meta = createFakeMeta({ now: IST("2026-10-05T09:00:00") });
    const c = meta.addCampaign({ status: "ACTIVE" });
    const s = meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    for (let i = 1; i <= 4; i++) {
      meta.advance(60_000);
      expect(meta.request("POST", s.id, { daily_budget: String(100_000 + i * 1_000) }).status).toBe(200);
    }
    const fifth = meta.request("POST", s.id, { daily_budget: "200000" });
    expect(fifth.status).toBe(400);
    expect(errorOf(fifth)).toMatchObject({ code: 613, error_subcode: 1487632 });
    expect(meta.object(s.id).dailyBudgetMinor).toBe(104_000n);
    // A status change is not a budget change.
    expect(meta.request("POST", s.id, { status: "PAUSED" }).status).toBe(200);
    // An hour after the first change, one slot is free again.
    meta.advance(57 * 60_000);
    expect(meta.request("POST", s.id, { daily_budget: "150000" }).status).toBe(200);
    expect(meta.budgetChangesInLastHour(s.id)).toBe(4);
  });
});

describe("fake-meta: spending limit (spend_cap)", () => {
  it("reads in minor units and writes major units by default; cumulative semantics keep amount_spent", () => {
    const meta = createFakeMeta({ amountSpentMinor: 50_000n });
    expect(meta.request("POST", "act_1", { spend_cap: "20000.00" }).status).toBe(200);
    const read = meta.request("GET", "act_1", { fields: "spend_cap,amount_spent" }).body as Record<string, unknown>;
    expect(read).toMatchObject({ spend_cap: "2000000", amount_spent: "50000", currency: "INR", timezone_name: "Asia/Kolkata", is_prepay_account: false });
  });

  it("can read the written value as minor units (100x stricter)", () => {
    const meta = createFakeMeta({ writeUnit: "minor" });
    meta.request("POST", "act_1", { spend_cap: "20000.00" });
    expect(meta.account().spendCapMinor).toBe(20_000n);
    meta.setWriteUnit("major");
    meta.request("POST", "act_1", { spend_cap: "20000.00" });
    expect(meta.account().spendCapMinor).toBe(2_000_000n);
  });

  it("resets amount_spent on every write under resets_on_write", () => {
    const meta = createFakeMeta({ amountSpentMinor: 439_924n, semantics: "resets_on_write" });
    meta.request("POST", "act_1", { spend_cap: "10000.00" });
    expect(meta.account().amountSpentMinor).toBe(0n);
    meta.setSemantics("cumulative");
    meta.account().amountSpentMinor = 1_000n;
    meta.request("POST", "act_1", { spend_cap: "10000.00" });
    expect(meta.account().amountSpentMinor).toBe(1_000n);
  });

  it("enforces the floor rule with 'must be at least ₹X' (at least spent, or 1.1x spent)", () => {
    const meta = createFakeMeta({ amountSpentMinor: 123_456n });
    const low = meta.request("POST", "act_1", { spend_cap: "1000.00" });
    expect(low.status).toBe(400);
    expect(errorOf(low).message).toBe("The spending limit must be at least ₹1,234.56.");
    expect(meta.account().spendCapMinor).toBe(0n);
    meta.setFloorRule("spent_1_1x");
    // ceil(1.1 x 123456) = 135802
    expect(errorOf(meta.request("POST", "act_1", { spend_cap: "1300.00" })).message).toBe("The spending limit must be at least ₹1,358.02.");
    expect(meta.request("POST", "act_1", { spend_cap: "1358.02" }).status).toBe(200);
    meta.setFloorRule("none");
    expect(meta.request("POST", "act_1", { spend_cap: "1.00" }).status).toBe(200);
  });

  it("allows 10 changes a rolling day and answers the 11th with 17 / 1885172", () => {
    const meta = createFakeMeta();
    for (let i = 0; i < 10; i++) {
      meta.advance(60_000);
      expect(meta.request("POST", "act_1", { spend_cap: `${5000 + i}.00` }).status).toBe(200);
    }
    const eleventh = meta.request("POST", "act_1", { spend_cap: "9000.00" });
    expect(errorOf(eleventh)).toMatchObject({ code: 17, error_subcode: 1885172 });
    expect(meta.capChangesInLast24h()).toBe(10);
    // Removing the limit is a change too.
    expect(errorOf(meta.request("POST", "act_1", { spend_cap_action: "delete" })).code).toBe(17);
    meta.advance(24 * 3_600_000);
    expect(meta.request("POST", "act_1", { spend_cap_action: "delete" }).status).toBe(200);
    expect(meta.account().spendCapMinor).toBe(0n);
  });

  it("refuses prepaid accounts and reports permission errors 10, 200 and 294", () => {
    const meta = createFakeMeta({ prepaid: true });
    expect(meta.request("GET", "act_1").body).toMatchObject({ is_prepay_account: true });
    expect(meta.request("POST", "act_1", { spend_cap: "100.00" }).status).toBe(400);
    meta.setPrepaid(false);
    for (const code of [10, 200, 294] as const) {
      meta.setPermissionError(code, "cap");
      expect(errorOf(meta.request("POST", "act_1", { spend_cap: "100.00" })).code).toBe(code);
    }
    // A cap-only permission error leaves ads writes alone.
    const c = meta.addCampaign({ status: "PAUSED" });
    expect(meta.request("POST", c.id, { status: "ACTIVE" }).status).toBe(200);
    meta.setPermissionError(200, "all");
    expect(errorOf(meta.request("POST", c.id, { status: "PAUSED" })).code).toBe(200);
    meta.setPermissionError(null);
    expect(meta.request("POST", "act_1", { spend_cap: "100.00" }).status).toBe(200);
  });

  it("injects ambiguous 5xx and network failures that did or did not apply the write", () => {
    const meta = createFakeMeta();
    meta.failNext({ kind: "status", status: 500, apply: true, match: /^act_1$/ });
    expect(meta.request("POST", "act_1", { spend_cap: "700.00" }).status).toBe(500);
    expect(meta.account().spendCapMinor).toBe(70_000n);
    meta.failNext({ kind: "status", status: 503, apply: false });
    expect(meta.request("POST", "act_1", { spend_cap: "800.00" }).status).toBe(503);
    expect(meta.account().spendCapMinor).toBe(70_000n);
    meta.failNext({ kind: "network", apply: true });
    expect(() => meta.request("POST", "act_1", { spend_cap: "900.00" })).toThrow(FakeMetaNetworkError);
    expect(meta.account().spendCapMinor).toBe(90_000n);
    expect(meta.calls.map((c) => c.status)).toEqual([500, 503, 0]);
  });
});

describe("fake-meta: the adversary", () => {
  it("spends exactly Meta's worst case for October 2026 at ₹1,000 a day: ₹33,250 (4.5)", () => {
    const meta = createFakeMeta({ now: IST("2026-10-01T00:00:00") });
    const c = meta.addCampaign({ status: "ACTIVE" });
    const s = meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    const out = meta.runAdversary({ until: IST("2026-10-31T23:45:00"), stepMs: 60 * 60_000 });
    expect(out.total).toBe(3_325_000n);
    const byDay = meta.object(s.id).spentByDay;
    for (const v of byDay.values()) expect(v <= 175_000n).toBe(true);
    // Sunday 4 Oct to Saturday 10 Oct is one week: 7 x ₹1,000.
    const week = [...byDay.entries()].filter(([d]) => d >= "2026-10-04" && d <= "2026-10-10").reduce((a, [, v]) => a + v, 0n);
    expect(week).toBe(700_000n);
  });

  it("uses the day's highest budget after a mid-day raise, and a mid-day cut does not lower today's room", () => {
    const meta = createFakeMeta({ now: IST("2026-10-05T00:00:00") });
    const c = meta.addCampaign({ status: "ACTIVE" });
    const s = meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    expect(meta.spend(s.id, 10_000_000n)).toBe(175_000n);
    meta.advance(10 * 3_600_000);
    meta.request("POST", s.id, { daily_budget: "200000" });
    expect(meta.roomFor(s.id)).toBe(175_000n); // ceil175(2000) - 1750
    meta.request("POST", s.id, { daily_budget: "50000" });
    expect(meta.roomFor(s.id)).toBe(175_000n); // the peak stays at ₹2,000
    expect(meta.spend(s.id, 10_000_000n)).toBe(175_000n);
    expect(meta.roomFor(s.id)).toBe(0n);
  });

  it("stops at the account's spending limit and after end_time, and respects a lifetime budget", () => {
    const meta = createFakeMeta({ now: IST("2026-10-01T00:00:00"), spendCapMinor: 1_000_000n });
    const c = meta.addCampaign({ status: "ACTIVE" });
    meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    const out = meta.runAdversary({ until: IST("2026-10-20T00:00:00"), stepMs: 3 * 3_600_000 });
    expect(out.total).toBe(1_000_000n);
    expect(meta.account().amountSpentMinor).toBe(1_000_000n);

    const m2 = createFakeMeta({ now: IST("2026-10-01T00:00:00") });
    const c2 = m2.addCampaign({ status: "ACTIVE" });
    const ends = m2.addAdSet({ campaignId: c2.id, status: "ACTIVE", dailyBudgetMinor: 100_000n, endTime: IST("2026-10-03T00:00:00") });
    const life = m2.addAdSet({ campaignId: c2.id, status: "ACTIVE", lifetimeBudgetMinor: 300_000n });
    const out2 = m2.runAdversary({ until: IST("2026-10-10T00:00:00"), stepMs: 3_600_000 });
    expect(out2.byObject[ends.id]).toBe(350_000n); // two days at 1.75x
    expect(out2.byObject[life.id]).toBe(300_000n); // never past the lifetime budget
  });

  it("does not spend for paused objects or a paused campaign", () => {
    const meta = createFakeMeta({ now: IST("2026-10-01T00:00:00") });
    const c = meta.addCampaign({ status: "PAUSED" });
    const s = meta.addAdSet({ campaignId: c.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    expect(meta.spend(s.id, 1_000n)).toBe(0n);
    expect(meta.request("GET", s.id).body).toMatchObject({ status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", daily_budget: "100000" });
  });
});

describe("fake-meta: Graph shapes", () => {
  it("creates objects, answers insights in major units and works as fetch()", async () => {
    const meta = createFakeMeta({ now: IST("2026-10-05T08:00:00") });
    const created = meta.request("POST", "act_1/campaigns", { name: "Diwali", status: "PAUSED" }).body as { id: string };
    const set = meta.request("POST", "act_1/adsets", { campaign_id: created.id, daily_budget: "80000", status: "PAUSED" }).body as { id: string };
    expect(meta.request("POST", "act_1/adsets", { daily_budget: "1" }).status).toBe(400);
    meta.request("POST", created.id, { status: "ACTIVE" });
    meta.request("POST", set.id, { status: "ACTIVE" });
    meta.spend(set.id, 12_345n);
    const res = await meta.fetch(`https://graph.facebook.com/v23.0/act_1/insights?level=account&date_preset=today`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ spend: "123.45", date_stop: "2026-10-05" }] });
    const write = await meta.fetch(`https://graph.facebook.com/v23.0/${set.id}`, { method: "POST", body: JSON.stringify({ status: "PAUSED" }) });
    expect(write.status).toBe(200);
    expect(meta.object(set.id).status).toBe("PAUSED");
    await expect(meta.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(/graph\.facebook\.com/);
    const send = await meta.fetch("https://graph.facebook.com/v23.0/PN_1/messages", { method: "POST", body: JSON.stringify({ to: "919000000001" }) });
    expect(((await send.json()) as { messages: unknown[] }).messages).toHaveLength(1);
    expect(meta.sends).toHaveLength(1);
  });
});

describe("fake-meta: the reads the syncs make", () => {
  it("answers ad set and campaign level insights with id filtering, and yesterday", () => {
    const meta = createFakeMeta({ now: IST("2026-10-05T23:00:00") });
    const c1 = meta.addCampaign({ status: "ACTIVE" });
    const c2 = meta.addCampaign({ status: "ACTIVE" });
    const s1 = meta.addAdSet({ campaignId: c1.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    const s2 = meta.addAdSet({ campaignId: c2.id, status: "ACTIVE", dailyBudgetMinor: 100_000n });
    meta.spend(s1.id, 40_000n);
    meta.advance(2 * 3_600_000); // past midnight in Kolkata: 6 Oct
    meta.spend(s1.id, 10_000n);
    meta.spend(s2.id, 25_050n);
    const level = meta.request("GET", "act_1/insights", { level: "adset", date_preset: "today", filtering: JSON.stringify([{ field: "adset.id", operator: "IN", value: [s1.id] }]) });
    expect((level.body as { data: unknown[] }).data).toEqual([{ adset_id: s1.id, campaign_id: c1.id, date_start: "2026-10-06", date_stop: "2026-10-06", spend: "100.00" }]);
    const all = (meta.request("GET", "act_1/insights", { level: "adset", date_preset: "today" }).body as { data: { adset_id: string; spend: string }[] }).data;
    expect(all.map((r) => [r.adset_id, r.spend])).toEqual([
      [s1.id, "100.00"],
      [s2.id, "250.50"],
    ]);
    const campaigns = (meta.request("GET", "act_1/insights", { level: "campaign", date_preset: "today" }).body as { data: { campaign_id: string }[] }).data;
    expect(campaigns.map((r) => r.campaign_id)).toEqual([c1.id, c2.id]);
    // Yesterday (account time zone) and the month, day by day.
    expect((meta.request("GET", "act_1/insights", { date_preset: "yesterday" }).body as { data: unknown[] }).data).toEqual([{ date_start: "2026-10-05", date_stop: "2026-10-05", spend: "400.00" }]);
    const month = (meta.request("GET", "act_1/insights", { date_preset: "this_month", time_increment: "1" }).body as { data: { date_start: string; spend: string }[] }).data;
    expect(month.map((r) => [r.date_start, r.spend])).toEqual([
      ["2026-10-05", "400.00"],
      ["2026-10-06", "350.50"],
    ]);
  });

  it("filters the structure sync's campaign and ad set reads, and accepts form-encoded bodies", async () => {
    const meta = createFakeMeta();
    const c1 = meta.addCampaign({ status: "ACTIVE", dailyBudgetMinor: 50_000n });
    const c2 = meta.addCampaign({ status: "PAUSED" });
    const s2 = meta.addAdSet({ campaignId: c2.id, status: "PAUSED", dailyBudgetMinor: 70_000n });
    const camps = (meta.request("GET", "act_1/campaigns", { filtering: JSON.stringify([{ field: "id", operator: "IN", value: [c1.id] }]) }).body as { data: { id: string; daily_budget: string }[] }).data;
    expect(camps).toEqual([expect.objectContaining({ id: c1.id, daily_budget: "50000", effective_status: "ACTIVE" })]);
    const sets = (meta.request("GET", "act_1/adsets", { filtering: [{ field: "campaign.id", operator: "IN", value: [c2.id] }] }).body as { data: { id: string; campaign_id: string }[] }).data;
    expect(sets.map((s) => [s.id, s.campaign_id])).toEqual([[s2.id, c2.id]]);
    const res = await meta.fetch(`https://graph.facebook.com/v26.0/${s2.id}`, { method: "POST", body: new URLSearchParams({ daily_budget: "60000" }) });
    expect(res.status).toBe(200);
    expect(meta.object(s2.id).dailyBudgetMinor).toBe(60_000n);
    await meta.fetch(`https://graph.facebook.com/v26.0/${s2.id}`, { method: "POST", body: "status=ACTIVE" });
    expect(meta.object(s2.id).status).toBe("ACTIVE");
  });
});

describe("spend-sim series", () => {
  const sets: SimAdSet[] = [{ metaId: "s_1", dailyBudgetMinor: 200_000n }];
  const base = { tenantId: "t1", adAccountAssetId: "as_1", adSets: sets, currency: "INR", timezone: "Asia/Kolkata", days: 3, now: IST("2026-10-05T16:00:00"), seed: 7 };
  const today = (rows: ReturnType<typeof simulateSpend>["daily"], scope: "adset" | "account") => rows.find((r) => r.day === "2026-10-05" && r.scopeType === scope)!;

  it("writes history and today's rows for every scenario, deterministically", () => {
    for (const scenario of SIM_SCENARIOS) {
      const a = simulateSpend({ ...base, scenario });
      const b = simulateSpend({ ...base, scenario });
      expect(a).toEqual(b);
      // 3 history days + today, one ad set row and one account row each.
      expect(a.daily).toHaveLength(8);
      expect(a.daily.every((r) => r.source === "sim" && r.pot === "ads")).toBe(true);
      expect(a.daily.filter((r) => r.scopeType === "account").every((r) => r.origin === "all" && r.scopeId === "as_1")).toBe(true);
      // 16:00 local: 64 samples of 15 minutes, for the ad set and the account.
      expect(a.samples).toHaveLength(128);
      const set = a.samples.filter((s) => s.entityType === "adset").map((s) => s.spendMinor);
      expect(set.every((v, i) => i === 0 || v >= set[i - 1])).toBe(true);
    }
  });

  it("normal stays under the daily budget; runaway passes 120% and reaches 1.75x with a jump over 25% of the budget", () => {
    const normal = simulateSpend({ ...base, scenario: "normal" });
    expect(today(normal.daily, "adset").amountMinor <= 200_000n).toBe(true);
    const run = simulateSpend({ ...base, scenario: "runaway" });
    expect(today(run.daily, "adset").amountMinor).toBe(350_000n);
    const s = run.samples.filter((x) => x.entityType === "adset").map((x) => x.spendMinor);
    const maxJump = s.reduce((m, v, i) => (i && v - s[i - 1] > m ? v - s[i - 1] : m), 0n);
    expect(maxJump > 50_000n).toBe(true);
  });

  it("zero_lead has spend but no leads; cpm_spike has 1,500 impressions in the last hour at 3x CPM", () => {
    const zero = simulateSpend({ ...base, scenario: "zero_lead" });
    expect(zero.daily.every((r) => r.results === 0)).toBe(true);
    expect(zero.daily.reduce((a, r) => a + (r.scopeType === "adset" ? r.amountMinor : 0n), 0n) > 150_000n).toBe(true);
    const spike = simulateSpend({ ...base, scenario: "cpm_spike" });
    const ad = spike.samples.filter((x) => x.entityType === "adset");
    const hourAgo = ad[ad.length - 5];
    const last = ad[ad.length - 1];
    const imp = last.impressions - hourAgo.impressions;
    const spend = last.spendMinor - hourAgo.spendMinor;
    expect(imp).toBe(1_500n);
    expect((spend * 1000n) / imp).toBe(45_000n); // ₹450 CPM, 3 x ₹150
  });

  it("refuses an unknown scenario and an empty ad set list", () => {
    expect(() => simulateSpend({ ...base, scenario: "boom" as never })).toThrow(RangeError);
    expect(() => simulateSpend({ ...base, scenario: "normal", adSets: [] })).toThrow(RangeError);
  });
});
