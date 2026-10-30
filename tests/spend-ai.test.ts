import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere, type FakeSpendDb, type RawCall, type Row } from "./helpers/fake-spend-db";
import type { FreezeLevel, SpendActor, SpendNotice } from "@/lib/spend/types";

/**
 * The AI gateway (docs/SPEND-CONTROLS-SPEC.md 4.10, 6.4, I5, I9, I12; decision 2.3.11 and 12.1a decision 8).
 *
 * The gateway runs for real on the real counters, reservations, ledger, control and usage modules, over the in-memory spend
 * database (tests/helpers/fake-spend-db.ts) with the SpendCounter and SpendReservation statements emulated atomically, the
 * way Postgres re-checks each row after its row lock. Only the freeze state, the effective limits (allowances.ts has its
 * own tests), the notifier and claimOnce are replaced. fetch is mocked: no Anthropic call is ever made.
 */

type Limits = { daily: bigint | null; monthly: bigint | null; plan: bigint; assistantRefusal: { reason: string; code: null } | null };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  freeze: { workspace: "none", platform: "none" } as { workspace: FreezeLevel; platform: FreezeLevel },
  limits: { daily: null, monthly: 100n, plan: 100n, assistantRefusal: null } as Limits,
  notices: [] as SpendNotice[],
  claims: new Set<string>(),
  notifyDelivers: true,
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/spend/kill", () => ({
  spendState: vi.fn(async () => ({
    workspace: h.freeze.workspace,
    platform: h.freeze.platform,
    effective: h.freeze.platform === "all" || h.freeze.workspace === "all" ? "all" : h.freeze.platform === "assistants" || h.freeze.workspace === "assistants" ? "assistants" : "none",
    frozenAt: null,
    frozenByKind: null,
    frozenByUserId: null,
    reason: null,
  })),
}));
vi.mock("@/lib/spend/allowances", () => ({
  effectiveLimits: vi.fn(async (_tenantId: string, pot: string) => {
    if (pot !== "ai") throw new Error("The AI gateway reads the AI pot only.");
    return {
      pot: "ai",
      currency: "CRD",
      daily: h.limits.daily,
      monthly: h.limits.monthly,
      planCapMonthly: h.limits.plan,
      unknownCeiling: false,
      rules: { adsCanStart: true, humansChecked: { daily: h.limits.daily !== null, monthly: true }, assistantRefusal: h.limits.assistantRefusal, humanRefusal: null },
    };
  }),
}));
vi.mock("@/lib/spend/notify", () => ({
  notifySpend: vi.fn(async (notice: SpendNotice) => {
    if (!h.notifyDelivers) return { delivered: [], skipped: [{ channel: "in_app", reason: "down" }], deduplicated: false };
    h.notices.push(notice);
    return { delivered: ["in_app"], skipped: [], deduplicated: false };
  }),
}));
vi.mock("@/lib/lifecycle/state", () => ({
  claimOnce: vi.fn(async (key: string) => {
    if (h.claims.has(key)) return false;
    h.claims.add(key);
    return true;
  }),
  releaseClaim: vi.fn(async (key: string) => {
    h.claims.delete(key);
  }),
}));

import * as billingLimits from "@/lib/billing/limits";
import { AI_UNAVAILABLE_SIGNAL, classifyWithAi } from "@/lib/chatbots/escalation";
import { spendCopy } from "@/lib/spend/copy";
import { SpendBlockedError } from "@/lib/spend/errors";
import {
  addUsage,
  AI_CALL_TTL_MS,
  AI_FEATURES,
  aiFreezeRefusal,
  aiNoticeKey,
  aiObserveApplies,
  anthropicMessages,
  ANTHROPIC_MESSAGES_URL,
  AUTOMATIC_AI_FEATURES,
  isAiQuotaError,
  isAiRefusal,
  meteredProvider,
  NO_USAGE,
  PERSON_REQUESTED_AI_FEATURES,
  reserveAi,
  resetAiCounterSeeds,
  usageFromResponse,
  type AiFeature,
} from "@/lib/spend/exec/ai";
import { expireReservations } from "@/lib/spend/reservations";
import { recordUsage } from "@/lib/usage";

// =====================================================================================================================
// The fake database: SpendCounter / SpendReservation statements, and UsageLedger with createdAt and aggregate
// =====================================================================================================================

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * The conditional statements of counters.ts and reservations.ts, applied atomically (one handler runs at a time).
 * `failClose` makes closing a reservation fail, as a lost connection would.
 */
