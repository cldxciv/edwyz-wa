import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner decision 3 (2026-10-31): AI replies per hour by plan. Plan.features.aiRepliesPerHour wins; without it the plan's code or
 * name decides (Starter 60, Growth 200, Agency 600); a trial and a workspace with no plan get 60; AI_MAX_REPLIES_PER_HOUR is only
 * the fallback when no plan value can be found. One notice per hour when the cap holds a message back.
 */

const db = vi.hoisted(() => ({
  plan: { findUnique: vi.fn() },
  spendControl: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const billing = vi.hoisted(() => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/billing/status", () => billing);
const notices = vi.hoisted(() => ({ publishNotice: vi.fn(), resolveNotices: vi.fn() }));
vi.mock("@/lib/notices/publish", () => notices);

import {
  AI_REPLIES_PER_HOUR_BY_PLAN,
  defaultRepliesPerHourFor,
  featureRepliesPerHour,
  planRepliesPerHour,
  prefillRepliesPerHour,
  repliesPerHourProblem,
  withoutRepliesPerHour,
} from "@/lib/billing/ai-allowance";
import { aiHourNoticeKey, aiRepliesPerHour, hourKey, noteHourlyCapHit, openAiHourKeys, resetAiHourlyCache } from "@/lib/billing/ai-hourly";
import { textKeyFor } from "@/lib/notices/kinds";
import { catalogue } from "@/lib/eddy/copy/notices";
import { producer as aiProducer, setAiHeadroomReader } from "@/lib/notices/producers/ai-limit";

const T = "t1";
const plan = (code: string, name: string, features: unknown = {}) => ({ code, name, features });

beforeEach(() => {
  vi.resetAllMocks();
  resetAiHourlyCache();
  notices.publishNotice.mockResolvedValue({ id: "n1", outcome: "created" });
  notices.resolveNotices.mockResolvedValue(0);
});

describe("the rules (ai-allowance.ts)", () => {
  it("the defaults are the owner's: Starter 60, Growth 200, Agency 600, trial 60", () => {
    expect(AI_REPLIES_PER_HOUR_BY_PLAN).toEqual({ starter: 60, growth: 200, agency: 600, trial: 60 });
  });

  it("reads the plan's own value only as a whole number from 1 to 100,000", () => {
    expect(featureRepliesPerHour({ aiRepliesPerHour: 150 })).toBe(150);
    for (const bad of [0, -5, 2.5, "200", null, 100_001]) expect(featureRepliesPerHour({ aiRepliesPerHour: bad })).toBeNull();
    expect(featureRepliesPerHour(null)).toBeNull();
    expect(featureRepliesPerHour([1])).toBeNull();
  });

  it("the code decides first, then the name; copies and versions count; another plan has no default", () => {
    expect(defaultRepliesPerHourFor({ code: "starter", name: "Basic" })).toBe(60);
    expect(defaultRepliesPerHourFor({ code: "growth-v2", name: "Growth (copy)" })).toBe(200);
    expect(defaultRepliesPerHourFor({ code: "pro", name: "Agency Pro" })).toBe(600);
    expect(defaultRepliesPerHourFor({ code: "agency_annual", name: "x" })).toBe(600);
    expect(defaultRepliesPerHourFor({ code: "trial", name: "Free trial" })).toBe(60);
    expect(defaultRepliesPerHourFor({ code: "pro", name: "Pro" })).toBeNull();
    // A word inside another word is not a match.
    expect(defaultRepliesPerHourFor({ code: "overgrowth", name: "Mega" })).toBeNull();
  });

  it("the plan value wins over the code; 0 never switches the AI agent off", () => {
    expect(planRepliesPerHour(plan("growth", "Growth", { aiRepliesPerHour: 150 }))).toEqual({ value: 150, from: "plan" });
    expect(planRepliesPerHour(plan("growth", "Growth"))).toEqual({ value: 200, from: "plan_default" });
    expect(planRepliesPerHour(plan("growth", "Growth", { aiRepliesPerHour: 0 }))).toEqual({ value: 200, from: "plan_default" });
    expect(planRepliesPerHour(plan("pro", "Pro"))).toBeNull();
    expect(planRepliesPerHour(null)).toBeNull();
  });

  it("prefills the admin form and keeps the JSON free of the key", () => {
    expect(prefillRepliesPerHour(plan("agency", "Agency"))).toBe(600);
    expect(prefillRepliesPerHour(plan("pro", "Pro", { aiRepliesPerHour: 90 }))).toBe(90);
    expect(prefillRepliesPerHour(plan("pro", "Pro"))).toBe(60);
    expect(withoutRepliesPerHour({ aiRepliesPerHour: 90, automationTriggersMonthly: 5 })).toEqual({ automationTriggersMonthly: 5 });
    expect(withoutRepliesPerHour("x")).toEqual({});
    expect(repliesPerHourProblem("")).toBeNull();
    expect(repliesPerHourProblem("250")).toBeNull();
    for (const bad of ["0", "-1", "2.5", "abc", "100001"]) expect(repliesPerHourProblem(bad)).toMatch(/whole number from 1 to 1,00,000|whole number from 1 to 100,000/);
  });
});

describe("the workspace's allowance (ai-hourly.ts)", () => {
  it("the plan value wins, and AI_MAX_REPLIES_PER_HOUR (the fallback) is not used", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue(plan("growth", "Growth", { aiRepliesPerHour: 150 }));
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toEqual({ limit: 150, source: "plan", planName: "Growth" });
    expect(db.plan.findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { code: true, name: true, features: true } });
  });

  it("Starter 60, Growth 200, Agency 600 from the code or name when the plan has no value", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
    for (const [code, limit] of [["starter", 60], ["growth", 200], ["agency", 600]] as const) {
      resetAiHourlyCache();
      db.plan.findUnique.mockResolvedValue(plan(code, code.toUpperCase()));
      expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit, source: "plan_default" });
    }
  });

  it("a plan with another code and no value: the platform fallback applies", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue(plan("pro", "Pro"));
    expect(await aiRepliesPerHour(T, { fallback: 75 })).toEqual({ limit: 75, source: "fallback", planName: "Pro" });
  });

  it("a trial gets 60, or the trial plan's own value", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "trialing", planId: null });
    db.plan.findUnique.mockResolvedValue(null);
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit: 60, source: "trial" });
    expect(db.plan.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { code: "trial" } }));
    resetAiHourlyCache();
    db.plan.findUnique.mockResolvedValue(plan("trial", "Trial", { aiRepliesPerHour: 30 }));
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit: 30, source: "trial" });
  });

  it("a trial whose checkout was opened but never paid keeps the trial rule, not the chosen plan's allowance", async () => {
    // startSubscription writes the chosen plan on the row before payment, so the status carries it during the trial.
    billing.getBillingStatus.mockResolvedValue({ state: "trialing", planId: "p_agency", planName: "Agency" });
    db.plan.findUnique.mockImplementation(async ({ where }: { where: { id?: string; code?: string } }) => (where.code === "trial" ? null : plan("agency", "Agency")));
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit: 60, source: "trial" });
    expect(db.plan.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p_agency" } }));
  });

  it("the plan's allowance needs a paid state: payment grace keeps it, an ended plan gets 60", async () => {
    db.plan.findUnique.mockResolvedValue(plan("agency", "Agency"));
    billing.getBillingStatus.mockResolvedValue({ state: "past_due_grace", planId: "p1" });
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit: 600, source: "plan_default" });
    resetAiHourlyCache();
    billing.getBillingStatus.mockResolvedValue({ state: "exempt", planId: "p1" });
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toMatchObject({ limit: 600 });
    resetAiHourlyCache();
    billing.getBillingStatus.mockResolvedValue({ state: "locked", planId: "p1" });
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toEqual({ limit: 60, source: "no_plan", planName: null });
  });

  it("no plan (complimentary or locked without one) gets 60", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "exempt", planId: null });
    expect(await aiRepliesPerHour(T, { fallback: 3 })).toEqual({ limit: 60, source: "no_plan", planName: null });
    expect(db.plan.findUnique).not.toHaveBeenCalled();
  });

  it("when the plan cannot be read, the fallback applies and the next call tries again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    billing.getBillingStatus.mockRejectedValueOnce(new Error("db down"));
    expect(await aiRepliesPerHour(T, { fallback: 42 })).toEqual({ limit: 42, source: "fallback", planName: null });
    billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue(plan("agency", "Agency"));
    expect(await aiRepliesPerHour(T, { fallback: 42 })).toMatchObject({ limit: 600 });
  });

  it("reads the plan once a minute per workspace, so a reply costs no extra query", async () => {
    billing.getBillingStatus.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue(plan("growth", "Growth"));
    const at = 1_000_000;
    await aiRepliesPerHour(T, { fallback: 3, now: at });
    await aiRepliesPerHour(T, { fallback: 3, now: at + 59_000 });
    expect(billing.getBillingStatus).toHaveBeenCalledTimes(1);
    await aiRepliesPerHour(T, { fallback: 3, now: at + 61_000 });
    expect(billing.getBillingStatus).toHaveBeenCalledTimes(2);
    // Another workspace is read on its own.
    await aiRepliesPerHour("t2", { fallback: 3, now: at + 61_000 });
    expect(billing.getBillingStatus).toHaveBeenCalledTimes(3);
  });
});

