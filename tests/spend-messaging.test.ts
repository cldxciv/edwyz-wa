import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, RawCall, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  limits: null as null | { daily: bigint | null; monthly: bigint | null; rules: { assistantRefusal: unknown; humanRefusal: unknown } },
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
// The limits a workspace has are covered by spend-allowances.test.ts; here each test states them.
vi.mock("@/lib/spend/allowances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spend/allowances")>()),
  effectiveLimits: vi.fn(async () => h.limits),
}));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { clearRateCard, currencyLockedCopy, getRateCard, parseRateCard, rateFor as cardRate, RATECARD_KEY, saveRateCard, serviceRateMissing, type RateCardData } from "@/lib/admin/ratecard";
import { formToBody, RateCardEditor, rescaleForm, serviceMissing } from "@/components/admin/RateCardEditor";
import { resetSpendStateCache } from "@/lib/spend/kill";
import { currentPermit, isMintedPermit } from "@/lib/spend/permit";
import { estimateBreakdown, estimateMessage, isFreeEntryPoint, rateFor, unitsToMinorCeil } from "@/lib/spend/messaging/estimate";
import { breakerOutcome, exhaustedOutcome, finishSend, freezeOutcome, messagingGate, releaseMessageSpend, resetGateCaches, templateOutcome, type GateDecision, type GateMessage } from "@/lib/spend/messaging/gate";
import { SEND_ORIGINS, type SendOrigin } from "@/lib/spend/messaging/origin";
import { runSettlement, settlementFor } from "@/lib/spend/messaging/settle";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z"); // 12:00 in Asia/Kolkata
const TODAY = "2026-10-28";
const MONTH = "2026-10";
const DAY_MS = 86_400_000;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

const CARD: RateCardData = {
  currency: "INR",
  scale: 0,
  note: "",
  updatedAt: null,
  rates: {
    IN: { MARKETING: 100, UTILITY: 20, AUTHENTICATION: 15, SERVICE: 10 },
    GB: { AUTHENTICATION: 40 },
    "*": { MARKETING: 300, UTILITY: 50 },
  },
};