function emulateSql(db: FakeSpendDb, opts: { failClose?: boolean } = {}): void {
  db.onRaw((call: RawCall) => {
    if (opts.failClose && call.sql.includes("spend.reservation.close")) throw new Error("connection lost");
    const rows = db.rows("spendCounter");
    const find = (t: unknown, pot: unknown, kind: string, key: unknown) => rows.find((r) => r.tenantId === t && r.pot === pot && r.periodKind === kind && r.periodKey === key);
    if (call.sql.includes("spend.counter.reserve")) {
      const [t, pot, day, month, c, dl, ml] = call.values as [string, string, string, string, bigint, bigint | null, bigint | null];
      const d = find(t, pot, "day", day);
      const m = find(t, pot, "month", month);
      const fits = (r: Row | undefined, lim: bigint | null) => !!r && (lim === null || (r.spentMinor as bigint) + (r.reservedMinor as bigint) + c <= lim);
      const dOk = fits(d, dl);
      const mOk = fits(m, ml);
      // A partial match changes neither row: Postgres rolls back the gateway's own transaction.
      if (dOk && mOk) {
        d!.reservedMinor = (d!.reservedMinor as bigint) + c;
        m!.reservedMinor = (m!.reservedMinor as bigint) + c;
      }
      const total = (r: Row | undefined) => (r ? String((r.spentMinor as bigint) + (r.reservedMinor as bigint)) : null);
      return [{ d: dOk ? 1 : 0, m: mOk ? 1 : 0, dayTotal: dOk ? total(d) : null, monthTotal: mOk ? total(m) : null }];
    }
    if (call.sql.includes("spend.counter.settle")) {
      const [t, pot, day, month, rel, delta] = call.values as [string, string, string, string, bigint, bigint];
      let n = 0;
      for (const r of [find(t, pot, "day", day), find(t, pot, "month", month)]) {
        if (!r) continue;
        r.reservedMinor = max(0n, (r.reservedMinor as bigint) - rel);
        r.spentMinor = max(0n, (r.spentMinor as bigint) + delta);
        n++;
      }
      return n;
    }
    if (call.sql.includes("spend.reservation.close")) {
      const [id, status, now, actual] = call.values as [string, string, Date, bigint | null];
      const r = db.rows("spendReservation").find((x) => x.id === id);
      if (!r || r.status !== "held") return [];
      r.status = status === "released" && (r.consumedMinor as bigint) > 0n ? "settled" : status;
      r.closedAt = now;
      if (actual !== null) r.consumedMinor = actual;
      return [{ ...r, amountMinor: String(r.amountMinor), consumedMinor: String(r.consumedMinor) }];
    }
    return undefined;
  });
}

let usageIds = 0;
/** UsageLedger on the base fake: a default id and createdAt, and the aggregate the gateway's counter seeding reads. */
function patchUsageLedger(db: FakeSpendDb): void {
  const ul = (db.prisma as Record<string, unknown>).usageLedger as Record<string, unknown> & { __patched?: boolean };
  if (ul.__patched) return;
  const create = ul.create as (args: { data: Row }) => Promise<Row>;
  ul.create = async ({ data }: { data: Row }) => create({ data: { id: `ul_${++usageIds}`, createdAt: new Date(), ...data } });
  ul.aggregate = async ({ where }: { where?: Row }) => {
    const rows = db.rows("usageLedger").filter((r) => matchesWhere(r, where));
    return { _sum: { amount: rows.length ? rows.reduce((n, r) => n + Number(r.amount), 0) : null } };
  };
  ul.__patched = true;
}

// =====================================================================================================================
// Fixtures
// =====================================================================================================================

const T = "t1";
const NOW = new Date("2026-10-15T06:00:00Z"); // 11:30 in Kolkata
const KEYS = { day: "2026-10-15", month: "2026-10" };
const MEMBER: SpendActor = { type: "user", userId: "u1", role: "admin" };
const BOT: SpendActor = { type: "system", job: "ai_agent" };
const ASSISTANT: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };
const BODY = { model: "claude-sonnet-5-5", max_tokens: 50, messages: [{ role: "user", content: "hi" }] };
const MONTH_COPY = "This month's AI limit is used up. AI replies and suggestions are off until 1 Nov. Your team can still reply.";
const DAY_COPY = "Today's AI limit is used up. AI replies and suggestions are off until tomorrow. Your team can still reply.";

