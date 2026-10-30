/**
 * WhatsApp quality, template and account signals and their safety stops (docs/SPEND-CONTROLS-SPEC.md 6.3, WP-12), over the
 * in-memory spend database: the real breakers, ledger and notices run; Meta's answers are injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, sendable: new Set<string>(["t1"]) }));
const paused = vi.hoisted(() => vi.fn(async () => 1));
const lifecycle = vi.hoisted(() => ({ readState: vi.fn(), writeState: vi.fn(async () => undefined), emailOwners: vi.fn(async () => 1), onceWithRetry: vi.fn() }));
const graph = vi.hoisted(() => ({ graphFetch: vi.fn(async () => ({})) }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/admin/service", () => ({ tenantIdsWithSendableToken: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => h.sendable.has(id)))) }));
vi.mock("@/lib/broadcasts/process", () => ({ pauseBroadcastsForNumber: paused }));
vi.mock("@/lib/graph", () => graph);
vi.mock("@/lib/lifecycle/state", () => lifecycle);

import {
  applyAccountUpdate,
  applyQualityReading,
  applyTemplateQuality,
  GREEN_POLLS_TO_CLEAR,
  metaDate,
  normalizeQualityRating,
  pollQuality,
  readWabaCurrencies,
  storedNumberStatus,
  templateUsableByAssistant,
  WABA_CURRENCY_KEY,
  type GraphRead,
} from "@/lib/spend/messaging/quality";
import { breakerOutcome, numberSendable, templateOutcome } from "@/lib/spend/messaging/gate";
import { SEND_ORIGINS } from "@/lib/spend/messaging/origin";
import { periodic as qualityTasks } from "@/lib/spend/tasks/quality";
import { periodic as messagingTasks } from "@/lib/spend/tasks/messaging";
import { worker } from "@/lib/spend/worker";
import { qualityLevel, runQualityAlerts } from "@/lib/lifecycle/notices";
import { parsePricing } from "@/lib/webhooks/payload";

const T = "t1";
const NOW = new Date("2026-10-28T06:30:00Z");
const MIN = 60_000;

const PHONE = { id: "ph1", tenantId: T, wabaRefId: "w1", phoneNumberId: "meta_ph1", displayPhone: "+91 98000 00001", status: "connected", qualityRating: "GREEN", waba: { wabaId: "meta_waba_1" } };

/** Meta's answers, per path: a function of the poll number, or a fixed reading. A thrown error is a failed read. */
function meta(answers: Record<string, Record<string, unknown> | Error | ((n: number) => Record<string, unknown> | Error)>) {
  const calls: { tenantId: string; path: string; fields: string }[] = [];
  const read: GraphRead = async (tenantId, path, fields) => {
    calls.push({ tenantId, path, fields });
    const a = answers[path];
    const n = calls.filter((c) => c.path === path).length;
    const out = typeof a === "function" ? a(n) : a;
    if (out instanceof Error) throw out;
    return out ?? {};
  };
  return { read, calls };
}

const breakers = (kind?: string) => h.db.rows("spendBreaker").filter((r) => !kind || r.kind === kind);
const open = (kind?: string) => breakers(kind).filter((r) => r.state === "tripped");
const ledger = (action: string) => h.db.rows("spendLedger").filter((r) => r.action === action);
const notices = (kind?: string) => h.db.rows("notice").filter((n) => !kind || n.kind === kind);
const phone = () => h.db.rows("phoneNumber").find((p) => p.id === "ph1")!;

beforeEach(() => {
  vi.clearAllMocks();
  h.db.reset();
  h.sendable = new Set([T]);
  h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata" }]);
  h.db.seed("phoneNumber", [{ ...PHONE }]);
  h.db.seed("tenant", [{ id: T, name: "Asha Stores", deletedAt: null, status: "active" }]);
});
afterEach(() => vi.useRealTimers());