/** Emulates the counter and reservation statements on the fake's rows, atomically (as Postgres re-checks each row after its lock). */
function emulateSql(db: FakeSpendDb) {
  db.onRaw((call: RawCall) => {
    const rows = db.rows("spendCounter");
    const find = (t: unknown, pot: unknown, kind: string, key: unknown) => rows.find((r) => r.tenantId === t && r.pot === pot && r.periodKind === kind && r.periodKey === key);
    if (call.sql.includes("spend.counter.reserve")) {
      const [t, pot, day, month, c, dl, ml] = call.values as [string, string, string, string, bigint, bigint | null, bigint | null];
      const d = find(t, pot, "day", day);
      const m = find(t, pot, "month", month);
      const fits = (r: Row | undefined, lim: bigint | null) => !!r && (lim === null || (r.spentMinor as bigint) + (r.reservedMinor as bigint) + c <= lim);
      const dOk = fits(d, dl);
      const mOk = fits(m, ml);
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
    const reservation = (id: unknown) => db.rows("spendReservation").find((x) => x.id === id);
    if (call.sql.includes("spend.reservation.consume")) {
      const [id, c, now] = call.values as [string, bigint, Date];
      const r = reservation(id);
      if (!r || r.status !== "held" || (r.expiresAt as Date).getTime() <= now.getTime() || (r.consumedMinor as bigint) + c > (r.amountMinor as bigint)) return [];
      r.consumedMinor = (r.consumedMinor as bigint) + c;
      return [{ ...r, amountMinor: String(r.amountMinor), consumedMinor: String(r.consumedMinor) }];
    }
    if (call.sql.includes("spend.reservation.unconsume")) {
      const [id, c] = call.values as [string, bigint];
      const r = reservation(id);
      if (!r || r.status !== "held" || (r.consumedMinor as bigint) < c) return [];
      r.consumedMinor = (r.consumedMinor as bigint) - c;
      return [{ id }];
    }
    if (call.sql.includes("spend.messaging.phone_day")) {
      const [t, phone, day] = call.values as [string, string, string];
      const conv = new Set(db.rows("conversation").filter((c) => c.phoneNumberId === phone).map((c) => c.id));
      const total = db
        .rows("message")
        .filter((m) => m.tenantId === t && conv.has(m.conversationId) && m.pricingSettledAt && (m.spendDay as Date | null)?.toISOString().slice(0, 10) === day)
        .reduce((a, m) => a + BigInt((m.costMinor as bigint | null) ?? 0n), 0n);
      return [{ total: String(total) }];
    }
    return undefined;
  });
}

const counter = (kind: "day" | "month", key: string) => h.db.rows("spendCounter").find((r) => r.tenantId === T && r.pot === "messaging" && r.periodKind === kind && r.periodKey === key);
const reserved = (kind: "day" | "month" = "month", key = kind === "day" ? TODAY : MONTH) => (counter(kind, key)?.reservedMinor as bigint | undefined) ?? 0n;
const spent = (kind: "day" | "month" = "month", key = kind === "day" ? TODAY : MONTH) => (counter(kind, key)?.spentMinor as bigint | undefined) ?? 0n;

function limits(monthly: bigint | null, daily: bigint | null = null, rules: { assistantRefusal?: unknown; humanRefusal?: unknown } = {}) {
  h.limits = { daily, monthly, rules: { assistantRefusal: rules.assistantRefusal ?? (monthly === null ? { reason: "no_limit", code: null } : null), humanRefusal: rules.humanRefusal ?? null } };
}

function seedBase(opts: { card?: RateCardData | null } = {}) {
  h.db.reset();
  emulateSql(h.db);
  resetGateCaches();
  resetSpendStateCache();
  h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata" }]);
  if (opts.card !== null) h.db.seed("platformSetting", [{ key: RATECARD_KEY, value: opts.card ?? CARD }]);
  h.db.seed("template", [{ id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", category: "MARKETING", status: "approved" }]);
  h.db.seed("template", [{ id: "tp2", tenantId: T, wabaRefId: "w1", name: "notice", language: "en", category: "UTILITY", status: "approved" }]);
  limits(100_000n);
}

let ids = 0;
function message(over: Omit<Partial<GateMessage>, "conversation"> & { conversation?: Partial<GateMessage["conversation"]> } = {}): GateMessage {
  const id = over.id ?? `m${++ids}`;
  const { conversation, ...rest } = over;
  h.db.seed("message", [{ id, tenantId: T, conversationId: "cv1", status: "queued", direction: "outbound" }]);
  return {
    id,
    type: "template",
    conversationId: "cv1",
    ...rest,
    conversation: {
      lastInboundAt: null,
      referral: null,
      createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
      contact: { phone: "+919876543210", bsuid: null },
      phoneNumber: { id: "ph1", phoneNumberId: "meta_ph1", wabaRefId: "w1", status: "connected" },
      ...conversation,
    },
  };
}

const templateJob = (origin: SendOrigin, name = "promo", over: Record<string, unknown> = {}) => ({
  messageId: "x",
  tenantId: T,
  origin,
  category: name === "promo" ? "MARKETING" : "UTILITY",
  wabaRefId: "w1",
  template: { name, language: "en", components: [] },
  ...over,
});

const gate = (job: Record<string, unknown>, m: GateMessage = message()) => messagingGate(T, job, m, { now: NOW });
const brief = (d: GateDecision) =>
  d.action === "send" ? (d.overLimit ? "send_over" : "send") : d.action === "fail" ? (d.handoff ? "fail_handoff" : `fail:${d.code}`) : `hold:${d.reason}`;

beforeEach(() => {
  vi.stubEnv("SPEND_ENFORCE", "enforce");
  seedBase();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ===== The 4.9 table, cell by cell, end to end through messagingGate =====

type Condition = "freeze_assistants" | "freeze_all" | "platform_all" | "yellow" | "red" | "restricted" | "waba_disabled" | "exhausted";
const CONDITIONS: Condition[] = ["freeze_assistants", "freeze_all", "platform_all", "yellow", "red", "restricted", "waba_disabled", "exhausted"];

function apply(condition: Condition) {
  const breaker = (kind: string, scopeType: string, scopeId: string, effect: string) =>
    h.db.seed("spendBreaker", [{ id: `sb_${kind}`, tenantId: T, kind, scopeType, scopeId, effect, state: "tripped", reason: "A safety stop.", trippedAt: new Date(NOW.getTime() - 60_000) }]);
  switch (condition) {
    case "freeze_assistants":
      h.db.rows("spendControl")[0].freeze = "assistants";
      break;
    case "freeze_all":
      h.db.rows("spendControl")[0].freeze = "all";
      break;
    case "platform_all":
      h.db.seed("platformSetting", [{ key: "spend:platform", value: { freeze: "all", reason: "incident" } }]);
      break;
    case "yellow":
      breaker("wa_quality_yellow", "phone", "ph1", "block_marketing");
      break;
    case "red":
      breaker("wa_quality_red", "phone", "ph1", "block_automated");
      break;
    case "restricted":
      breaker("wa_restricted", "waba", "w1", "block_automated");
      break;
    case "waba_disabled":
      breaker("waba_disabled", "waba", "w1", "block_automated");
      break;
    case "exhausted":
      limits(50n);
      break;
  }
}

type Row8 = [string, string, string, string, string, string, string, string];
const H = "hold:spending_stopped";
const Q = "hold:number_quality";
const R = "hold:number_restricted";
const W = "hold:waba_disabled";
const PERSON: Row8 = ["send", "send", "send", "send", "send", "send", "send", "send_over"];
const AUTOMATED: Row8 = ["send", H, H, Q, Q, R, W, "hold:messaging_limit"];
const EXPECTED: Record<SendOrigin, Row8> = {
  human: PERSON,
  approval: PERSON,
  eddy: PERSON,
  consent: PERSON,
  system_notify: ["send", "send", "send", "send", Q, R, W, "send_over"],
  admin_test: ["send", "send", H, "send", Q, R, W, "fail:messaging_limit"],
  api: AUTOMATED,
  mcp: AUTOMATED,
  broadcast: AUTOMATED,
  automation: AUTOMATED,
  lead_sequence: AUTOMATED,
  commerce: AUTOMATED,
  unknown: AUTOMATED,
  chatbot: ["send", H, H, Q, Q, R, W, "fail_handoff"],
  ai_reply: ["send", H, H, Q, Q, R, W, "fail_handoff"],
  assistant: [H, H, H, Q, Q, R, W, "fail:messaging_limit"],
};

describe("the 4.9 table: every origin under every condition (MARKETING template, window closed)", () => {
  it("covers every origin", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SEND_ORIGINS].sort());
  });
  for (const origin of SEND_ORIGINS) {
    it.each(CONDITIONS.map((c, i) => [c, EXPECTED[origin][i]] as const))(`${origin} under %s: %s`, async (condition, expected) => {
      apply(condition);
      const decision = await gate(templateJob(origin));
      expect(brief(decision)).toBe(expected);
    });
  }

  it("quality YELLOW holds only MARKETING: a utility template from an automation still goes out", async () => {
    apply("yellow");
    expect(brief(await gate(templateJob("automation", "notice")))).toBe("send");
    expect(brief(await gate(templateJob("automation", "promo")))).toBe(Q);
  });

  it("a restricted account holds templates outside an open window only: an in-window automatic reply still goes out", async () => {
    apply("restricted");
    const inWindow = message({ conversation: { lastInboundAt: new Date(NOW.getTime() - 3_600_000) } });
    expect(brief(await gate(templateJob("automation"), inWindow))).toBe("send");
    expect(brief(await gate({ messageId: "x", tenantId: T, origin: "chatbot", category: "SERVICE" }, message({ type: "text", conversation: { lastInboundAt: new Date(NOW.getTime() - 3_600_000) } })))).toBe("send");
  });

  it("a number Meta disconnected holds automatic sends but not a person's", async () => {
    const off = message({ conversation: { phoneNumber: { id: "ph1", phoneNumberId: "meta_ph1", wabaRefId: "w1", status: "DISCONNECTED" } } });
    expect(brief(await gate(templateJob("automation"), off))).toBe("hold:number_not_connected");
    expect(brief(await gate(templateJob("human"), off))).toBe("send");
  });

  it("a breaker on another number does not touch this one, and one past its auto-clear time no longer holds", async () => {
    h.db.seed("spendBreaker", [{ id: "sb1", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph_other", effect: "block_automated", state: "tripped", reason: "x", trippedAt: NOW }]);
    h.db.seed("spendBreaker", [{ id: "sb2", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph1", effect: "block_automated", state: "tripped", reason: "x", trippedAt: NOW, autoClearAt: new Date(NOW.getTime() - 1) }]);
    expect(brief(await gate(templateJob("automation")))).toBe("send");
  });

  it("writes one aggregated messaging.blocked ledger row per reason and hour, not one per message", async () => {
    apply("freeze_all");
    for (let i = 0; i < 5; i++) await gate(templateJob("automation"));
    const rows = h.db.rows("spendLedger").filter((r) => r.action === "messaging.blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "refused", reasonCodes: ["spending_stopped"], observe: false });
  });
});

describe("the pure columns", () => {
  it("freezes: assistants stop under any freeze, people never", () => {
    expect(freezeOutcome("assistant", { workspace: "assistants", platform: "none" })).toEqual({ action: "hold", reason: "spending_stopped" });
    expect(freezeOutcome("automation", { workspace: "assistants", platform: "none" })).toEqual({ action: "send" });
    expect(freezeOutcome("eddy", { workspace: "all", platform: "all" })).toEqual({ action: "send" });
    expect(freezeOutcome("admin_test", { workspace: "all", platform: "none" })).toEqual({ action: "send" });
    expect(freezeOutcome("system_notify", { workspace: "all", platform: "all" })).toEqual({ action: "send" });
  });
  it("templates: paused, disabled and rejected fail everyone; flagged holds marketing broadcasts and assistants only", () => {
    for (const status of ["paused", "disabled", "rejected", "PAUSED"]) for (const o of SEND_ORIGINS) expect(templateOutcome(o, "UTILITY", status)).toEqual({ action: "fail", code: "template_blocked" });
    expect(templateOutcome("broadcast", "MARKETING", "flagged")).toEqual({ action: "hold", reason: "template_flagged" });
    expect(templateOutcome("broadcast", "UTILITY", "flagged")).toEqual({ action: "send" });
    expect(templateOutcome("assistant", "UTILITY", "flagged")).toEqual({ action: "hold", reason: "template_flagged" });
    expect(templateOutcome("automation", "MARKETING", "flagged")).toEqual({ action: "send" });
    expect(templateOutcome("human", "MARKETING", "approved")).toEqual({ action: "send" });
  });
  it("breakers: a waba_disabled stop names its reason; notify-only stops are ignored", () => {
    const input = { marketing: false, isTemplate: false, windowOpen: true, sendable: true };
    expect(breakerOutcome("automation", { ...input, breakers: [{ kind: "waba_disabled", effect: "block_automated" }] })).toEqual({ action: "hold", reason: "waba_disabled" });
    expect(breakerOutcome("automation", { ...input, breakers: [{ kind: "x", effect: "notify_only" }] })).toEqual({ action: "send" });
    expect(breakerOutcome("consent", { ...input, breakers: [{ kind: "waba_disabled", effect: "block_all_outbound" }] })).toEqual({ action: "send" });
  });
  it("pot exhausted: chatbot and AI agent replies hand off, automations wait, assistants and admin tests fail", () => {
    expect(exhaustedOutcome("chatbot")).toEqual({ action: "fail", code: "messaging_limit", handoff: true });
    expect(exhaustedOutcome("ai_reply")).toEqual({ action: "fail", code: "messaging_limit", handoff: true });
    expect(exhaustedOutcome("lead_sequence")).toEqual({ action: "hold", reason: "messaging_limit" });
    expect(exhaustedOutcome("unknown")).toEqual({ action: "hold", reason: "messaging_limit" });
    expect(exhaustedOutcome("assistant")).toEqual({ action: "fail", code: "messaging_limit", handoff: false });
  });
});

describe("template status at send time", () => {
  it("a template paused while the message was queued fails for every origin, people included", async () => {
    h.db.rows("template").find((t) => t.id === "tp1")!.status = "paused";
    for (const origin of SEND_ORIGINS) {
      const d = await gate(templateJob(origin));
      expect(d).toMatchObject({ action: "fail", code: "template_blocked" });
    }
    expect(reserved()).toBe(0n);
  });
  it("is read under the sending number's WABA: the same name paused under another WABA does not block", async () => {
    h.db.seed("template", [{ id: "tp9", tenantId: T, wabaRefId: "w2", name: "promo", language: "en", category: "MARKETING", status: "paused" }]);
    expect(brief(await gate(templateJob("automation")))).toBe("send");
  });
  it("prices at the template's current category (a category change re-estimates) and an unknown template at MARKETING", async () => {
    h.db.rows("template").find((t) => t.id === "tp2")!.category = "MARKETING";
    const d = await gate(templateJob("automation", "notice"));
    expect(d.action === "send" && d.spend.estimateMinor).toBe(100n);
    const unknown = await gate(templateJob("automation", "nope", { category: undefined }));
    expect(unknown.category).toBe("MARKETING");
  });
});

describe("cost: the lock-free per-message reservation", () => {
  it("cannot overdraw under parallel calls: exactly the messages that fit are sent, the rest wait", async () => {
    limits(1_000n); // 10 messages of ₹1
    // The rows exist already (the fake does not model a second INSERT waiting on the first, as Postgres does).
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "messaging", periodKind: "day", periodKey: TODAY, currency: "INR", reservedMinor: 0n, spentMinor: 0n },
      { tenantId: T, pot: "messaging", periodKind: "month", periodKey: MONTH, currency: "INR", reservedMinor: 0n, spentMinor: 0n },
    ]);
    const decisions = await Promise.all(Array.from({ length: 25 }, () => gate(templateJob("automation"))));
    expect(decisions.filter((d) => d.action === "send")).toHaveLength(10);
    expect(decisions.filter((d) => d.action === "hold" && d.reason === "messaging_limit")).toHaveLength(15);
    expect(reserved("month")).toBe(1_000n);
    expect(reserved("day")).toBe(1_000n);
  });

  it("checks the daily limit too, and a day that runs out waits for local midnight at most 15 minutes at a time", async () => {
    limits(null, 150n, { assistantRefusal: null });
    expect(brief(await gate(templateJob("broadcast")))).toBe("send");
    const second = await gate(templateJob("broadcast"));
    expect(second).toMatchObject({ action: "hold", reason: "messaging_limit" });
    if (second.action === "hold") expect(second.retryAt.getTime() - NOW.getTime()).toBe(15 * 60_000);
    const bot = await gate(templateJob("chatbot"));
    expect(bot).toMatchObject({ action: "fail", code: "messaging_limit", handoff: true, period: "day" });
  });

  it("human-class sends always go out and are always counted, flagged over_limit past the limit", async () => {
    limits(50n);
    for (const origin of ["human", "approval", "consent", "system_notify", "eddy"] as const) {
      const d = await gate(templateJob(origin));
      expect(d).toMatchObject({ action: "send", overLimit: true });
    }
    expect(reserved()).toBe(500n);
  });

  it("stamps the Message with origin, category, estimate, day and spendState reserved", async () => {
    const m = message();
    await gate(templateJob("commerce"), m);
    expect(h.db.rows("message").find((r) => r.id === m.id)).toMatchObject({
      origin: "commerce",
      pricingCategory: "MARKETING",
      estCostMinor: 100n,
      spendState: "reserved",
      spendDay: new Date(`${TODAY}T00:00:00Z`),
      reservationId: null,
    });
  });

  it("a queue retry reuses the reservation it already holds instead of reserving again", async () => {
    const m = message();
    const first = await gate(templateJob("automation"), m);
    expect(first.action).toBe("send");
    const again = await gate(templateJob("automation"), { ...m, spendState: "reserved", spendDay: new Date(`${TODAY}T00:00:00Z`), estCostMinor: 100n });
    expect(again).toMatchObject({ action: "send", spend: { mode: "counter", estimateMinor: 100n, keys: { day: TODAY, month: MONTH } } });
    expect(reserved()).toBe(100n);
  });

  it("a hold after an earlier attempt reserved gives the reservation back", async () => {
    const m = message();
    await gate(templateJob("automation"), m);
    expect(reserved()).toBe(100n);
    h.db.rows("spendControl")[0].freeze = "all";
    resetSpendStateCache();
    const held = await gate(templateJob("automation"), { ...m, spendState: "reserved", spendDay: new Date(`${TODAY}T00:00:00Z`), estCostMinor: 100n });
    expect(held).toMatchObject({ action: "hold", reason: "spending_stopped", released: true });
    expect(reserved()).toBe(0n);
    expect(h.db.rows("message").find((r) => r.id === m.id)?.spendState).toBe("released");
  });

  it("observe mode counts and records what it would have held, but sends (assistants stay enforced)", async () => {
    vi.stubEnv("SPEND_ENFORCE", "observe");
    limits(50n);
    const d = await gate(templateJob("automation"));
    expect(d).toMatchObject({ action: "send", observed: true, overLimit: true });
    expect(reserved()).toBe(100n);
    expect(h.db.rows("spendLedger").find((r) => r.action === "messaging.blocked")).toMatchObject({ phase: "refused", observe: true });
    expect(brief(await gate(templateJob("assistant")))).toBe("fail:messaging_limit");
  });

  it("an assistant is refused when the WhatsApp limit is Not set; people and automations are counted, not limited", async () => {
    limits(null);
    expect(brief(await gate(templateJob("assistant")))).toBe("fail:messaging_limit");
    expect(brief(await gate(templateJob("automation")))).toBe("send");
    expect(reserved()).toBe(100n);
  });

  it("an unknown ceiling on new-workspace limits holds automatic sends like a used-up limit", async () => {
    limits(100_000n, null, { humanRefusal: { reason: "unknown_ceiling", code: "spend.currency" } });
    expect(brief(await gate(templateJob("automation")))).toBe("hold:messaging_limit");
    expect(brief(await gate(templateJob("human")))).toBe("send");
  });

  it("a free entry point (click-to-WhatsApp ad less than 72 hours ago) is reserved at 0 and touches no counter", async () => {
    const m = message({ conversation: { referral: { sourceId: "ad1" }, createdAt: new Date(NOW.getTime() - DAY_MS) } });
    const d = await gate(templateJob("automation"), m);
    expect(d).toMatchObject({ action: "send", spend: { mode: "none", estimateMinor: 0n } });
    expect(reserved()).toBe(0n);
    expect(h.db.rows("message").find((r) => r.id === m.id)).toMatchObject({ estCostMinor: 0n, spendState: "reserved" });
  });

  it("with no rate card nothing is invented: the send is counted at 0, and an assistant is refused", async () => {
    seedBase({ card: null });
    const d = await gate(templateJob("automation"));
    expect(d).toMatchObject({ action: "send", spend: { mode: "none", estimateMinor: 0n, currency: null } });
    expect(brief(await gate(templateJob("assistant")))).toBe("fail:messaging_limit");
  });

  it("mints a single-use msg_send permit for <phoneNumberId>/messages and runs the call inside it", async () => {
    const d = await gate(templateJob("automation"));
    if (d.action !== "send") throw new Error("expected send");
    expect(isMintedPermit(d.permit)).toBe(true);
    expect(d.permit).toMatchObject({ type: "msg", tenantId: T, paths: ["meta_ph1/messages"], maxUses: 1, phoneNumberId: "meta_ph1" });
    expect(d.permit.expiresAt.getTime() - d.permit.issuedAt.getTime()).toBe(2 * 60_000);
    expect(await d.run(async () => currentPermit())).toBe(d.permit);
    expect(currentPermit()).toBeUndefined();
  });
});

describe("after the POST: settle, settle an ambiguous send at its estimate, release a failure", () => {
  const sendOne = async () => {
    const d = await gate(templateJob("automation"));
    if (d.action !== "send") throw new Error("expected send");
    return d;
  };
  it("a sent message moves its estimate from reserved to spent", async () => {
    await finishSend((await sendOne()).spend, "sent");
    expect([reserved(), spent(), reserved("day"), spent("day")]).toEqual([0n, 100n, 0n, 100n]);
  });
  it("an ambiguous send (Meta may have it) is settled at its estimate, not released", async () => {
    await finishSend((await sendOne()).spend, "ambiguous");
    expect([reserved(), spent()]).toEqual([0n, 100n]);
  });
  it("a failed send gives the estimate back", async () => {
    await finishSend((await sendOne()).spend, "failed");
    expect([reserved(), spent()]).toEqual([0n, 0n]);
  });
});

describe("bulk reservations", () => {
  const hold = (amount: bigint, over: Row = {}) =>
    h.db.seed("spendReservation", [
      { id: "sr_b1", tenantId: T, pot: "messaging", currency: "INR", subjectType: "broadcast", subjectId: "b1", amountMinor: amount, consumedMinor: 0n, status: "held", dayKey: "2026-10-27", monthKey: MONTH, expiresAt: new Date(NOW.getTime() + DAY_MS), correlationId: "c1", ...over },
    ]);
  const bulkCounters = (amount: bigint) =>
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "messaging", periodKind: "day", periodKey: "2026-10-27", currency: "INR", reservedMinor: amount, spentMinor: 0n },
      { tenantId: T, pot: "messaging", periodKind: "month", periodKey: MONTH, currency: "INR", reservedMinor: amount, spentMinor: 0n },
    ]);

  it("consume from the hold on the hold's own day; an exhausted hold falls back to per-message reservations, never unreserved", async () => {
    hold(250n);
    bulkCounters(250n);
    const job = templateJob("broadcast", "promo", { reservationId: "sr_b1" });
    const a = await gate(job);
    const b = await gate(job);
    expect(a).toMatchObject({ action: "send", spend: { mode: "bulk", reservationId: "sr_b1", keys: { day: "2026-10-27", month: MONTH } } });
    expect(b).toMatchObject({ action: "send", spend: { mode: "bulk" } });
    expect(h.db.rows("spendReservation")[0].consumedMinor).toBe(200n);
    const c = await gate(job); // 300 > 250: the hold is used up
    expect(c).toMatchObject({ action: "send", spend: { mode: "counter", reservationId: null, keys: { day: TODAY, month: MONTH } } });
    expect(reserved("day")).toBe(100n);
    expect(reserved("month")).toBe(350n);
  });

  it("the fallback still respects the limit: a broadcast past its hold and the limit waits", async () => {
    hold(100n);
    bulkCounters(100n);
    limits(150n);
    const job = templateJob("broadcast", "promo", { reservationId: "sr_b1" });
    expect(brief(await gate(job))).toBe("send");
    expect(brief(await gate(job))).toBe("hold:messaging_limit");
  });

  it("a closed or expired hold also falls back", async () => {
    hold(1_000n, { status: "released" });
    const d = await gate(templateJob("broadcast", "promo", { reservationId: "sr_b1" }));
    expect(d).toMatchObject({ action: "send", spend: { mode: "counter" } });
  });

  it("a failed message gives its estimate back to the open hold for the rest of the broadcast", async () => {
    hold(250n);
    bulkCounters(250n);
    const d = await gate(templateJob("broadcast", "promo", { reservationId: "sr_b1" }));
    if (d.action !== "send") throw new Error("expected send");
    await finishSend(d.spend, "failed");
    expect(h.db.rows("spendReservation")[0].consumedMinor).toBe(0n);
    expect(reserved("month")).toBe(250n);
    // Sent ones move from the hold's reservation to spent on the hold's day.
    const e = await gate(templateJob("broadcast", "promo", { reservationId: "sr_b1" }));
    if (e.action !== "send") throw new Error("expected send");
    await finishSend(e.spend, "sent");
    expect([reserved("day", "2026-10-27"), spent("day", "2026-10-27")]).toEqual([150n, 100n]);
  });
});

describe("releaseMessageSpend: a message that ends unsent gives back what an earlier attempt held", () => {
  const spendOf = (id: string) => {
    const r = h.db.rows("message").find((x) => x.id === id)!;
    return { id, estCostMinor: r.estCostMinor as bigint, spendState: r.spendState as string, spendDay: r.spendDay as Date, reservationId: (r.reservationId as string | null) ?? null };
  };

  it("a per-message reservation goes back to its own day and month, once, and the message reads released", async () => {
    const m = message();
    expect((await gate(templateJob("automation"), m)).action).toBe("send");
    expect([reserved(), reserved("day")]).toEqual([100n, 100n]);
    expect(await releaseMessageSpend(T, spendOf(m.id))).toBe(true);
    expect([reserved(), reserved("day"), spent()]).toEqual([0n, 0n, 0n]);
    expect(spendOf(m.id).spendState).toBe("released");
    expect(await releaseMessageSpend(T, spendOf(m.id))).toBe(false);
    expect(reserved()).toBe(0n);
  });

  it("a bulk message gives its estimate back to the hold it came from", async () => {
    h.db.seed("spendReservation", [
      { id: "sr_r", tenantId: T, pot: "messaging", currency: "INR", subjectType: "broadcast", subjectId: "b9", amountMinor: 300n, consumedMinor: 0n, status: "held", dayKey: TODAY, monthKey: MONTH, expiresAt: new Date(NOW.getTime() + DAY_MS), correlationId: "c9" },
    ]);
    const m = message();
    expect((await gate(templateJob("broadcast", "promo", { reservationId: "sr_r" }), m)).action).toBe("send");
    expect(h.db.rows("spendReservation")[0].consumedMinor).toBe(100n);
    expect(await releaseMessageSpend(T, spendOf(m.id))).toBe(true);
    expect(h.db.rows("spendReservation")[0].consumedMinor).toBe(0n);
  });

  it("a message that holds nothing is left alone", async () => {
    const m = message();
    expect(await releaseMessageSpend(T, { id: m.id, estCostMinor: null, spendState: null, spendDay: null, reservationId: null })).toBe(false);
    expect(h.db.rows("message").find((x) => x.id === m.id)?.spendState).toBeUndefined();
  });
});

describe("the conservative estimate (estimateBreakdown and rateFor)", () => {
  it("prices a country's own row, then the * row, and an unpriced country at the highest rate of the category", () => {
    expect(rateFor(CARD, "IN", "MARKETING")).toMatchObject({ minor: 100n, basis: "country" });
    expect(rateFor(CARD, "BR", "MARKETING")).toMatchObject({ minor: 300n, basis: "country" }); // the * row
    expect(rateFor(CARD, "BR", "AUTHENTICATION")).toMatchObject({ minor: 40n, basis: "highest" }); // no * price: GB's 40 is the highest
    expect(rateFor(CARD, null, "MARKETING")).toMatchObject({ minor: 300n, basis: "highest" }); // unknown country
  });
  it("an unknown category counts as MARKETING", () => {
    expect(rateFor(CARD, "IN", "something_new")?.minor).toBe(100n);
    expect(estimateMessage({ card: CARD, category: "", contact: { phone: "+919800000000" } }).minor).toBe(100n);
  });
  it("prices +1 and +7 numbers at the highest of the countries sharing the code", () => {
    const card: RateCardData = { ...CARD, rates: { US: { MARKETING: 200 }, CA: { MARKETING: 250 }, RU: { MARKETING: 100 }, KZ: { MARKETING: 180 }, "*": { MARKETING: 150 } } };
    expect(estimateMessage({ card, category: "MARKETING", contact: { phone: "+14155550123" } })).toMatchObject({ minor: 250n, quote: { basis: "shared_code" } });
    expect(estimateMessage({ card, category: "MARKETING", contact: { phone: "+79161234567" } }).minor).toBe(180n);
    expect(estimateMessage({ card, category: "MARKETING", contact: { bsuid: "CA.123" } }).minor).toBe(250n);
    // Without a * row some +1 countries have no price, so the whole code is priced at the card's highest.
    const sparse: RateCardData = { ...card, rates: { US: { MARKETING: 200 }, CA: { MARKETING: 250 }, IN: { MARKETING: 400 } } };
    expect(rateFor(sparse, "US", "MARKETING")).toMatchObject({ minor: 400n, basis: "highest" });
  });
  it("prices SERVICE at the SERVICE rate, or the UTILITY rate while it is missing", () => {
    expect(rateFor(CARD, "IN", "SERVICE")).toMatchObject({ minor: 10n, serviceFallback: false });
    const noService: RateCardData = { ...CARD, rates: { IN: { MARKETING: 100, UTILITY: 20 }, "*": { UTILITY: 50 } } };
    expect(rateFor(noService, "IN", "SERVICE")).toMatchObject({ minor: 20n, serviceFallback: true });
    expect(serviceRateMissing(noService)).toBe(true);
    expect(serviceRateMissing(CARD)).toBe(false);
  });
  it("a category the card does not price at all takes its highest rate of any category", () => {
    const only: RateCardData = { ...CARD, rates: { IN: { MARKETING: 100, UTILITY: 20 } } };
    expect(rateFor(only, "IN", "AUTHENTICATION")).toMatchObject({ minor: 100n, basis: "highest_any" });
  });
  it("free entry point recipients are 0, and only within 72 hours of the referral", () => {
    expect(estimateMessage({ card: CARD, category: "MARKETING", contact: { phone: "+919800000000" }, freeEntryPoint: true }).minor).toBe(0n);
    expect(isFreeEntryPoint({ referral: { sourceId: "a" }, createdAt: new Date(NOW.getTime() - 71 * 3_600_000) }, NOW)).toBe(true);
    expect(isFreeEntryPoint({ referral: { sourceId: "a" }, createdAt: new Date(NOW.getTime() - 73 * 3_600_000) }, NOW)).toBe(false);
    expect(isFreeEntryPoint({ referral: null, createdAt: NOW }, NOW)).toBe(false);
  });
  it("scale 2 stores hundredths and rounds each message up: 11.5 paise is estimated at 12", () => {
    const card: RateCardData = { ...CARD, scale: 2, rates: { IN: { UTILITY: 1150 } } };
    expect(rateFor(card, "IN", "UTILITY")).toMatchObject({ units: 1150, scale: 2, minor: 12n });
    expect(unitsToMinorCeil(1100n, 2)).toBe(11n);
    expect(unitsToMinorCeil(0n, 2)).toBe(0n);
    const b = estimateBreakdown({ category: "UTILITY", countries: new Map([["IN", 10]]), card });
    expect(b).toMatchObject({ configured: true, totalMinor: 120, scale: 2 });
  });
  it("a bulk estimate never leaves recipients out: unpriced countries count at the highest rate, free ones at 0", () => {
    const b = estimateBreakdown({ category: "MARKETING", countries: new Map<string | null, number>([["IN", 2], [null, 1], ["US", 1]]), card: CARD, free: 3 });
    expect(b).toMatchObject({ configured: true, currency: "INR", unpricedCount: 0, freeCount: 3, count: 7 });
    if (!b.configured) throw new Error("configured");
    expect(b.totalMinor).toBe(2 * 100 + 300 + 300); // the unknown country and +1 (the * row covers every +1 country) at 300
    expect(b.highestRateCount).toBe(1);
    expect(estimateBreakdown({ category: "MARKETING", countries: new Map([["IN", 1]]), card: null }).configured).toBe(false);
  });
});

describe("settlement (runSettlement)", () => {
  const settledMessage = (over: Row): string => {
    const id = `s${++ids}`;
    h.db.seed("message", [
      {
        id,
        tenantId: T,
        conversationId: "cv1",
        direction: "outbound",
        status: "delivered",
        wamid: `wamid.${ids}`,
        createdAt: new Date(NOW.getTime() - DAY_MS),
        estCostMinor: 100n,
        billable: null,
        pricingCategory: "MARKETING",
        spendDay: new Date(`${TODAY}T00:00:00Z`),
        spendState: "settled",
        pricingSettledAt: null,
        ...over,
      },
    ]);
    return id;
  };
  const seedCounters = (day: string, month: string, spentMinor: bigint) =>
    h.db.seed("spendCounter", [
      { tenantId: T, pot: "messaging", periodKind: "day", periodKey: day, currency: "INR", reservedMinor: 0n, spentMinor },
      { tenantId: T, pot: "messaging", periodKind: "month", periodKey: month, currency: "INR", reservedMinor: 0n, spentMinor },
    ]);
  beforeEach(() => {
    h.db.seed("conversation", [{ id: "cv1", tenantId: T, contactId: "c1", phoneNumberId: "ph1" }]);
    h.db.seed("contact", [{ id: "c1", tenantId: T, phone: "+919876543210", bsuid: null }]);
  });

  it("is pure per message: billable priced, not billed 0, failed after accept 0, waits for pricing, keeps the estimate after 7 days", () => {
    const base = { status: "delivered", wamid: "w", createdAt: NOW, estCostMinor: 100n, billable: null, pricingCategory: "MARKETING" };
    const ctx = { card: CARD, contact: { phone: "+919800000000" }, now: NOW };
    expect(settlementFor({ ...base, billable: true, pricingCategory: "utility" }, ctx)).toEqual({ actualMinor: 20n, basis: "priced" });
    expect(settlementFor({ ...base, billable: false }, ctx)).toEqual({ actualMinor: 0n, basis: "not_billed" });
    expect(settlementFor({ ...base, status: "failed" }, ctx)).toEqual({ actualMinor: 0n, basis: "failed_after_accept" });
    expect(settlementFor(base, ctx)).toBeNull();
    expect(settlementFor({ ...base, status: "failed", wamid: null }, ctx)).toBeNull(); // ambiguous: waits
    expect(settlementFor({ ...base, createdAt: new Date(NOW.getTime() - 7 * DAY_MS) }, ctx)).toEqual({ actualMinor: 100n, basis: "kept_estimate" });
  });

  it("applies Σ(actual - estimate) once, on each message's own day and month, with one ledger row", async () => {
    const at = new Date("2026-11-01T06:00:00Z");
    seedCounters("2026-10-31", "2026-10", 300n);
    seedCounters("2026-11-01", "2026-11", 0n);
    settledMessage({ spendDay: new Date("2026-10-31T00:00:00Z"), billable: false }); // free entry point: 100 back
    settledMessage({ spendDay: new Date("2026-10-31T00:00:00Z"), status: "failed" }); // failed after Meta accepted it: 100 back
    settledMessage({ spendDay: new Date("2026-10-31T00:00:00Z"), billable: true, pricingCategory: "UTILITY" }); // 20 instead of 100
    const waiting = settledMessage({ spendDay: new Date("2026-10-31T00:00:00Z"), createdAt: new Date("2026-10-31T10:00:00Z") }); // still waiting for pricing
    const out = await runSettlement({ now: at });
    expect(out).toMatchObject({ scanned: 3, settled: 3, waiting: 0 });
    expect(h.db.rows("message").find((m) => m.id === waiting)).toMatchObject({ spendState: "settled", pricingSettledAt: null });
    expect(out.tenants[0]).toMatchObject({ tenantId: T, settled: 3, deltaMinor: -280n, days: { "2026-10-31": -280n } });
    expect(spent("day", "2026-10-31")).toBe(20n);
    expect(spent("month", "2026-10")).toBe(20n);
    expect(spent("month", "2026-11")).toBe(0n);
    const ledger = h.db.rows("spendLedger").filter((r) => r.action === "messaging.settlement");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ phase: "reconciled", amountMinor: -280n, currency: "INR", actorType: "system" });
    expect(ledger[0].reason).toMatch(/3 WhatsApp messages settled with Meta's prices: ₹2\.80 went back to your WhatsApp limit\./);
    const settledRows = h.db.rows("message").filter((m) => m.pricingSettledAt);
    expect(settledRows.map((m) => m.costMinor).sort()).toEqual([0n, 0n, 20n]);

    // A second run finds nothing new: pricingSettledAt is set once.
    const again = await runSettlement({ now: at });
    expect(again.settled).toBe(0);
    expect(spent("month", "2026-10")).toBe(20n);
  });

  it("a backlog of messages still waiting for pricing never starves newer priced ones out of the batch", async () => {
    seedCounters(TODAY, MONTH, 100n);
    for (let i = 0; i < 5; i++) settledMessage({ createdAt: new Date(NOW.getTime() - 3 * DAY_MS) }); // older, no pricing yet
    const priced = settledMessage({ createdAt: new Date(NOW.getTime() - 3_600_000), billable: false });
    const out = await runSettlement({ now: NOW, limit: 2 });
    expect(out).toMatchObject({ scanned: 1, settled: 1 });
    expect(h.db.rows("message").find((m) => m.id === priced)).toMatchObject({ costMinor: 0n });
    expect(spent()).toBe(0n);
  });

  it("keeps the estimate of a message that never got pricing in 7 days, and of an ambiguous send", async () => {
    seedCounters(TODAY, MONTH, 200n);
    settledMessage({ createdAt: new Date(NOW.getTime() - 8 * DAY_MS) });
    settledMessage({ createdAt: new Date(NOW.getTime() - 8 * DAY_MS), status: "failed", wamid: null });
    const out = await runSettlement({ now: NOW });
    expect(out.settled).toBe(2);
    expect(out.tenants[0].deltaMinor).toBe(0n);
    expect(spent()).toBe(200n);
  });

  it("rewrites the SpendDaily phone row of the day with the settled total (SET, not added)", async () => {
    seedCounters(TODAY, MONTH, 100n);
    settledMessage({ billable: true, pricingCategory: "MARKETING" });
    await runSettlement({ now: NOW });
    await runSettlement({ now: NOW });
    const rows = h.db.rows("spendDaily");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: T, pot: "messaging", scopeType: "phone", scopeId: "ph1", origin: "platform", amountMinor: 100n, currency: "INR", source: "pricing" });
  });
});

describe("rate card: SERVICE, scale and the currency lock", () => {
  const body = { currency: "INR", rates: { IN: { MARKETING: "88", SERVICE: "0" }, "*": { UTILITY: "50" } } };
  it("accepts a SERVICE column and 2 extra decimals", () => {
    expect(parseRateCard(body).rates.IN).toEqual({ MARKETING: 88, SERVICE: 0 });
    expect(parseRateCard(body).scale).toBe(0);
    const scaled = parseRateCard({ currency: "INR", scale: 2, rates: { IN: { UTILITY: "1150" } } });
    expect(scaled).toMatchObject({ scale: 2, rates: { IN: { UTILITY: 1150 } } });
    // The same money limit at either scale.
    expect(() => parseRateCard({ currency: "INR", scale: 2, rates: { IN: { UTILITY: String(10_000_000 * 100) } } })).not.toThrow();
    expect(() => parseRateCard({ currency: "INR", rates: { IN: { UTILITY: String(10_000_000 * 100) } } })).toThrow(/whole number/);
    expect(() => parseRateCard({ ...body, scale: 3 })).toThrow(/Scale must be 0/);
  });
  it("keeps SERVICE and the scale when read back", async () => {
    h.db.rows("platformSetting").find((r) => r.key === RATECARD_KEY)!.value = { ...CARD, scale: 2 };
    expect(await getRateCard()).toMatchObject({ scale: 2, rates: { IN: { SERVICE: 10 } } });
    h.db.rows("platformSetting").find((r) => r.key === RATECARD_KEY)!.value = { currency: "INR", rates: { IN: { MARKETING: 1 } } };
    expect((await getRateCard())?.scale).toBe(0);
  });
  it("refuses a currency change while a workspace has a WhatsApp limit in the current currency", async () => {
    h.db.seed("spendAllowance", [{ id: "sa1", tenantId: "t9", pot: "messaging", currency: "INR", dailyLimitMinor: null, monthlyLimitMinor: 500_000n }]);
    const err = await saveRateCard("admin1", { ...body, currency: "USD" }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, message: currencyLockedCopy("INR") });
    expect(err.message).toBe("Workspaces have WhatsApp limits in INR. Add rates in INR, or ask them to re-enter limits first.");
    expect((await getRateCard())?.currency).toBe("INR");
    // The same currency always saves.
    await expect(saveRateCard("admin1", body)).resolves.toMatchObject({ currency: "INR" });
  });
  it("a messaging allowance row counts even while both of its limits are Not set (3.1: while any exists)", async () => {
    h.db.seed("spendAllowance", [{ id: "sa2", tenantId: "t9", pot: "messaging", currency: "INR", dailyLimitMinor: null, monthlyLimitMinor: null }]);
    await expect(saveRateCard("admin1", { ...body, currency: "USD" })).rejects.toMatchObject({ status: 409, message: currencyLockedCopy("INR") });
  });
  it("allows the change when no workspace has WhatsApp limits in the current currency (other pots and currencies do not count)", async () => {
    h.db.seed("spendAllowance", [{ id: "sa3", tenantId: "t8", pot: "ads", currency: "INR", dailyLimitMinor: 100n, monthlyLimitMinor: null }]);
    h.db.seed("spendAllowance", [{ id: "sa4", tenantId: "t7", pot: "messaging", currency: "USD", dailyLimitMinor: null, monthlyLimitMinor: 9_000n }]);
    await expect(saveRateCard("admin1", { ...body, currency: "USD" })).resolves.toMatchObject({ currency: "USD" });
    await clearRateCard("admin1");
    expect(await getRateCard()).toBeNull();
  });
  it("the plain price lookup used by the broadcast screen gives whole minor units at either scale, rounded up", () => {
    const scaled: RateCardData = { ...CARD, scale: 2, rates: { IN: { UTILITY: 1150, MARKETING: 8800 }, "*": { UTILITY: 1101 } } };
    expect(cardRate(scaled, "IN", "utility")).toBe(12);
    expect(cardRate(scaled, "IN", "MARKETING")).toBe(88);
    expect(cardRate(scaled, "BR", "UTILITY")).toBe(12);
    expect(cardRate(scaled, "BR", "AUTHENTICATION")).toBeUndefined();
    expect(cardRate(CARD, "IN", "MARKETING")).toBe(100);
  });
  it("the editor sends SERVICE and the scale, converts prices when the toggle changes, and warns while SERVICE is missing", () => {
    const form = { currency: "inr", note: "", rows: [{ country: "in", MARKETING: "88", UTILITY: "", AUTHENTICATION: "", SERVICE: "0" }] };
    expect(formToBody(form)).toEqual({ currency: "INR", note: "", rates: { IN: { MARKETING: "88", SERVICE: "0" } } });
    const scaled = rescaleForm(form, 2)!;
    expect(scaled.rows[0]).toMatchObject({ MARKETING: "8800", SERVICE: "0" });
    expect(formToBody(scaled)).toMatchObject({ scale: 2, rates: { IN: { MARKETING: "8800" } } });
    expect(rescaleForm(scaled, 0)?.rows[0].MARKETING).toBe("88");
    expect(rescaleForm({ ...scaled, rows: [{ ...scaled.rows[0], MARKETING: "1150" }] }, 0)).toBeNull();
    expect(serviceMissing(form)).toBe(false);
    expect(serviceMissing({ ...form, rows: [{ ...form.rows[0], SERVICE: "" }] })).toBe(true);
  });
  it("the editor renders the Service column, the labelled 2-decimals switch, the missing-service warning and a live status area", () => {
    const row = { country: "IN", MARKETING: "88", UTILITY: "12", AUTHENTICATION: "", SERVICE: "" };
    const html = renderToStaticMarkup(createElement(RateCardEditor, { initial: { currency: "INR", note: "", rows: [row], scale: 2 }, configured: true }));
    expect(html).toContain("Service (free-form)");
    expect(html).toContain('aria-label="Service (free-form) price for row 1"');
    expect(html).toMatch(/<label for="([^"]+)"[^>]*>.*?<input id="\1" type="checkbox"[^>]*checked=""/);
    expect(html).toContain("Rates use 2 extra decimals");
    expect(html).toContain("hundredths of the smallest unit, like 1150 for 11.5 paise");
    expect(html).toContain("No service price yet, so free-form replies are estimated at the utility price.");
    expect(html).toContain('aria-live="polite"');
    const priced = renderToStaticMarkup(createElement(RateCardEditor, { initial: { currency: "INR", note: "", rows: [{ ...row, SERVICE: "0" }] }, configured: false }));
    expect(priced).not.toContain("No service price yet");
    expect(priced).toContain("whole numbers of the smallest unit");
    expect(priced).not.toContain("Clear rate card");
  });
});