type Usage = { input_tokens: number; output_tokens: number };
const reply = (usage: Usage = { input_tokens: 120, output_tokens: 30 }, model = "claude-sonnet-5-5", text = "hi") =>
  new Response(JSON.stringify({ id: "msg_1", type: "message", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage }), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

const counter = (kind: "day" | "month", tenantId = T) => {
  const r = h.db.rows("spendCounter").find((x) => x.tenantId === tenantId && x.pot === "ai" && x.periodKind === kind);
  return { spent: (r?.spentMinor as bigint | undefined) ?? 0n, reserved: (r?.reservedMinor as bigint | undefined) ?? 0n, key: r?.periodKey };
};
const reservations = () => h.db.rows("spendReservation");
const usageRows = () => h.db.rows("usageLedger");
const blockedRows = () => h.db.rows("spendLedger").filter((r) => r.action === "ai.blocked");
const ctx = (over: Partial<{ feature: AiFeature; actor: SpendActor; credits: number; ref: { type: string; id: string } | null; subjectId: string }> = {}) => ({
  tenantId: T,
  feature: "inbox_suggest" as AiFeature,
  actor: MEMBER,
  credits: 1,
  ...over,
});
const call = (over: Parameters<typeof ctx>[0] = {}) => anthropicMessages(ctx(over), BODY, 5_000);
const seedUsage = (rows: { amount: number; createdAt: Date; tenantId?: string }[]) =>
  h.db.seed(
    "usageLedger",
    rows.map((r, i) => ({ id: `seed_${i}`, tenantId: r.tenantId ?? T, meter: "ai_credits", amount: r.amount, refType: "ai_reply", refId: "c0", createdAt: r.createdAt })),
  );
const settled = async <T,>(promises: Promise<T>[]) => {
  const out = await Promise.allSettled(promises);
  return { ok: out.filter((o) => o.status === "fulfilled").length, refused: out.filter((o): o is PromiseRejectedResult => o.status === "rejected").map((o) => o.reason as unknown) };
};

beforeEach(() => {
  h.db.reset();
  emulateSql(h.db);
  patchUsageLedger(h.db);
  h.freeze = { workspace: "none", platform: "none" };
  h.limits = { daily: null, monthly: 100n, plan: 100n, assistantRefusal: null };
  h.notices.length = 0;
  h.claims.clear();
  h.notifyDelivers = true;
  resetAiCounterSeeds();
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("SPEND_ENFORCE", "enforce");
  fetchMock = vi.fn(async () => reply());
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// =====================================================================================================================
describe("freeze check per feature (4.10 step 1 as corrected, 2.3.11, 12.1a decision 8)", () => {
  const state = (workspace: FreezeLevel, platform: FreezeLevel = "none") => ({ workspace, platform });

  it("splits the six features into automatic ones and ones a person asks for", () => {
    expect([...AUTOMATIC_AI_FEATURES].sort()).toEqual(["agent_reply", "escalation"]);
    expect([...PERSON_REQUESTED_AI_FEATURES].sort()).toEqual(["ai_test", "creative", "eddy", "inbox_suggest"]);
    expect([...AI_FEATURES].sort()).toEqual([...AUTOMATIC_AI_FEATURES, ...PERSON_REQUESTED_AI_FEATURES].sort());
  });

  it.each(AI_FEATURES.map((f) => [f] as const))("%s: nothing stops it while spending is on", (feature) => {
    for (const actor of [MEMBER, BOT, ASSISTANT]) expect(aiFreezeRefusal(state("none"), feature, actor)).toBeNull();
  });

  it.each(AI_FEATURES.map((f) => [f] as const))("%s under 'Stop all spending' (workspace and platform)", (feature) => {
    const automatic = AUTOMATIC_AI_FEATURES.includes(feature);
    const actor = automatic ? BOT : MEMBER;
    expect(aiFreezeRefusal(state("all"), feature, actor)).toBe(automatic ? "spend.frozen" : null);
    expect(aiFreezeRefusal(state("none", "all"), feature, actor)).toBe(automatic ? "spend.platform_frozen" : null);
    // An assistant is always stopped, whatever the feature.
    expect(aiFreezeRefusal(state("all"), feature, ASSISTANT)).toBe("spend.frozen");
    expect(aiFreezeRefusal(state("none", "all"), feature, ASSISTANT)).toBe("spend.platform_frozen");
  });

  it.each(AI_FEATURES.map((f) => [f] as const))("%s under 'Stop assistants': only an assistant stops", (feature) => {
    expect(aiFreezeRefusal(state("assistants"), feature, BOT)).toBeNull();
    expect(aiFreezeRefusal(state("assistants"), feature, MEMBER)).toBeNull();
    expect(aiFreezeRefusal(state("assistants"), feature, ASSISTANT)).toBe("spend.frozen");
    expect(aiFreezeRefusal(state("none", "assistants"), feature, ASSISTANT)).toBe("spend.platform_frozen");
  });

  it("the platform's stop is named first when both are on", () => {
    expect(aiFreezeRefusal(state("all", "all"), "agent_reply", BOT)).toBe("spend.platform_frozen");
  });

  it("a frozen automatic call is refused before any hold or call; what a person asked for still runs and is charged", async () => {
    h.freeze = { workspace: "all", platform: "none" };
    for (const feature of ["agent_reply", "escalation"] as AiFeature[]) {
      const error = await call({ feature, actor: BOT }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SpendBlockedError);
      expect(error).toMatchObject({ code: "spend.frozen", message: spendCopy("spend.frozen") });
      expect(isAiRefusal(error)).toBe(true);
      expect(isAiQuotaError(error)).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.rows("spendCounter")).toEqual([]);
    expect(reservations()).toEqual([]);

    for (const feature of PERSON_REQUESTED_AI_FEATURES) await call({ feature });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(counter("month")).toMatchObject({ spent: 4n, reserved: 0n });
  });

  it("an assistant's call stops under 'Stop assistants' while the AI agent keeps replying", async () => {
    h.freeze = { workspace: "assistants", platform: "none" };
    await expect(call({ feature: "creative", actor: ASSISTANT })).rejects.toMatchObject({ code: "spend.frozen" });
    await expect(call({ feature: "agent_reply", actor: BOT })).resolves.toMatchObject({ id: "msg_1" });
  });

  it("refuses an unknown feature", async () => {
    await expect(call({ feature: "magic" as AiFeature })).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
describe("hold, call, settle (4.10 steps 2-4)", () => {
  it("holds before the call, then settles the actual credits with tokens and model on UsageLedger", async () => {
    let during: { reserved: bigint; open: Row[] } | null = null;
    fetchMock.mockImplementationOnce(async () => {
      during = { reserved: counter("month").reserved, open: reservations().filter((r) => r.status === "held").map((r) => ({ ...r })) };
      return reply({ input_tokens: 812, output_tokens: 64 }, "claude-sonnet-5-5");
    });
    const json = await call({ credits: 2, ref: { type: "inbox_suggest", id: "c1" } });
    expect(json.content?.[0]?.text).toBe("hi");

    expect(during!.reserved).toBe(2n);
    expect(during!.open).toHaveLength(1);
    const hold = during!.open[0];
    expect(hold).toMatchObject({ tenantId: T, pot: "ai", currency: "CRD", subjectType: "ai_call", amountMinor: 2n, dayKey: KEYS.day, monthKey: KEYS.month });
    expect(String(hold.subjectId)).toMatch(/^inbox_suggest:[0-9a-f-]{36}$/);
    expect((hold.expiresAt as Date).getTime() - NOW.getTime()).toBe(AI_CALL_TTL_MS);
    expect(AI_CALL_TTL_MS).toBe(120_000);

    expect(counter("day")).toMatchObject({ spent: 2n, reserved: 0n, key: KEYS.day });
    expect(counter("month")).toMatchObject({ spent: 2n, reserved: 0n, key: KEYS.month });
    expect(reservations()[0]).toMatchObject({ status: "settled", consumedMinor: 2n });
    expect(usageRows()).toEqual([
      expect.objectContaining({ tenantId: T, meter: "ai_credits", amount: 2, refType: "inbox_suggest", refId: "c1", inputTokens: 812, outputTokens: 64, model: "claude-sonnet-5-5" }),
    ]);
  });

  it("posts to the Anthropic Messages API from the gateway, with the key and the pinned version", async () => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(BODY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("counts in the workspace's time zone", async () => {
    h.db.seed("spendControl", [{ tenantId: T, timezone: "America/New_York" }]);
    vi.setSystemTime(new Date("2026-11-01T02:00:00Z")); // 31 Oct, 22:00 in New York
    await call();
    expect(counter("day").key).toBe("2026-10-31");
    expect(counter("month").key).toBe("2026-10");
  });

  it.each([
    ["the service cannot be reached", () => Promise.reject(new TypeError("fetch failed")), "The AI service could not be reached."],
    ["the service answers with an error", async () => new Response("overloaded", { status: 529 }), "The AI service returned an error."],
  ])("releases the hold when %s, and charges nothing", async (_label, impl, message) => {
    fetchMock.mockImplementationOnce(impl);
    await expect(call({ credits: 3 })).rejects.toMatchObject({ status: 502, message });
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(counter("day")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(reservations()[0]).toMatchObject({ status: "released" });
    expect(usageRows()).toEqual([]);
  });

  it("an answer whose body cannot be read is still charged (the service billed it)", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("not json", { status: 200 }));
    await expect(call({ credits: 1 })).resolves.toEqual({});
    expect(counter("month")).toMatchObject({ spent: 1n, reserved: 0n });
    expect(usageRows()).toHaveLength(1);
    expect(usageRows()[0]).toMatchObject({ amount: 1 });
    expect(usageRows()[0].inputTokens ?? null).toBeNull();
    expect(usageRows()[0].model ?? null).toBeNull();
  });

  it("says AI is not configured, with no hold and no call, when there is no key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(call()).rejects.toMatchObject({ status: 503, message: "AI is not configured." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reservations()).toEqual([]);
  });

  it("a hold of 0 credits checks the stop but holds nothing", async () => {
    const hold = await reserveAi(ctx({ credits: 0 }));
    expect(hold).toMatchObject({ credits: 0, reservationId: null, state: "open" });
    expect(reservations()).toEqual([]);
    h.freeze = { workspace: "all", platform: "none" };
    await expect(reserveAi(ctx({ feature: "agent_reply", actor: BOT, credits: 0 }))).rejects.toMatchObject({ code: "spend.frozen" });
  });

  it("refuses a negative or non-numeric hold", async () => {
    await expect(reserveAi(ctx({ credits: -1 }))).rejects.toThrow(RangeError);
    await expect(reserveAi(ctx({ credits: Number.NaN }))).rejects.toThrow(RangeError);
  });

  it("one open hold per subject: a second hold on the same subject is refused and gives its credits back", async () => {
    await reserveAi(ctx({ subjectId: "turn_1:0", credits: 2 }));
    await expect(reserveAi(ctx({ subjectId: "turn_1:0", credits: 3 }))).rejects.toMatchObject({ code: "P2002" });
    expect(counter("month")).toMatchObject({ reserved: 2n });
    await reserveAi(ctx({ subjectId: "turn_1:1", credits: 3 }));
    expect(counter("month")).toMatchObject({ reserved: 5n });
  });
});

// =====================================================================================================================
describe("the AI limit across every caller and process (I5, 4.10 step 2)", () => {
  const slowReply = async () => {
    await new Promise((r) => setImmediate(r));
    return reply();
  };

  it("parallel callers cannot pass the daily limit", async () => {
    h.limits = { daily: 5n, monthly: 100n, plan: 100n, assistantRefusal: null };
    fetchMock.mockImplementation(slowReply);
    const out = await settled(Array.from({ length: 12 }, () => call()));
    expect(out.ok).toBe(5);
    expect(out.refused).toHaveLength(7);
    for (const e of out.refused) expect(e).toMatchObject({ status: 402, code: "ai_quota", message: DAY_COPY });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(counter("day")).toMatchObject({ spent: 5n, reserved: 0n });
    expect(usageRows()).toHaveLength(5);
  });

  it("parallel callers cannot pass the monthly limit, whatever mix of features and sizes they hold", async () => {
    h.limits = { daily: null, monthly: 10n, plan: 10n, assistantRefusal: null };
    fetchMock.mockImplementation(slowReply);
    const features: AiFeature[] = ["agent_reply", "inbox_suggest", "creative", "escalation", "ai_test", "eddy"];
    const out = await settled(Array.from({ length: 18 }, (_, i) => call({ feature: features[i % 6], actor: i % 2 ? MEMBER : BOT, credits: 3 })));
    expect(out.ok).toBe(3);
    for (const e of out.refused) expect(e).toMatchObject({ status: 402, code: "ai_quota", message: MONTH_COPY });
    const month = counter("month");
    expect(month.spent + month.reserved).toBeLessThanOrEqual(10n);
    expect(month).toMatchObject({ spent: 9n, reserved: 0n });
  });

  it("a hold another process has open in the database counts here (no in-process map)", async () => {
    h.limits = { daily: 5n, monthly: 100n, plan: 100n, assistantRefusal: null };
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "ai", periodKind: "day", periodKey: KEYS.day, currency: "CRD", spentMinor: 0n, reservedMinor: 4n },
      { tenantId: T, pot: "ai", periodKind: "month", periodKey: KEYS.month, currency: "CRD", spentMinor: 0n, reservedMinor: 4n },
    ]);
    await call();
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    expect(counter("day")).toMatchObject({ spent: 1n, reserved: 4n });
  });

  it("credits used before the gateway shipped count: the period's counters start from UsageLedger (I12)", async () => {
    h.limits = { daily: null, monthly: 100n, plan: 100n, assistantRefusal: null };
    seedUsage([
      { amount: 60, createdAt: new Date("2026-10-02T10:00:00Z") },
      { amount: 35, createdAt: new Date("2026-10-15T01:00:00Z") },
      { amount: 50, createdAt: new Date("2026-09-30T12:00:00Z") }, // last month
      { amount: 70, createdAt: new Date("2026-10-10T10:00:00Z"), tenantId: "t2" }, // another workspace
    ]);
    await call({ credits: 5 });
    expect(counter("month")).toMatchObject({ spent: 100n, reserved: 0n });
    expect(counter("day")).toMatchObject({ spent: 40n });
    await expect(call({ credits: 1 })).rejects.toMatchObject({ code: "ai_quota", message: MONTH_COPY });
  });

  it("the refusal is 402 ai_quota with the 4.13 copy, and is ledgered once an hour, not once per call", async () => {
    h.limits = { daily: null, monthly: 0n, plan: 0n, assistantRefusal: null };
    const error = await call({ feature: "agent_reply", actor: BOT }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect(error).toMatchObject({ status: 402, code: "ai_quota", message: MONTH_COPY });
    expect((error as SpendBlockedError).toJSON()).toMatchObject({ error: MONTH_COPY, code: "ai_quota", params: { period: "month" } });
    expect(isAiQuotaError(error)).toBe(true);
    expect(isAiRefusal(error)).toBe(true);
    await expect(call({ feature: "agent_reply", actor: BOT })).rejects.toMatchObject({ code: "ai_quota" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(blockedRows()).toEqual([
      expect.objectContaining({ tenantId: T, pot: "ai", phase: "refused", actorType: "system", targetType: "ai_feature", targetId: "agent_reply", currency: "CRD", observe: false, reason: MONTH_COPY }),
    ]);
    expect(blockedRows()[0].reasonCodes).toEqual(expect.arrayContaining(["ai_quota", "agent_reply", "month"]));
  });

  it("an assistant is refused before any hold when the owner has not set an AI limit (2.3.8)", async () => {
    h.limits = { daily: null, monthly: 100n, plan: 100n, assistantRefusal: { reason: "no_limit", code: null } };
    await expect(call({ feature: "creative", actor: ASSISTANT })).rejects.toMatchObject({ status: 402, code: "ai_quota" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reservations()).toEqual([]);
    expect(blockedRows()[0].reasonCodes).toEqual(expect.arrayContaining(["ai_quota", "no_limit"]));
    // People are not refused by that rule.
    await expect(call({ feature: "creative", actor: MEMBER })).resolves.toBeTruthy();
  });
});

// =====================================================================================================================
describe("SPEND_ENFORCE=observe (4.14, I12)", () => {
  beforeEach(() => {
    vi.stubEnv("SPEND_ENFORCE", "observe");
    h.limits = { daily: 2n, monthly: 3n, plan: 6n, assistantRefusal: null };
  });

  it("applies to every caller except an assistant", () => {
    expect(aiObserveApplies(MEMBER)).toBe(true);
    expect(aiObserveApplies(BOT)).toBe(true);
    expect(aiObserveApplies(ASSISTANT)).toBe(false);
    expect(aiObserveApplies(MEMBER, { SPEND_ENFORCE: "enforce" })).toBe(false);
  });

  it("lets calls past the new daily and monthly AI limits with a would-refuse row, but never past the plan's monthly credits", async () => {
    for (let i = 0; i < 4; i++) await call({ feature: i % 2 ? "inbox_suggest" : "agent_reply", actor: i % 2 ? MEMBER : BOT });
    expect(counter("month")).toMatchObject({ spent: 4n, reserved: 0n });
    const observed = blockedRows().filter((r) => r.observe === true);
    expect(observed.length).toBeGreaterThan(0);
    expect(String(observed[0].reason)).toContain("Let through while the new limits are being watched.");
    // Today's check, the plan's monthly AI credits, stays enforced in observe mode.
    await call({ credits: 2 });
    await expect(call()).rejects.toMatchObject({ status: 402, code: "ai_quota" });
    expect(counter("month")).toMatchObject({ spent: 6n });
  });

  it("an assistant is held to the new limits even in observe mode", async () => {
    await call({ feature: "creative", actor: ASSISTANT });
    await call({ feature: "creative", actor: ASSISTANT });
    await expect(call({ feature: "creative", actor: ASSISTANT })).rejects.toMatchObject({ code: "ai_quota", message: DAY_COPY });
  });
});

// =====================================================================================================================
describe("80% and 100% notices, once per period (6.4)", () => {
  beforeEach(() => {
    h.limits = { daily: null, monthly: 10n, plan: 10n, assistantRefusal: null };
  });

  it("sends the 80% notice when a charge crosses it, then the 100% notice, each once", async () => {
    await call({ credits: 7 });
    expect(h.notices).toEqual([]);
    await call({ credits: 1 });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      tenantId: T,
      kind: "ai_limit_80",
      severity: "heads_up",
      audience: "admins",
      dedupeKey: aiNoticeKey(T, KEYS.month, 80),
      title: "AI credits are 80% used this month",
      link: "/app/settings/spending",
      params: { period: "month", level: 80, used: 8, limit: 10 },
    });
    expect(h.notices[0].body).toContain("8 of 10 AI credits this month");
    expect(h.notices[0].body).toContain("Eddy");
    expect(aiNoticeKey(T, KEYS.month, 80)).toBe("spend-ai:t1:2026-10:80");

    await call({ credits: 1 });
    expect(h.notices).toHaveLength(1);
    await call({ credits: 1 });
    expect(h.notices.map((n) => n.kind)).toEqual(["ai_limit_80", "ai_limit_100"]);
    expect(h.notices[1]).toMatchObject({ severity: "action_needed", title: "This month's AI limit is used up", dedupeKey: "spend-ai:t1:2026-10:100" });
    expect(h.notices[1].body).toBe(`${MONTH_COPY} The owner can raise the limit in Settings > Spending limits.`);

    // Refusals after that send nothing more.
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    expect(h.notices).toHaveLength(2);
  });

  it("a limit reached in one jump sends only the 100% notice, and the 80% one never follows", async () => {
    await call({ credits: 10 });
    expect(h.notices.map((n) => n.kind)).toEqual(["ai_limit_100"]);
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    expect(h.notices.map((n) => n.kind)).toEqual(["ai_limit_100"]);
  });

  it("a refusal that finds the limit already used up sends the 100% notice once", async () => {
    h.limits = { daily: null, monthly: 0n, plan: 0n, assistantRefusal: null };
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    await expect(call()).rejects.toMatchObject({ code: "ai_quota" });
    expect(h.notices.map((n) => [n.kind, n.dedupeKey])).toEqual([["ai_limit_100", "spend-ai:t1:2026-10:100"]]);
  });

  it("the next month is a new period, so it is told again", async () => {
    await call({ credits: 8 });
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    await call({ credits: 7 });
    expect(h.notices).toHaveLength(1);
    await call({ credits: 1 });
    expect(h.notices.map((n) => n.dedupeKey)).toEqual(["spend-ai:t1:2026-10:80", "spend-ai:t1:2026-11:80"]);
  });

  it("the daily limit has its own notices, keyed by the day", async () => {
    h.limits = { daily: 5n, monthly: 100n, plan: 100n, assistantRefusal: null };
    await call({ credits: 4 });
    await call({ credits: 1 });
    expect(h.notices.map((n) => [n.kind, n.dedupeKey, n.title])).toEqual([
      ["ai_limit_80", "spend-ai:t1:2026-10-15:80", "AI credits are 80% used today"],
      ["ai_limit_100", "spend-ai:t1:2026-10-15:100", "Today's AI limit is used up"],
    ]);
  });

  it("a notice that could not be delivered is tried again on the next charge", async () => {
    h.notifyDelivers = false;
    await call({ credits: 8 });
    expect(h.claims.has("spend-ai:t1:2026-10:80")).toBe(false);
    h.notifyDelivers = true;
    await call({ credits: 1 });
    expect(h.notices.map((n) => n.kind)).toEqual(["ai_limit_80"]);
  });
});

// =====================================================================================================================
describe("one hold for several rounds (the AI agent, suggestions, the AI test)", () => {
  it("every round goes through the gateway under the hold, and one settle writes one row with every round's tokens", async () => {
    fetchMock.mockImplementationOnce(async () => reply({ input_tokens: 100, output_tokens: 20 }, "claude-sonnet-5-5"));
    fetchMock.mockImplementationOnce(async () => reply({ input_tokens: 50, output_tokens: 10 }, "claude-haiku-5-5"));
    const hold = await reserveAi({ tenantId: T, feature: "agent_reply", actor: BOT, credits: 1 });
    await anthropicMessages({ tenantId: T, feature: "agent_reply", actor: BOT, hold }, BODY, 1_000);
    await anthropicMessages({ tenantId: T, feature: "agent_reply", actor: BOT, hold }, BODY, 1_000);
    expect(hold.usage).toEqual({ inputTokens: 150, outputTokens: 30, model: "claude-haiku-5-5" });
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 1n });

    await hold.settle({ credits: 1, ref: { type: "ai_reply", id: "c1" } });
    expect(counter("month")).toMatchObject({ spent: 1n, reserved: 0n });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 1, refType: "ai_reply", refId: "c1", inputTokens: 150, outputTokens: 30, model: "claude-haiku-5-5" })]);

    // Settling or releasing again does nothing.
    await hold.settle({ credits: 1 });
    await hold.release();
    expect(usageRows()).toHaveLength(1);
    expect(counter("month")).toMatchObject({ spent: 1n, reserved: 0n });
    // A settled hold cannot carry more calls.
    await expect(anthropicMessages({ tenantId: T, feature: "agent_reply", actor: BOT, hold }, BODY, 1_000)).rejects.toThrow(RangeError);
  });

  it("a stop that starts between two rounds refuses the next round without calling the model", async () => {
    const hold = await reserveAi({ tenantId: T, feature: "agent_reply", actor: BOT, credits: 1 });
    await anthropicMessages({ tenantId: T, feature: "agent_reply", actor: BOT, hold }, BODY, 1_000);
    h.freeze = { workspace: "none", platform: "all" };
    await expect(anthropicMessages({ tenantId: T, feature: "agent_reply", actor: BOT, hold }, BODY, 1_000)).rejects.toMatchObject({ code: "spend.platform_frozen" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await hold.release();
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
  });

  it("a hold only serves its own workspace", async () => {
    const hold = await reserveAi({ tenantId: T, feature: "inbox_suggest", actor: MEMBER, credits: 1 });
    await expect(anthropicMessages({ tenantId: "t2", feature: "inbox_suggest", actor: MEMBER, hold }, BODY, 1_000)).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a crash before the settle is recovered: the expired hold gives its credits back", async () => {
    await reserveAi(ctx({ credits: 4 }));
    expect(counter("month")).toMatchObject({ reserved: 4n });
    vi.setSystemTime(new Date(NOW.getTime() + AI_CALL_TTL_MS + 1));
    expect(await expireReservations()).toMatchObject({ expired: 1, releasedMinor: 4n });
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(reservations()[0]).toMatchObject({ status: "expired" });
  });

  it("a settle after the hold expired still charges the call, exactly once", async () => {
    const hold = await reserveAi(ctx({ credits: 4 }));
    vi.setSystemTime(new Date(NOW.getTime() + AI_CALL_TTL_MS + 1));
    await expireReservations();
    await hold.settle({ credits: 3, ref: { type: "inbox_suggest", id: "c1" } });
    expect(counter("month")).toMatchObject({ spent: 3n, reserved: 0n });
    expect(counter("day")).toMatchObject({ spent: 3n, reserved: 0n });
  });

  it("a settle whose reservation cannot be closed is still charged, and the sweep gives the hold back", async () => {
    const hold = await reserveAi(ctx({ credits: 2 }));
    emulateSql(h.db, { failClose: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await hold.settle({ credits: 2 });
    emulateSql(h.db);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hold not settled"));
    warn.mockRestore();
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 2 })]);
    expect(counter("month").spent).toBe(2n);
    vi.setSystemTime(new Date(NOW.getTime() + AI_CALL_TTL_MS + 1));
    await expireReservations();
    expect(counter("month")).toMatchObject({ spent: 2n, reserved: 0n });
  });
});