describe("one notice per hour when the cap is hit", () => {
  const at = new Date("2026-10-31T14:20:00Z");

  it("raises ai_limit_100 for the hour, for admins, with the numbers and a button to billing", async () => {
    await noteHourlyCapHit(T, { used: 200, limit: 200, now: at });
    expect(notices.publishNotice).toHaveBeenCalledTimes(1);
    const [input, opts] = notices.publishNotice.mock.calls[0];
    expect(input).toMatchObject({
      tenantId: T,
      kind: "ai_limit_100",
      severity: "action_needed",
      dedupeKey: "ai-hour:2026-10-31T14",
      audience: { minRole: "admin" },
      payload: { period: "hour", periodKey: "2026-10-31T14", level: 100, used: 200, limit: 200 },
      actions: [{ kind: "navigate", path: "/app/billing#plans", labelKey: "btn.go_to_billing" }],
    });
    expect(input.ttlMs).toBe(2 * 60 * 60_000);
    expect(opts).toEqual({ now: at });
    // An earlier hour's notice is resolved, so only one is open.
    expect(notices.resolveNotices).toHaveBeenCalledWith(T, { kinds: ["ai_limit_100"], prefix: "ai-hour:", except: ["ai-hour:2026-10-31T14"] }, { now: at });
  });

  it("however many messages the cap holds back in that hour, one notice; the next hour gets its own", async () => {
    for (let i = 0; i < 5; i++) await noteHourlyCapHit(T, { used: 200, limit: 200, now: new Date(at.getTime() + i * 60_000) });
    expect(notices.publishNotice).toHaveBeenCalledTimes(1);
    await noteHourlyCapHit("t2", { used: 60, limit: 60, now: at });
    expect(notices.publishNotice).toHaveBeenCalledTimes(2);
    await noteHourlyCapHit(T, { used: 200, limit: 200, now: new Date("2026-10-31T15:01:00Z") });
    expect(notices.publishNotice).toHaveBeenCalledTimes(3);
    expect(notices.publishNotice.mock.calls[2][0].dedupeKey).toBe("ai-hour:2026-10-31T15");
  });

  it("a notice that could not be stored is tried again on the next hit, and nothing ever throws", async () => {
    notices.publishNotice.mockResolvedValueOnce({ id: null, outcome: "failed" });
    await noteHourlyCapHit(T, { used: 60, limit: 60, now: at });
    await noteHourlyCapHit(T, { used: 60, limit: 60, now: at });
    expect(notices.publishNotice).toHaveBeenCalledTimes(2);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    notices.publishNotice.mockRejectedValueOnce(new Error("boom"));
    resetAiHourlyCache();
    await expect(noteHourlyCapHit(T, { used: 60, limit: 60, now: at })).resolves.toBeUndefined();
  });

  it("has its own text in English, Hindi and Hinglish, with the limit in it", () => {
    expect(textKeyFor("ai_limit_100", { period: "hour" })).toBe("notices.ai_100.hour");
    expect(textKeyFor("ai_limit_100", { period: "day" })).toBe("notices.ai_100.day");
    expect(textKeyFor("ai_limit_100", { period: "month" })).toBe("notices.ai_100.month");
    for (const lang of ["en", "hi", "hinglish"] as const) expect(catalogue[lang]["notices.ai_100.hour"]).toContain("{limit}");
    expect(catalogue.en["notices.ai_100.hour"]).toBe("The AI agent reached its limit of {limit} replies an hour. Until the hour is up, your team answers new chats. A bigger plan allows more replies.");
  });

  it("the hour keys: this hour and the last stay open", () => {
    expect(hourKey(at)).toBe("2026-10-31T14");
    expect(aiHourNoticeKey(at)).toBe("ai-hour:2026-10-31T14");
    expect(openAiHourKeys(at)).toEqual(["ai-hour:2026-10-31T14", "ai-hour:2026-10-31T13"]);
    expect(openAiHourKeys(new Date("2026-11-01T00:10:00Z"))).toEqual(["ai-hour:2026-11-01T00", "ai-hour:2026-10-31T23"]);
  });
});

