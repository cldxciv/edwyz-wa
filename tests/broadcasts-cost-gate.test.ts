/**
 * Bulk WhatsApp cost gates (docs/SPEND-CONTROLS-SPEC.md 4.9 "Bulk gates", WP-10) and the last origin stamps (WP-11), end to end
 * over the in-memory spend database: the real reserveBulk, counters, ledger and reservations run; only the sending itself
 * (inbox), the queue and the effective limits are stand-ins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, RawCall, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  limits: { daily: null as bigint | null, monthly: null as bigint | null, rules: { humanRefusal: null as unknown, assistantRefusal: null as unknown } },
  audience: [] as string[],
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(async (..._args: unknown[]) => ({ id: "job" })), runDueJobs: vi.fn() }));
const inbox = vi.hoisted(() => ({ sendTemplateMessage: vi.fn(), sendText: vi.fn() }));
const fire = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ fired: 1, replied: false })));
const email = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/spend/allowances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spend/allowances")>()),
  effectiveLimits: vi.fn(async () => h.limits),
}));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined), assertTenantCanWrite: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/email", () => ({ queueEmail: email }));
vi.mock("@/lib/integrations/emitters", () => ({ emitBroadcastCompleted: vi.fn(async () => undefined) }));
vi.mock("@/lib/broadcasts/portfolio", () => ({ portfolioUsage: async () => ({ limit: 1000, used: 0, oldest: null, phones: [] }) }));
vi.mock("@/lib/automation/v2/run", () => ({ fireRulesSafely: fire, byPriority: () => 0 }));
// The audience is whatever the test says; freezing writes those people as pending recipients.
vi.mock("@/lib/broadcasts/audience", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/broadcasts/audience")>()),
  countAudience: vi.fn(async () => h.audience.length),
  freezeAudience: vi.fn(async (tenantId: string, broadcastId: string) => {
    for (const contactId of h.audience) seedRecipient(broadcastId, contactId, "pending", tenantId);
    return h.audience.length;
  }),
}));
vi.mock("@/lib/broadcasts/audience-data", () => ({
  audienceContacts: vi.fn(async () => ({ total: 0, contacts: [] })),
  audiencePhones: vi.fn(async () => h.db.rows("contact").filter((c) => h.audience.includes(String(c.id))).map((c) => String(c.phone))),
}));

import { SCHEDULE_WARNING, assertApiSendFits, fitsRoom, holdForApiSend } from "@/lib/broadcasts/cost";
import { PAUSE_COPY, PAUSE_REASONS, SPEND_PAUSE_REASONS } from "@/lib/broadcasts/pause-copy";
import { processBroadcast, reestimateBroadcastHolds } from "@/lib/broadcasts/process";
import { cancelBroadcast, estimateBroadcast, startBroadcast } from "@/lib/broadcasts/service";
import { scanScheduled, scheduledJobHandler, SCHEDULE_QUEUE, RELEASE_DELAY_MS, scheduledRunEstimate } from "@/lib/automation/v2/timed";
import { sendTemplate as compatSendTemplate } from "@/lib/compat/messaging";
import { sendMessageV1 } from "@/lib/integrations/v1-service";
import { RATECARD_KEY, type RateCardData } from "@/lib/admin/ratecard";
import { parseDefinition } from "@/lib/automation/v2/model";
import { BANNED_COPY_WORDS, spendCopy } from "@/lib/spend/copy";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resetSpendStateCache } from "@/lib/spend/kill";
import type { OriginField } from "@/lib/spend/messaging/origin";
import { counterKeys } from "@/lib/spend/counters";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z"); // 12:00 in Asia/Kolkata
const DAY_MS = 86_400_000;
const KEYS = counterKeys(NOW, "Asia/Kolkata");
const actor = { userId: "u1", tenantId: T, role: "owner" as const };

const CARD: RateCardData = {
  currency: "INR",
  scale: 0,
  note: "",
  updatedAt: null,
  rates: { IN: { MARKETING: 100, UTILITY: 20, AUTHENTICATION: 15, SERVICE: 10 }, "*": { MARKETING: 300, UTILITY: 50 } },
};

const max = (a: bigint, b: bigint) => (a > b ? a : b);

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
    const returning = (r: Row) => ({ ...r, amountMinor: String(r.amountMinor), consumedMinor: String(r.consumedMinor) });
    if (call.sql.includes("spend.reservation.close")) {
      const [id, status, now, actual] = call.values as [string, string, Date, bigint | null];
      const r = db.rows("spendReservation").find((x) => x.id === id);
      if (!r || r.status !== "held") return [];
      r.status = status === "released" && (r.consumedMinor as bigint) > 0n ? "settled" : status;
      r.closedAt = now;
      if (actual !== null) r.consumedMinor = actual;
      return [returning(r)];
    }
    return undefined;
  });
}

const counter = (kind: "day" | "month") => h.db.rows("spendCounter").find((r) => r.tenantId === T && r.pot === "messaging" && r.periodKind === kind && r.periodKey === (kind === "day" ? KEYS.day : KEYS.month));
const reserved = (kind: "day" | "month" = "month") => (counter(kind)?.reservedMinor as bigint | undefined) ?? 0n;
const holds = (type?: string) => h.db.rows("spendReservation").filter((r) => !type || r.subjectType === type);
const ledger = (action?: string) => h.db.rows("spendLedger").filter((r) => !action || r.action === action);
const notices = () => h.db.rows("notice");

function limits(monthly: bigint | null, daily: bigint | null = null) {
  h.limits = { daily, monthly, rules: { humanRefusal: null, assistantRefusal: null } };
}

let recipientIds = 0;
function seedRecipient(broadcastId: string, contactId: string, status = "pending", tenantId = T) {
  const contact = h.db.rows("contact").find((c) => c.id === contactId);
  h.db.seed("broadcastRecipient", [{ id: `br${++recipientIds}`, tenantId, broadcastId, contactId, status, attempts: 0, contact: contact ? { ...contact } : null }]);
}

const template = (over: Row = {}) => ({ id: "tp_m", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", category: "MARKETING", status: "approved", components: [{ type: "BODY", text: "Hello" }], ...over });
const PHONE = { id: "ph1", tenantId: T, wabaRefId: "w1", phoneNumberId: "meta_ph1", displayPhone: "+91 98000 00000", qualityRating: "GREEN", messagingLimitTier: "TIER_1K", status: "connected" };

function seedBroadcast(over: Row = {}, tpl: Row = {}) {
  const row = {
    id: "b1",
    tenantId: T,
    phoneNumberId: "ph1",
    templateId: "tp_m",
    name: "Diwali offer",
    status: "draft",
    segmentTags: [],
    scheduledAt: null,
    startedAt: null,
    retryDays: 0,
    audienceFilter: null,
    variableMap: null,
    missingValuePolicy: "skip",
    template: template(tpl),
    phoneNumber: { ...PHONE },
    ...over,
  };
  h.db.seed("broadcast", [row]);
  return row;
}

const broadcastRow = () => h.db.rows("broadcast").find((b) => b.id === "b1")!;
const pauseReason = () => (h.db.rows("platformSetting").find((s) => s.key === "broadcast.pause_reason.b1")?.value as { reason?: string } | undefined)?.reason ?? null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("SPEND_ENFORCE", "enforce");
  vi.clearAllMocks();
  h.db.reset();
  emulateSql(h.db);
  resetSpendStateCache();
  recipientIds = 0;
  h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata" }]);
  h.db.seed("platformSetting", [{ key: RATECARD_KEY, value: CARD }]);
  h.db.seed("phoneNumber", [{ ...PHONE }]);
  h.db.seed("template", [template(), template({ id: "tp_u", name: "notice", category: "UTILITY" })]);
  h.db.seed("contact", [
    { id: "c1", tenantId: T, phone: "+919800000001", bsuid: null, name: "Asha", attributes: {}, optIn: true, optedOutAt: null, tags: [] },
    { id: "c2", tenantId: T, phone: "+919800000002", bsuid: null, name: "Ravi", attributes: {}, optIn: true, optedOutAt: null, tags: [] },
    { id: "c3", tenantId: T, phone: "+919800000003", bsuid: null, name: "Meera", attributes: {}, optIn: true, optedOutAt: null, tags: [] },
    // A number whose country the card does not price: the conservative estimate uses the highest rate (300).
    { id: "c4", tenantId: T, phone: "+999000004", bsuid: null, name: "Far", attributes: {}, optIn: true, optedOutAt: null, tags: [] },
  ]);
  h.db.seed("membership", [{ id: "m1", tenantId: T, userId: "u1", role: "owner", user: { email: "owner@example.com", disabledAt: null } }]);
  h.audience = ["c1", "c2", "c3", "c4"];
  limits(100_000n);
  inbox.sendTemplateMessage.mockImplementation(async (input: { contactId: string }) => ({ id: `msg_${input.contactId}`, conversationId: "cv1", status: "queued" }));
  inbox.sendText.mockResolvedValue({ id: "msg_text", status: "queued" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ===== startBroadcast =====

describe("startBroadcast: the 7-day bulk hold (4.9)", () => {
  it("holds the conservative estimate for 7 days BEFORE the status change, then queues the run", async () => {
    seedBroadcast();
    const update = vi.spyOn(h.db.prisma.broadcast as { update: (a: unknown) => Promise<unknown> }, "update");
    let heldAtUpdate = false;
    update.mockImplementationOnce(async function (this: unknown, args: unknown) {
      heldAtUpdate = holds("broadcast").some((r) => r.status === "held");
      const row = broadcastRow();
      Object.assign(row, (args as { data: Row }).data);
      return row;
    });
    const out = await startBroadcast(actor, "b1");
    expect(heldAtUpdate).toBe(true);
    expect(out).toMatchObject({ status: "sending", spendWarning: null });
    const [hold] = holds("broadcast");
    // 3 Indian numbers at 100 plus one unpriced country at the card's highest marketing rate (300).
    expect(hold).toMatchObject({ subjectId: "b1", amountMinor: 600n, status: "held", currency: "INR", dayKey: KEYS.day, monthKey: KEYS.month });
    expect((hold.expiresAt as Date).getTime() - NOW.getTime()).toBe(7 * DAY_MS);
    expect(reserved("month")).toBe(600n);
    expect(reserved("day")).toBe(600n);
    expect(ledger("messaging.bulk_hold").map((r) => r.phase).sort()).toEqual(["applied", "requested"]);
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, expect.anything());
  });

  it("refuses with 409 and the plain copy when it does not fit, and queues nothing", async () => {
    seedBroadcast();
    limits(500n);
    const error = await startBroadcast(actor, "b1").catch((e) => e);
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("spend.broadcast");
    expect(error.message).toBe(spendCopy("spend.broadcast", { cost: { minor: 600n, currency: "INR" }, left: { minor: 500n, currency: "INR" }, period: "month" }));
    expect(error.message).toBe("This broadcast could cost about ₹6, but only ₹5 is left in your WhatsApp limit this month. Send to fewer people or raise the limit.");
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(broadcastRow().status).toBe("draft");
    expect(holds().filter((r) => r.status === "held")).toHaveLength(0);
    expect(reserved("month")).toBe(0n);
    // The draft is left as it was: the next start freezes today's audience again.
    expect(h.db.rows("broadcastRecipient")).toHaveLength(0);
    expect(ledger("messaging.bulk_hold").find((r) => r.phase === "refused")).toMatchObject({ reasonCodes: ["spend.broadcast"], targetId: "b1", amountMinor: 600n });
  });

  it("says 'today' when the broadcast fits the month but not the day", async () => {
    seedBroadcast();
    limits(100_000n, 400n);
    const error = await startBroadcast(actor, "b1").catch((e) => e);
    expect(error.message).toContain("is left in your WhatsApp limit today");
  });

  it("in observe mode a start that would not fit goes ahead without a hold and records a would-refuse row", async () => {
    vi.stubEnv("SPEND_ENFORCE", "observe");
    seedBroadcast();
    limits(500n);
    const out = await startBroadcast(actor, "b1");
    expect(out.status).toBe("sending");
    expect(holds()).toHaveLength(0);
    expect(ledger("messaging.bulk_hold").find((r) => r.phase === "refused")).toMatchObject({ observe: true, reasonCodes: ["spend.broadcast"] });
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it("a resume holds only the people still pending", async () => {
    seedBroadcast({ status: "paused", startedAt: new Date(NOW.getTime() - DAY_MS) });
    seedRecipient("b1", "c1", "delivered");
    seedRecipient("b1", "c4", "delivered");
    seedRecipient("b1", "c2", "pending");
    seedRecipient("b1", "c3", "pending");
    await startBroadcast(actor, "b1");
    expect(holds("broadcast")[0]).toMatchObject({ amountMinor: 200n, status: "held" });
  });

  it("a resume keeps the hold it still has, even though that hold makes the limit look full", async () => {
    seedBroadcast();
    await startBroadcast(actor, "b1");
    const [hold] = holds("broadcast");
    broadcastRow().status = "paused";
    limits(600n);
    for (const mode of ["enforce", "observe"]) {
      vi.stubEnv("SPEND_ENFORCE", mode);
      broadcastRow().status = "paused";
      await expect(startBroadcast(actor, "b1")).resolves.toMatchObject({ status: "sending" });
    }
    expect(holds("broadcast")).toHaveLength(1);
    expect(holds("broadcast")[0]).toMatchObject({ id: hold.id, status: "held", amountMinor: 600n });
    expect(ledger("messaging.bulk_hold").filter((r) => r.phase === "refused")).toHaveLength(0);
  });

  it("refuses to start now while spending is stopped; scheduling is still allowed", async () => {
    seedBroadcast();
    h.db.rows("spendControl")[0].freeze = "all";
    const error = await startBroadcast(actor, "b1").catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "spend.frozen" });
    expect(error.message).toBe("Spending is stopped for this workspace. The owner can turn it back on in Settings > Spending limits.");
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(h.db.rows("broadcastRecipient")).toHaveLength(0);
    broadcastRow().scheduledAt = new Date(NOW.getTime() + 2 * DAY_MS);
    await expect(startBroadcast(actor, "b1")).resolves.toMatchObject({ status: "scheduled" });
  });

  it("refuses a marketing broadcast on a template Meta flagged, but not a utility one", async () => {
    seedBroadcast({}, { status: "flagged" });
    await expect(startBroadcast(actor, "b1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Meta flagged this template") });
    h.db.reset();
    emulateSql(h.db);
    h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata" }]);
    h.db.seed("contact", [{ id: "c1", tenantId: T, phone: "+919800000001", optIn: true, optedOutAt: null }]);
    h.audience = ["c1"];
    seedBroadcast({}, { id: "tp_u", category: "UTILITY", status: "flagged" });
    await expect(startBroadcast(actor, "b1")).resolves.toMatchObject({ status: "sending" });
  });
});

describe("scheduling: the dry run and its warning (4.9 critic)", () => {
  const later = () => new Date(NOW.getTime() + 2 * DAY_MS);

  it("warns when the broadcast would not fit at today's figures, and holds nothing yet", async () => {
    seedBroadcast({ scheduledAt: later() });
    limits(300n);
    const out = await startBroadcast(actor, "b1");
    expect(out.status).toBe("scheduled");
    expect(out.spendWarning).toBe(SCHEDULE_WARNING);
    expect(SCHEDULE_WARNING).toBe("At today's figures this broadcast won't fit your WhatsApp limit. It will pause when it's due unless the limit allows it.");
    expect(holds()).toHaveLength(0);
    expect(reserved()).toBe(0n);
  });

  it("does not warn when it fits, or when the limit only observes", async () => {
    seedBroadcast({ scheduledAt: later() });
    expect((await startBroadcast(actor, "b1")).spendWarning).toBeNull();
    h.db.rows("broadcast")[0].status = "draft";
    vi.stubEnv("SPEND_ENFORCE", "observe");
    limits(300n);
    expect((await startBroadcast(actor, "b1")).spendWarning).toBeNull();
  });

  it("the review step shows the same warning for a scheduled draft, and the 409 sentence for a send now", async () => {
    limits(300n);
    seedBroadcast({ scheduledAt: later() });
    expect((await estimateBroadcast(actor, "b1")).limitWarning).toBe(SCHEDULE_WARNING);
    broadcastRow().scheduledAt = null;
    expect((await estimateBroadcast(actor, "b1")).limitWarning).toBe(
      "This broadcast could cost about ₹6, but only ₹3 is left in your WhatsApp limit this month. Send to fewer people or raise the limit.",
    );
    limits(100_000n);
    expect((await estimateBroadcast(actor, "b1")).limitWarning).toBeNull();
  });

  it("a due scheduled broadcast that no longer fits pauses with messaging_limit and the owner is told", async () => {
    seedBroadcast({ status: "scheduled", scheduledAt: new Date(NOW.getTime() - 60_000) });
    for (const c of ["c1", "c2", "c3", "c4"]) seedRecipient("b1", c);
    limits(300n);
    await processBroadcast("b1", NOW);
    expect(broadcastRow().status).toBe("paused");
    expect(pauseReason()).toBe("messaging_limit");
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(holds().filter((r) => r.status === "held")).toHaveLength(0);
    const notice = notices().find((n) => n.source === "spend");
    expect(notice).toMatchObject({ kind: "limit_reached", audienceMinRole: "owner", subjectType: "broadcast", subjectId: "b1" });
    expect((notice!.payload as { title: string }).title).toContain("won't fit your WhatsApp limit");
  });

  it("a due scheduled broadcast that fits takes its hold and its messages use it, as origin broadcast", async () => {
    seedBroadcast({ status: "scheduled", scheduledAt: new Date(NOW.getTime() - 60_000) });
    for (const c of ["c1", "c2"]) seedRecipient("b1", c);
    await processBroadcast("b1", NOW);
    expect(broadcastRow().status).toBe("sending");
    const [hold] = holds("broadcast");
    expect(hold).toMatchObject({ amountMinor: 200n, status: "held" });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(2);
    for (const [input] of inbox.sendTemplateMessage.mock.calls) expect(input).toMatchObject({ origin: "broadcast", reservationId: hold.id, templateName: "promo" });
  });
});

describe("process: completion and cancel release the rest; stops pause with plain reasons", () => {
  async function started(consumed = 0n) {
    seedBroadcast();
    await startBroadcast(actor, "b1");
    const hold = holds("broadcast")[0];
    hold.consumedMinor = consumed;
    return hold;
  }

  it("completion gives back what the hold did not use", async () => {
    const hold = await started(200n);
    for (const r of h.db.rows("broadcastRecipient")) r.status = "delivered";
    await processBroadcast("b1", NOW);
    expect(broadcastRow().status).toBe("completed");
    expect(hold.status).toBe("settled");
    expect(reserved("month")).toBe(200n);
    expect(ledger("messaging.bulk_release")[0]).toMatchObject({ amountMinor: 400n, targetId: "b1", phase: "info" });
  });

  it("cancel gives back the whole unused hold at once", async () => {
    const hold = await started();
    await cancelBroadcast(actor, "b1");
    expect(hold.status).toBe("released");
    expect(reserved("month")).toBe(0n);
    expect(reserved("day")).toBe(0n);
    expect(ledger("messaging.bulk_release")[0]).toMatchObject({ amountMinor: 600n, actorType: "user", actorId: "u1" });
  });

  it("a broadcast found finished never keeps a hold", async () => {
    const hold = await started();
    broadcastRow().status = "canceled";
    await processBroadcast("b1", NOW);
    expect(hold.status).toBe("released");
  });

  it("pauses with spending_stopped while spending is stopped (workspace or platform), and tells the owner", async () => {
    seedBroadcast({ status: "sending", startedAt: NOW });
    seedRecipient("b1", "c1");
    h.db.rows("spendControl")[0].freeze = "all";
    await processBroadcast("b1", NOW);
    expect(broadcastRow().status).toBe("paused");
    expect(pauseReason()).toBe("spending_stopped");
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(notices().find((n) => n.kind === "spending_stopped")).toBeTruthy();

    broadcastRow().status = "sending";
    h.db.rows("spendControl")[0].freeze = "none";
    h.db.seed("platformSetting", [{ key: "spend:platform", value: { freeze: "all", reason: "incident" } }]);
    resetSpendStateCache();
    await processBroadcast("b1", NOW);
    expect(broadcastRow().status).toBe("paused");
  });

  it("an open YELLOW quality breaker pauses a marketing broadcast with number_quality_yellow; a utility one keeps sending", async () => {
    h.db.seed("spendBreaker", [{ id: "sb1", tenantId: T, kind: "wa_quality_yellow", scopeType: "phone", scopeId: "ph1", effect: "block_marketing", state: "tripped", reason: "Medium quality.", trippedAt: NOW }]);
    seedBroadcast({ status: "sending", startedAt: NOW });
    seedRecipient("b1", "c1");
    await processBroadcast("b1", NOW);
    expect(pauseReason()).toBe("number_quality_yellow");
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();

    h.db.rows("broadcast").length = 0;
    seedBroadcast({ status: "sending", startedAt: NOW, templateId: "tp_u" }, { id: "tp_u", name: "notice", category: "UTILITY" });
    await processBroadcast("b1", NOW);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("a RED quality breaker pauses every broadcast from the number with number_quality", async () => {
    h.db.seed("spendBreaker", [{ id: "sb2", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph1", effect: "block_automated", state: "tripped", reason: "Low quality.", trippedAt: NOW }]);
    seedBroadcast({ status: "sending", startedAt: NOW, templateId: "tp_u" }, { id: "tp_u", name: "notice", category: "UTILITY" });
    seedRecipient("b1", "c1");
    await processBroadcast("b1", NOW);
    expect(pauseReason()).toBe("number_quality");
  });

  it("a template Meta flagged pauses a marketing broadcast that is sending", async () => {
    seedBroadcast({ status: "sending", startedAt: NOW }, { status: "flagged" });
    seedRecipient("b1", "c1");
    await processBroadcast("b1", NOW);
    expect(pauseReason()).toBe("template_quality");
  });
});

describe("the new pause reasons have plain copy", () => {
  it.each(["number_quality_yellow", "spending_stopped", "messaging_limit"] as const)("%s", (reason) => {
    expect(PAUSE_REASONS).toContain(reason);
    expect(SPEND_PAUSE_REASONS.has(reason)).toBe(true);
    const copy = PAUSE_COPY[reason];
    expect(copy.title.length).toBeGreaterThan(10);
    expect(copy.body).toMatch(/Nobody is lost/);
    // Says what to do next.
    expect(copy.body).toMatch(/resume/i);
    for (const banned of BANNED_COPY_WORDS) expect(`${copy.title} ${copy.body}`.toLowerCase()).not.toContain(banned);
    expect(`${copy.title} ${copy.body}`).not.toMatch(/[!]|minor units|reservation|breaker/i);
  });
});

describe("template_category_update: running broadcasts are re-estimated", () => {
  async function sendingUtility() {
    seedBroadcast({ templateId: "tp_u" }, { id: "tp_u", name: "notice", category: "UTILITY" });
    h.audience = ["c1", "c2"];
    await startBroadcast(actor, "b1");
    expect(holds("broadcast")[0]).toMatchObject({ amountMinor: 40n });
    // Meta re-categorised the template as marketing.
    broadcastRow().template = { ...(broadcastRow().template as Row), category: "MARKETING" };
  }

  it("a hold that no longer covers the pending people is replaced by one at the new category", async () => {
    await sendingUtility();
    const out = await reestimateBroadcastHolds(T, "tp_u", NOW);
    expect(out).toEqual({ reestimated: 1, paused: 0 });
    const open = holds("broadcast").filter((r) => r.status === "held");
    expect(open).toHaveLength(1);
    expect(open[0].amountMinor).toBe(200n);
    expect(reserved("month")).toBe(200n);
  });

  it("a broadcast that no longer fits pauses with messaging_limit", async () => {
    await sendingUtility();
    limits(100n);
    const out = await reestimateBroadcastHolds(T, "tp_u", NOW);
    expect(out.paused).toBe(1);
    expect(broadcastRow().status).toBe("paused");
    expect(pauseReason()).toBe("messaging_limit");
    expect(holds("broadcast").filter((r) => r.status === "held")).toHaveLength(0);
  });
});

// ===== Scheduled automation runs =====

describe("automation/v2/timed scanScheduled: a run holds before chunking, or is refused at start", () => {
  const daily = { type: "scheduled", repeat: "daily", time: "06:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" };
  const rule = (actions: unknown[]) => ({
    id: "r1",
    tenantId: T,
    name: "Morning offer",
    version: 2,
    enabled: true,
    phoneNumberId: null,
    priority: 10,
    cooldownMinutes: 0,
    stopAfterMatch: false,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    trigger: daily,
    filters: { root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: false } },
    actions,
  });
  const sendsOffer = [{ type: "send_template", templateId: "tp_m", variables: [] }];

  it("estimates its template sends to the contacts it may reach, at the conservative rates", async () => {
    const parsed = parseDefinition({ trigger: daily, filters: rule(sendsOffer).filters, actions: sendsOffer });
    if (!parsed.ok) throw new Error("bad rule");
    expect(await scheduledRunEstimate(T, parsed.value, CARD, NOW)).toBe(600n);
    expect(await scheduledRunEstimate(T, parsed.value, null, NOW)).toBeNull();
    const noTemplates = parseDefinition({ trigger: daily, filters: rule([]).filters, actions: [{ type: "add_tag", tag: "x", scope: "contact" }] });
    if (!noTemplates.ok) throw new Error("bad rule");
    expect(await scheduledRunEstimate(T, noTemplates.value, CARD, NOW)).toBe(0n);
  });

  it("holds the run's estimate and passes the hold to every chunk", async () => {
    h.db.seed("automationRule", [rule(sendsOffer)]);
    expect(await scanScheduled(NOW)).toBe(1);
    const [hold] = holds("automation_run");
    expect(hold).toMatchObject({ subjectId: "r1:day:2026-10-28", amountMinor: 600n, status: "held" });
    expect(queue.enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, expect.objectContaining({ ruleId: "r1", reservationId: hold.id, cursor: null }), { maxAttempts: 3 });
  });

  it("is refused at start when it does not fit: nothing queued, a note on the rule and a notice to the owner", async () => {
    h.db.seed("automationRule", [rule(sendsOffer)]);
    limits(500n);
    expect(await scanScheduled(NOW)).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(holds().filter((r) => r.status === "held")).toHaveLength(0);
    const note = h.db.rows("ruleExecution")[0];
    expect(note).toMatchObject({ tenantId: T, ruleId: "r1", outcome: "skipped" });
    expect(note.detail).toBe("Did not run: This run could cost about ₹6, but only ₹5 is left in your WhatsApp limit this month. Narrow the rule with a tag or segment, or raise the limit.");
    expect(notices().find((n) => n.kind === "limit_reached" && n.subjectId === "r1")).toBeTruthy();
    // The day's run stays claimed, so it is not retried every minute (PlatformSetting.key is unique in the database).
    const settings = h.db.prisma.platformSetting as { create: (args: { data: Row }) => Promise<unknown> };
    const create = settings.create.bind(settings);
    vi.spyOn(settings, "create").mockImplementation(async (args) => {
      if (h.db.rows("platformSetting").some((r) => r.key === args.data.key)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      return create(args);
    });
    queue.enqueue.mockClear();
    expect(await scanScheduled(new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(h.db.rows("ruleExecution")).toHaveLength(1);
  });

  it("a rule that sends no template needs no hold and starts as before", async () => {
    h.db.seed("automationRule", [rule([{ type: "add_tag", tag: "x", scope: "contact" }])]);
    limits(0n);
    expect(await scanScheduled(NOW)).toBe(1);
    expect(holds()).toHaveLength(0);
    expect(queue.enqueue.mock.calls[0][1]).not.toHaveProperty("reservationId");
  });

  it("the chunks fire with the hold, and the finished run gives back the rest a little later", async () => {
    h.db.seed("automationRule", [rule(sendsOffer)]);
    await scanScheduled(NOW);
    const hold = holds("automation_run")[0];
    const payload = queue.enqueue.mock.calls[0][1] as Record<string, unknown>;
    queue.enqueue.mockClear();
    await scheduledJobHandler(payload, { attempt: 1, maxAttempts: 3, isLastAttempt: false });
    expect(fire).toHaveBeenCalled();
    for (const [event] of fire.mock.calls) expect(event).toMatchObject({ type: "scheduled", reservationId: hold.id });
    expect(queue.enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, { tenantId: T, releaseReservationId: hold.id }, { runAt: new Date(NOW.getTime() + RELEASE_DELAY_MS), maxAttempts: 3 });
    hold.consumedMinor = 100n;
    await scheduledJobHandler({ tenantId: T, releaseReservationId: hold.id }, { attempt: 1, maxAttempts: 3, isLastAttempt: false });
    expect(hold.status).toBe("settled");
    expect(reserved()).toBe(100n);
  });
});

// ===== API senders =====

describe("API, compat and MCP sends: per-call holds, origins and a synchronous 409", () => {
  const templateBody = (to = "+919800000001") => ({ to, type: "template", template: { name: "promo", language: "en" } });

  it("a v1 template send takes an api_batch hold of one message and is stamped api", async () => {
    await sendMessageV1(actor, templateBody());
    const [hold] = holds("api_batch");
    expect(hold).toMatchObject({ amountMinor: 100n, status: "held" });
    expect(String(hold.subjectId)).toMatch(/^api:/);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ origin: "api", reservationId: hold.id, contactId: "c1" }));
  });

  it("the MCP connection's sends are stamped mcp, with the key on the ledger", async () => {
    await sendMessageV1(actor, templateBody(), { origin: "mcp", keyId: "k1" });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ origin: "mcp" }));
    expect(String(holds("api_batch")[0].subjectId)).toMatch(/^mcp:/);
    expect(ledger("messaging.bulk_hold")[0]).toMatchObject({ actorType: "api", actorId: "k1" });
  });

  it("answers 409 at once when the limit is used up, and nothing is created or queued", async () => {
    limits(50n);
    const error = await sendMessageV1(actor, templateBody()).catch((e) => e);
    expect(error).toBeInstanceOf(SpendBlockedError);
    expect(error).toMatchObject({ status: 409, code: "spend.messaging_limit" });
    expect(error.message).toBe("This month's WhatsApp limit is used up. Automatic messages will wait until it resets on 1 Nov, or raise the limit.");
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(holds().filter((r) => r.status === "held")).toHaveLength(0);
  });

  it("gives the hold back when the send itself is refused (opted out after the check)", async () => {
    inbox.sendTemplateMessage.mockRejectedValueOnce(new Error("refused"));
    await expect(sendMessageV1(actor, templateBody())).rejects.toThrow("refused");
    expect(holds("api_batch")[0].status).toBe("released");
    expect(reserved()).toBe(0n);
  });

  it("free-form API and MCP replies are refused at enqueue when the limit cannot pay for them", async () => {
    h.db.seed("conversation", [{ id: "cv1", tenantId: T, phoneNumberId: "ph1", contactId: "c1", referral: null, createdAt: new Date(NOW.getTime() - DAY_MS) }]);
    const text = { to: "+919800000001", type: "text", text: "Your order shipped" };
    await sendMessageV1(actor, text, { origin: "mcp" });
    expect(inbox.sendText).toHaveBeenCalledWith(expect.objectContaining({ origin: "mcp", conversationId: "cv1" }));
    inbox.sendText.mockClear();
    limits(5n);
    await expect(sendMessageV1(actor, text)).rejects.toMatchObject({ status: 409, code: "spend.messaging_limit" });
    expect(inbox.sendText).not.toHaveBeenCalled();
    // A click-to-WhatsApp chat opened less than 72 hours ago is free, so it is never refused.
    h.db.rows("conversation")[0].referral = { source_type: "ad" };
    h.db.rows("conversation")[0].createdAt = new Date(NOW.getTime() - 3_600_000);
    await sendMessageV1(actor, text);
    expect(inbox.sendText).toHaveBeenCalledWith(expect.objectContaining({ origin: "api" }));
  });

  it("observe mode never refuses an API send; it records a would-refuse row instead", async () => {
    vi.stubEnv("SPEND_ENFORCE", "observe");
    limits(50n);
    await sendMessageV1(actor, templateBody());
    expect(inbox.sendTemplateMessage).toHaveBeenCalled();
    expect(ledger("messaging.bulk_hold").find((r) => r.phase === "refused")).toMatchObject({ observe: true });
    const contact = { phone: "+919800000001" };
    await expect(assertApiSendFits({ tenantId: T, actor: { type: "api", keyId: "k" }, origin: "api", contact })).resolves.toBeUndefined();
  });

  it("with no price list nothing is held or refused", async () => {
    h.db.rows("platformSetting").length = 0;
    limits(0n);
    expect(await holdForApiSend({ tenantId: T, actor: { type: "api", keyId: "k" }, origin: "api", category: "MARKETING", contact: { phone: "+919800000001" } })).toMatchObject({ reservationId: null });
    await expect(assertApiSendFits({ tenantId: T, actor: { type: "api", keyId: "k" }, origin: "api", contact: { phone: "+919800000001" } })).resolves.toBeUndefined();
  });

  const compat = (recipients: unknown[]) =>
    compatSendTemplate({ actor, params: {}, query: new URLSearchParams(), body: async () => ({ template_name: "promo", language: "en", recipients }) } as unknown as Parameters<typeof compatSendTemplate>[0]);

  it("compat messageTemplates/send takes one hold for the whole call, and every message uses it", async () => {
    const out = await compat([{ phone_number: "+919800000001" }, { phone_number: "+919800000002" }]);
    expect((out as { json: { accepted_count: number } }).json.accepted_count).toBe(2);
    const [hold] = holds("api_batch");
    expect(hold).toMatchObject({ amountMinor: 200n, status: "held" });
    expect(String(hold.subjectId)).toMatch(/^compat:/);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(2);
    for (const [input] of inbox.sendTemplateMessage.mock.calls) expect(input).toMatchObject({ origin: "api", reservationId: hold.id });
  });

  it("compat refuses the whole call with 409 before anything is queued when it does not fit", async () => {
    limits(150n);
    const error = await compat([{ phone_number: "+919800000001" }, { phone_number: "+919800000002" }]).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "spend.broadcast" });
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    limits(0n);
    await expect(compat([{ phone_number: "+919800000001" }])).rejects.toMatchObject({ status: 409, code: "spend.messaging_limit" });
  });

  it("compat gives the hold back when no recipient was accepted", async () => {
    inbox.sendTemplateMessage.mockRejectedValue(Object.assign(new Error("nope"), { status: 422 }));
    await compat([{ phone_number: "+919800000001" }]);
    expect(holds("api_batch")[0].status).toBe("released");
  });
});

describe("fitsRoom (pure)", () => {
  it("names the month first, then the day, and treats an unknown ceiling as no room", () => {
    expect(fitsRoom({ leftDay: 100n, leftMonth: 50n, refused: false }, 60n)).toEqual({ fits: false, period: "month", left: 50n });
    expect(fitsRoom({ leftDay: 40n, leftMonth: 500n, refused: false }, 60n)).toEqual({ fits: false, period: "day", left: 40n });
    expect(fitsRoom({ leftDay: null, leftMonth: null, refused: false }, 60n)).toEqual({ fits: true, period: null, left: null });
    expect(fitsRoom({ leftDay: 100n, leftMonth: 500n, refused: false }, 60n)).toEqual({ fits: true, period: null, left: 100n });
    expect(fitsRoom({ leftDay: null, leftMonth: null, refused: true }, 1n).fits).toBe(false);
  });
});

// ===== Origins (WP-11) =====

describe("origin is required, and every sender of this package stamps its own", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("the type refuses a send input without an origin", () => {
    const stamped: OriginField = { origin: "api" };
    expect(stamped.origin).toBe("api");
    // @ts-expect-error origin is required (WP-11): tsc fails here if it ever becomes optional again.
    const unstamped: OriginField = {};
    expect(unstamped).toEqual({});
  });

  it.each([
    ["src/lib/ai-agent/index.ts", /sendText\(\{[^}]*\.\.\.AI_REPLY_SEND/g, 2, /origin: "ai_reply"/],
    ["src/lib/broadcasts/process.ts", /origin: "broadcast"/g, 1, null],
    ["src/lib/compat/messaging.ts", /origin: "api"/g, 2, null],
    ["src/lib/tenant-mcp/tools.ts", /origin: "mcp"/g, 2, null],
    ["src/lib/webhooks/processor.ts", /sendText\(\{ tenantId, conversationId, body, origin: "consent" \}\)/g, 1, null],
    ["src/lib/integrations/v1-service.ts", /\borigin(,|: opts\.origin \?\? "api")/g, 2, null],
  ] as const)("%s", (file, pattern, count, also) => {
    const source = read(file);
    expect(source.match(pattern)?.length ?? 0).toBeGreaterThanOrEqual(count);
    if (also) expect(source).toMatch(also);
  });

  it("no unstamped sendText, sendTemplateMessage or sendMedia call remains in these files", () => {
    for (const file of ["src/lib/broadcasts/process.ts", "src/lib/integrations/v1-service.ts", "src/lib/tenant-mcp/tools.ts", "src/lib/webhooks/processor.ts", "src/lib/ai-agent/index.ts"]) {
      const source = read(file);
      for (const m of source.matchAll(/\b(sendText|sendTemplateMessage|sendMedia)\(\{/g)) {
        const rest = source.slice(m.index!, m.index! + 600);
        const call = rest.slice(0, rest.indexOf("})") + 2);
        expect(call, `${file}: ${call.slice(0, 80)}`).toMatch(/origin|AI_REPLY_SEND/);
      }
    }
  });
});