// =====================================================================================================================
describe("metered image and video providers (meteredProvider)", () => {
  it("holds the price, runs, and charges what the result costs", async () => {
    let reservedDuring = 0n;
    const file = await meteredProvider(ctx({ feature: "creative", credits: 5, ref: { type: "creative_asset", id: "a1" } }), async () => {
      reservedDuring = counter("month").reserved;
      return { fallback: false };
    });
    expect(file).toEqual({ fallback: false });
    expect(reservedDuring).toBe(5n);
    expect(counter("month")).toMatchObject({ spent: 5n, reserved: 0n });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 5, refType: "creative_asset", refId: "a1" })]);
  });

  it("a free placeholder fallback is charged nothing", async () => {
    await meteredProvider(ctx({ feature: "creative", credits: 5 }), async () => ({ fallback: true }), { charge: (f) => (f.fallback ? 0 : 5) });
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(usageRows()).toEqual([]);
  });

  it("a failed provider gives the hold back, and a used-up limit never runs it", async () => {
    await expect(meteredProvider(ctx({ feature: "creative", credits: 5 }), async () => Promise.reject(new Error("provider down")))).rejects.toThrow("provider down");
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    h.limits = { daily: null, monthly: 4n, plan: 4n, assistantRefusal: null };
    const run = vi.fn(async () => ({}));
    await expect(meteredProvider(ctx({ feature: "creative", credits: 5 }), run)).rejects.toMatchObject({ status: 402, code: "ai_quota" });
    expect(run).not.toHaveBeenCalled();
  });
});