describe("ratings and statuses", () => {
  it("reads Meta's old and new rating names, and treats UNKNOWN and NA as no data", () => {
    expect(["GREEN", "HIGH", "green"].map(normalizeQualityRating)).toEqual(["GREEN", "GREEN", "GREEN"]);
    expect(["YELLOW", "MEDIUM"].map(normalizeQualityRating)).toEqual(["YELLOW", "YELLOW"]);
    expect(["RED", "LOW"].map(normalizeQualityRating)).toEqual(["RED", "RED"]);
    expect(["UNKNOWN", "NA", "", null, 3].map(normalizeQualityRating)).toEqual([null, null, null, null, null]);
    expect(qualityLevel("MEDIUM")).toBe("YELLOW");
    expect(qualityLevel("UNKNOWN")).toBe("");
  });
  it("stores only statuses that decide whether a number can send", () => {
    expect(storedNumberStatus("CONNECTED")).toBe("connected");
    expect(storedNumberStatus("DISCONNECTED")).toBe("disconnected");
    expect(storedNumberStatus("BANNED")).toBe("banned");
    expect(storedNumberStatus("FLAGGED")).toBeNull();
    expect(storedNumberStatus("RATE_LIMITED")).toBeNull();
  });
  it("reads Meta dates as unix seconds, milliseconds or ISO", () => {
    expect(metaDate(1793836800)?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(metaDate("1793836800")?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(metaDate("2026-11-05T00:00:00Z")?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(metaDate("not a date")).toBeNull();
    expect(metaDate(undefined)).toBeNull();
  });
});

describe("spend.quality.poll (6.3)", () => {
  it("is registered every 30 minutes, and settlement every 5 minutes", () => {
    expect(qualityTasks).toEqual([expect.objectContaining({ name: "spend.quality.poll", everyMs: 30 * MIN })]);
    expect(messagingTasks).toEqual([expect.objectContaining({ name: "spend.messaging.settle", everyMs: 5 * MIN })]);
    expect(worker.periodic.map((t) => t.name)).toEqual(expect.arrayContaining(["spend.quality.poll", "spend.messaging.settle"]));
  });

  it("YELLOW opens wa_quality_yellow (block_marketing) once, updates the stored rating and pauses marketing broadcasts", async () => {
    const m = meta({ meta_ph1: { quality_rating: "YELLOW", status: "CONNECTED" }, meta_waba_1: { currency: "INR" } });
    const out = await pollQuality({ now: NOW, read: m.read });
    expect(out).toMatchObject({ polled: 1, opened: 1, failed: 0 });
    expect(m.calls[0]).toEqual({ tenantId: T, path: "meta_ph1", fields: "quality_rating,status" });
    expect(phone().qualityRating).toBe("YELLOW");
    expect(open("wa_quality_yellow")[0]).toMatchObject({ scopeType: "phone", scopeId: "ph1", effect: "block_marketing" });
    expect(paused).toHaveBeenCalledWith(T, "ph1", "number_quality_yellow");
    expect(ledger("breaker.trip")).toHaveLength(1);
    expect(notices("breaker_tripped")).toHaveLength(1);
    expect(notices("breaker_tripped")[0]).toMatchObject({ source: "spend", audienceMinRole: "owner", dedupeKey: `spend-breaker:${open()[0].id}` });
    expect(open()[0].notifiedAt).toEqual(NOW);
    // A second YELLOW poll changes nothing: one breaker, one ledger row, one notice.
    await pollQuality({ now: new Date(NOW.getTime() + 30 * MIN), read: m.read });
    expect(breakers()).toHaveLength(1);
    expect(ledger("breaker.trip")).toHaveLength(1);
    expect(notices("breaker_tripped")).toHaveLength(1);
  });

  it("RED (or LOW) opens wa_quality_red (block_automated) and pauses every broadcast from the number", async () => {
    await pollQuality({ now: NOW, read: meta({ meta_ph1: { quality_rating: "LOW", status: "CONNECTED" } }).read });
    expect(open("wa_quality_red")[0]).toMatchObject({ effect: "block_automated", scopeId: "ph1" });
    expect(phone().qualityRating).toBe("RED");
    expect(paused).toHaveBeenCalledWith(T, "ph1", "number_quality");
    expect(notices("breaker_tripped")[0]).toMatchObject({ severity: "action_needed" });
  });

  it(`clears after ${GREEN_POLLS_TO_CLEAR} GREEN polls in a row and tells the owner; a drop in between restarts the count`, async () => {
    const seq = ["YELLOW", "GREEN", "YELLOW", "GREEN", "GREEN"];
    const m = meta({ meta_ph1: (n) => ({ quality_rating: seq[n - 1], status: "CONNECTED" }) });
    const at = (i: number) => new Date(NOW.getTime() + i * 30 * MIN);
    await pollQuality({ now: at(0), read: m.read });
    await pollQuality({ now: at(1), read: m.read });
    expect(open("wa_quality_yellow")).toHaveLength(1);
    expect((open()[0].details as { greenPolls: number }).greenPolls).toBe(1);
    await pollQuality({ now: at(2), read: m.read });
    expect((open()[0].details as { greenPolls: number }).greenPolls).toBe(0);
    await pollQuality({ now: at(3), read: m.read });
    expect(open()).toHaveLength(1);
    const out = await pollQuality({ now: at(4), read: m.read });
    expect(out.cleared).toBe(1);
    expect(open()).toHaveLength(0);
    expect(ledger("breaker.clear")[0]).toMatchObject({ actorType: "breaker", reason: expect.stringContaining("high for 2 checks in a row") });
    expect(notices("breaker_cleared")[0]).toMatchObject({ severity: "fyi" });
    expect(phone().qualityRating).toBe("GREEN");
  });

  it("RED stays until two GREEN polls, even when the rating improves to YELLOW", async () => {
    const seq = ["RED", "YELLOW", "GREEN", "GREEN"];
    const m = meta({ meta_ph1: (n) => ({ quality_rating: seq[n - 1], status: "CONNECTED" }) });
    for (let i = 0; i < 2; i++) await pollQuality({ now: new Date(NOW.getTime() + i * 30 * MIN), read: m.read });
    expect(open().map((r) => r.kind).sort()).toEqual(["wa_quality_red", "wa_quality_yellow"]);
    for (let i = 2; i < 4; i++) await pollQuality({ now: new Date(NOW.getTime() + i * 30 * MIN), read: m.read });
    expect(open()).toHaveLength(0);
  });

  it("UNKNOWN, NA and a failed read keep the last known state: nothing opens, nothing clears, the rating stays", async () => {
    await applyQualityReading({ id: "ph1", tenantId: T, displayPhone: "+91 98000 00001" }, "YELLOW", NOW);
    phone().qualityRating = "YELLOW";
    for (const answer of [{ quality_rating: "UNKNOWN", status: "CONNECTED" }, { quality_rating: "NA", status: "CONNECTED" }, new Error("Meta is down")]) {
      const out = await pollQuality({ now: NOW, read: meta({ meta_ph1: answer }).read });
      expect(out.opened + out.cleared).toBe(0);
      expect(open("wa_quality_yellow")).toHaveLength(1);
      expect((open()[0].details as { greenPolls: number }).greenPolls).toBe(0);
      expect(phone().qualityRating).toBe("YELLOW");
    }
    const failed = await pollQuality({ now: NOW, read: meta({ meta_ph1: new Error("timeout") }).read });
    expect(failed).toMatchObject({ polled: 0, failed: 1 });
  });

  it("a number Meta does not report as CONNECTED keeps its breakers, is stored as such, and the gate holds automatic sends from it", async () => {
    await applyQualityReading({ id: "ph1", tenantId: T, displayPhone: "+91 98000 00001" }, "YELLOW", NOW);
    for (let i = 0; i < 3; i++) await pollQuality({ now: NOW, read: meta({ meta_ph1: { quality_rating: "GREEN", status: "DISCONNECTED" } }).read });
    expect(open("wa_quality_yellow")).toHaveLength(1);
    expect(phone().status).toBe("disconnected");
    const input = { marketing: false, isTemplate: true, windowOpen: false, breakers: [], sendable: numberSendable(phone().status as string) };
    expect(breakerOutcome("automation", input)).toEqual({ action: "hold", reason: "number_not_connected" });
    expect(breakerOutcome("api", input)).toEqual({ action: "hold", reason: "number_not_connected" });
    expect(breakerOutcome("human", input)).toEqual({ action: "send" });
    // Polled again when Meta says it is back.
    await pollQuality({ now: NOW, read: meta({ meta_ph1: { quality_rating: "GREEN", status: "CONNECTED" } }).read });
    expect(phone().status).toBe("connected");
  });

  it("skips workspaces without a sendable token (the demo workspace, an expired token) and numbers still in onboarding", async () => {
    h.db.seed("phoneNumber", [
      { ...PHONE, id: "ph2", tenantId: "demo", phoneNumberId: "meta_demo" },
      { ...PHONE, id: "ph3", tenantId: "expired", phoneNumberId: "meta_expired" },
      { ...PHONE, id: "ph4", status: "pending", phoneNumberId: "meta_pending" },
    ]);
    const m = meta({ meta_ph1: { quality_rating: "GREEN", status: "CONNECTED" } });
    const out = await pollQuality({ now: NOW, read: m.read });
    expect(m.calls.map((c) => c.path).filter((p) => p.startsWith("meta_"))).toEqual(["meta_ph1", "meta_waba_1"]);
    expect(out).toMatchObject({ polled: 1, skipped: 2 });
  });

  it("reads each WhatsApp account's billing currency once a day", async () => {
    const m = meta({ meta_ph1: { quality_rating: "GREEN", status: "CONNECTED" }, meta_waba_1: { currency: "usd" } });
    await pollQuality({ now: NOW, read: m.read });
    await pollQuality({ now: new Date(NOW.getTime() + 30 * MIN), read: m.read });
    expect(m.calls.filter((c) => c.fields === "currency")).toHaveLength(1);
    expect(await readWabaCurrencies(T)).toEqual({ wabas: { w1: { currency: "USD", at: NOW.toISOString() } } });
    expect(h.db.rows("platformSetting").some((s) => s.key === WABA_CURRENCY_KEY(T))).toBe(true);
    await pollQuality({ now: new Date(NOW.getTime() + 25 * 60 * MIN), read: m.read });
    expect(m.calls.filter((c) => c.fields === "currency")).toHaveLength(2);
  });

  it("the existing quality email fires from the fresh rating the poll stored", async () => {
    lifecycle.readState.mockResolvedValue({ rating: "GREEN" });
    await pollQuality({ now: NOW, read: meta({ meta_ph1: { quality_rating: "MEDIUM", status: "CONNECTED" } }).read });
    expect(await runQualityAlerts()).toBe(1);
    expect(lifecycle.emailOwners).toHaveBeenCalledWith(T, expect.any(Function));
    const mail = (lifecycle.emailOwners.mock.calls[0] as unknown as [string, () => { subject: string; text: string }])[1]();
    expect(`${mail.subject} ${mail.text}`).toMatch(/YELLOW|medium/i);
    expect(lifecycle.writeState).toHaveBeenCalledWith("lifecycle:quality:ph1", { rating: "YELLOW" });
  });
});

describe("account_update events (6.3)", () => {
  const waba = { id: "w1", tenantId: T, wabaId: "meta_waba_1" };

  it("RESTRICTED_BIZ_INITIATED_MESSAGING opens wa_restricted on the WABA until the expiration, and the gate holds templates outside a window", async () => {
    const out = await applyAccountUpdate(waba, { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: 1793836800 }] }, NOW);
    expect(out.handled).toBe("restricted");
    expect(open("wa_restricted")[0]).toMatchObject({ scopeType: "waba", scopeId: "w1", effect: "block_automated", autoClearAt: new Date("2026-11-05T00:00:00Z") });
    expect(notices("breaker_tripped")[0]).toMatchObject({ severity: "action_needed" });
    const hits = [{ kind: "wa_restricted", effect: "block_automated" as const }];
    expect(breakerOutcome("automation", { marketing: false, isTemplate: true, windowOpen: false, breakers: hits, sendable: true })).toEqual({ action: "hold", reason: "number_restricted" });
    expect(breakerOutcome("automation", { marketing: false, isTemplate: true, windowOpen: true, breakers: hits, sendable: true })).toEqual({ action: "send" });
    expect(breakerOutcome("chatbot", { marketing: false, isTemplate: false, windowOpen: true, breakers: hits, sendable: true })).toEqual({ action: "send" });
  });

  it("a restriction list without the business-initiated one lifts it", async () => {
    await applyAccountUpdate(waba, { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING" }] }, NOW);
    expect((await applyAccountUpdate(waba, { event: "ACCOUNT_RESTRICTION", restriction_info: [] }, NOW)).handled).toBe("restriction_lifted");
    expect(open("wa_restricted")).toHaveLength(0);
    expect(notices("breaker_cleared")).toHaveLength(1);
  });

  it("DISABLE opens waba_disabled and holds all automatic outbound; REINSTATE clears it", async () => {
    await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: ["DISABLE"] } }, NOW);
    expect(open("waba_disabled")[0]).toMatchObject({ effect: "block_automated", scopeType: "waba", scopeId: "w1" });
    const hits = [{ kind: "waba_disabled", effect: "block_automated" as const }];
    for (const origin of ["broadcast", "automation", "api", "mcp", "assistant"] as const) {
      expect(breakerOutcome(origin, { marketing: false, isTemplate: false, windowOpen: true, breakers: hits, sendable: true })).toEqual({ action: "hold", reason: "waba_disabled" });
    }
    expect(breakerOutcome("human", { marketing: false, isTemplate: false, windowOpen: true, breakers: hits, sendable: true })).toEqual({ action: "send" });
    expect((await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: "REINSTATE" } }, NOW)).handled).toBe("reinstated");
    expect(open()).toHaveLength(0);
    expect((notices("breaker_cleared")[0].payload as { body: string }).body).toContain("Paused broadcasts stay paused");
  });

  it("SCHEDULE_FOR_DISABLE blocks marketing at once and sends an urgent notice; REINSTATE clears it", async () => {
    await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: ["SCHEDULE_FOR_DISABLE"], waba_ban_date: "2026-11-10" } }, NOW);
    expect(open("waba_disable_scheduled")[0]).toMatchObject({ effect: "block_marketing" });
    const notice = notices("breaker_tripped")[0];
    expect(notice).toMatchObject({ severity: "action_needed" });
    expect((notice.payload as { title: string }).title).toMatch(/^Urgent: Meta plans to disable your WhatsApp account/);
    await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: ["REINSTATE"] } }, NOW);
    expect(open()).toHaveLength(0);
  });

  it("ACCOUNT_VIOLATION only notifies", async () => {
    await applyAccountUpdate(waba, { event: "ACCOUNT_VIOLATION", violation_info: { violation_type: "SCAM" } }, NOW);
    expect(breakers()).toHaveLength(0);
    const [notice] = notices();
    expect(notice).toMatchObject({ severity: "heads_up" });
    expect((notice.payload as { body: string }).body).toMatch(/^Meta's reason: scam\. Nothing was paused\./);
  });

  it("other events change nothing", async () => {
    expect((await applyAccountUpdate(waba, { event: "VERIFIED_ACCOUNT" }, NOW)).handled).toBeNull();
    expect(breakers()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });
});