describe("the AI limit producer resolves hourly notices once their hour is over", () => {
  const now = new Date("2026-10-31T16:05:00Z");
  const ctx = () => ({
    tenantId: T,
    now,
    demo: false,
    hasNumber: true,
    cursor: null,
    publish: vi.fn(async () => ({ id: "x", outcome: "created" as const })),
    resolve: vi.fn(async () => 1),
  });

  it("without a SpendControl row: only older hourly notices resolve, nothing else is read", async () => {
    db.spendControl.findUnique.mockResolvedValue(null);
    const reader = vi.fn();
    setAiHeadroomReader(reader);
    const c = ctx();
    expect(await aiProducer.run(c)).toEqual({ resolved: 1 });
    expect(c.resolve).toHaveBeenCalledWith({ kinds: ["ai_limit_100"], prefix: "ai-hour:", except: ["ai-hour:2026-10-31T16", "ai-hour:2026-10-31T15"] });
    expect(reader).not.toHaveBeenCalled();
    c.resolve.mockResolvedValueOnce(0);
    expect(await aiProducer.run(c)).toEqual({});
    setAiHeadroomReader(null);
  });

  it("with one: the hourly keys are kept with Phase 0's, so the monthly and daily resolve cannot close them early", async () => {
    db.spendControl.findUnique.mockResolvedValue({ tenantId: T });
    setAiHeadroomReader(async () => ({ usedToday: 0, limitToday: null, usedMonth: 10, limitMonth: 500, leftToday: null, leftMonth: 490, todayResetsOn: "2026-11-01", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" }));
    const c = ctx();
    await aiProducer.run(c);
    expect(c.resolve).toHaveBeenCalledWith({ kinds: ["ai_limit_80", "ai_limit_100"], except: ["ai-hour:2026-10-31T16", "ai-hour:2026-10-31T15"] });
    setAiHeadroomReader(null);
  });
});