// =====================================================================================================================
describe("billing/limits reserveCredits delegates to the gateway (4.10)", () => {
  it("holdCredits and the in-process maps are gone; reserveCredits keeps its signature", async () => {
    expect("holdCredits" in billingLimits).toBe(false);
    expect(billingLimits.reserveCredits.length).toBeGreaterThanOrEqual(2);
    const none = await billingLimits.reserveCredits(T, 0);
    expect(none.hold).toBeNull();
    none();
    const source = readFileSync(path.join(process.cwd(), "src/lib/billing/limits.ts"), "utf8");
    expect(source).not.toMatch(/new Map|holdCredits/);
  });

  it("holds on the shared counter as a person-asked feature (Creative Studio by default), so a stop does not block it", async () => {
    h.freeze = { workspace: "all", platform: "none" };
    const release = await billingLimits.reserveCredits(T, 2);
    expect(release.hold).toMatchObject({ feature: "creative", credits: 2, state: "open" });
    expect(counter("month")).toMatchObject({ reserved: 2n });
    // A caller that settles nothing but records its usage itself (Creative Studio) is counted exactly once.
    await recordUsage(T, "ai_credits", 2, { type: "creative_brief", id: "b1" });
    release();
    await vi.waitFor(() => expect(reservations()[0]).toMatchObject({ status: "released" }));
    expect(counter("month")).toMatchObject({ spent: 2n, reserved: 0n });
    expect(usageRows()).toHaveLength(1);
  });

  it("an automatic feature passed by the caller is stopped by 'Stop all spending'", async () => {
    h.freeze = { workspace: "all", platform: "none" };
    await expect(billingLimits.reserveCredits(T, 1, { feature: "agent_reply", actor: BOT })).rejects.toMatchObject({ code: "spend.frozen" });
  });

  it("the AI agent awaits reserveCredits in admit() and keeps its hourly reply cap", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/ai-agent/index.ts"), "utf8");
    expect(source).toMatch(/async function admit\(/);
    expect(source).toMatch(/await reserveCredits\(tenantId, CREDIT_COST\.text/);
    expect(source).toMatch(/maxRepliesPerHour\(\)/);
    expect(source).not.toMatch(/holdCredits/);
  });
});

// =====================================================================================================================
describe("callers hand the chat to a person on a refusal", () => {
  it("the chatbot's AI escalation check hands over when the AI limit is used up or spending is stopped, and is charged otherwise", async () => {
    fetchMock.mockImplementation(async () => reply({ input_tokens: 40, output_tokens: 1 }, "claude-sonnet-5-5", "HUMAN"));
    await expect(classifyWithAi(T, "I want to talk to someone about my order")).resolves.toEqual({ kind: "human_request", source: "ai" });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 1, refType: "chatbot_escalation", inputTokens: 40, outputTokens: 1 })]);

    h.limits = { daily: null, monthly: 1n, plan: 1n, assistantRefusal: null };
    await expect(classifyWithAi(T, "this is not what I asked for at all")).resolves.toBe(AI_UNAVAILABLE_SIGNAL);
    h.limits = { daily: null, monthly: 100n, plan: 100n, assistantRefusal: null };
    h.freeze = { workspace: "all", platform: "none" };
    await expect(classifyWithAi(T, "this is not what I asked for at all")).resolves.toBe(AI_UNAVAILABLE_SIGNAL);
    expect(AI_UNAVAILABLE_SIGNAL).toEqual({ kind: "human_request", source: "ai" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================================================================
describe("usage figures", () => {
  it("reads tokens and the model from a response, ignoring anything that is not a count", () => {
    expect(usageFromResponse({ model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 4.7 } })).toEqual({ inputTokens: 10, outputTokens: 4, model: "claude-opus-5-5" });
    expect(usageFromResponse({ usage: { input_tokens: -1, output_tokens: "9" } })).toEqual({ inputTokens: null, outputTokens: null, model: null });
    expect(usageFromResponse(null)).toEqual(NO_USAGE);
  });

  it("adds rounds together, the later model winning", () => {
    expect(addUsage({ inputTokens: 1, outputTokens: null, model: "a" }, { inputTokens: 2, outputTokens: 3, model: null })).toEqual({ inputTokens: 3, outputTokens: 3, model: "a" });
    expect(addUsage(null, undefined)).toEqual(NO_USAGE);
  });

  it("recordUsage stores tokens and model, clamps them, and skips zero amounts", async () => {
    await recordUsage(T, "ai_credits", 1, { type: "x", id: "1" }, { inputTokens: 3_000_000_000, outputTokens: 12.9, model: "m".repeat(150), counted: true });
    await recordUsage(T, "ai_credits", 0, { type: "x", id: "2" }, { counted: true });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 1, inputTokens: 2_147_483_647, outputTokens: 12, model: "m".repeat(100) })]);
  });
});