describe("templates (6.3)", () => {
  beforeEach(() => {
    h.db.seed("template", [
      { id: "tp1", tenantId: T, wabaRefId: "w1", name: "promo", language: "en", category: "MARKETING", status: "approved" },
      { id: "tp2", tenantId: T, wabaRefId: "w1", name: "flagged_one", language: "en", category: "UTILITY", status: "flagged" },
    ]);
  });

  it("quality YELLOW stops assistants from using the template and tells the owner; GREEN lifts it", async () => {
    expect(await templateUsableByAssistant(T, "tp1", NOW)).toBe(true);
    await applyTemplateQuality(T, { id: "tp1", name: "promo" }, "YELLOW", NOW);
    expect(open("template_quality")[0]).toMatchObject({ scopeType: "template", scopeId: "tp1", effect: "notify_only" });
    expect(await templateUsableByAssistant(T, "tp1", NOW)).toBe(false);
    expect((notices("breaker_tripped")[0].payload as { title: string }).title).toBe('Template "promo"\'s quality dropped to medium');
    await applyTemplateQuality(T, { id: "tp1", name: "promo" }, "GREEN", NOW);
    expect(await templateUsableByAssistant(T, "tp1", NOW)).toBe(true);
  });

  it("a flagged template is never used by an assistant", async () => {
    expect(await templateUsableByAssistant(T, "tp2", NOW)).toBe(false);
  });

  it("PAUSED and DISABLED (and REJECTED) block every sender at send time; FLAGGED holds only marketing broadcasts and assistants", () => {
    for (const origin of SEND_ORIGINS) {
      for (const status of ["paused", "disabled", "rejected"]) expect(templateOutcome(origin, "UTILITY", status)).toEqual({ action: "fail", code: "template_blocked" });
    }
    expect(templateOutcome("broadcast", "MARKETING", "flagged")).toEqual({ action: "hold", reason: "template_flagged" });
    expect(templateOutcome("assistant", "UTILITY", "flagged")).toEqual({ action: "hold", reason: "template_flagged" });
    for (const origin of ["broadcast", "automation", "api", "mcp", "human", "chatbot"] as const) {
      expect(templateOutcome(origin, origin === "broadcast" ? "UTILITY" : "MARKETING", "flagged")).toEqual({ action: "send" });
    }
    expect(templateOutcome("automation", "MARKETING", "approved")).toEqual({ action: "send" });
  });
});

describe("delivery pricing (statuses[].pricing)", () => {
  it("is read as billable, type and category; free types read as not billable", () => {
    expect(parsePricing({ pricing: { billable: true, pricing_model: "PMP", category: "marketing", type: "regular" } })).toEqual({ billable: true, type: "regular", category: "marketing" });
    expect(parsePricing({ pricing: { pricing_model: "PMP", category: "service", type: "free_customer_service" } })).toEqual({ billable: false, type: "free_customer_service", category: "service" });
    expect(parsePricing({ pricing: { billable: false, pricing_model: "CBP", category: "referral_conversion" } })).toEqual({ billable: false, type: "cbp", category: "referral_conversion" });
    expect(parsePricing({})).toBeNull();
    expect(parsePricing({ pricing: {} })).toBeNull();
  });
});

describe("every safety stop speaks plainly", () => {
  it("each breaker has a plain reason and each notice a title and a next step, in the product's words", async () => {
    const ref = { id: "ph1", tenantId: T, displayPhone: "+91 98000 00001" };
    const waba = { id: "w1", tenantId: T };
    await applyQualityReading(ref, "YELLOW", NOW);
    await applyQualityReading(ref, "RED", NOW);
    await applyAccountUpdate(waba, { event: "ACCOUNT_RESTRICTION", restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING" }] }, NOW);
    await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: "SCHEDULE_FOR_DISABLE" } }, NOW);
    await applyAccountUpdate(waba, { event: "DISABLED_UPDATE", ban_info: { waba_ban_state: "DISABLE" } }, NOW);
    await applyTemplateQuality(T, { id: "tp9", name: "promo" }, "RED", NOW);
    expect(breakers()).toHaveLength(6);
    const banned = /minor units|spend_cap|allowance pot|commitment|probation|breaker|!/i;
    for (const r of breakers() as Row[]) {
      expect(String(r.reason).length).toBeGreaterThan(20);
      expect(String(r.reason)).not.toMatch(banned);
    }
    expect(notices()).toHaveLength(6);
    for (const n of notices()) {
      const { title, body, link } = n.payload as { title: string; body: string; link: string };
      expect(title.length).toBeGreaterThan(10);
      expect(`${title} ${body}`).not.toMatch(banned);
      expect(link).toMatch(/^\/app\//);
    }
  });
});
