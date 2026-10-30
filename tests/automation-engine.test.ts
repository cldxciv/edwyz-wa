import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() });
  return { contact: model(), conversation: model(), automationRule: model(), automationRun: model(), message: model(), platformSetting: { findUnique: vi.fn() } };
});
const sendText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText }));

import { orderRules, pickRule, runAutomationsForInbound, type RuleLike } from "@/lib/automation/engine";

const rule = (over: Partial<RuleLike> & { id: string; type: RuleLike["type"] }): RuleLike => ({
  phoneNumberId: null,
  keywords: [],
  matchMode: "contains",
  replyText: "auto reply",
  schedule: null,
  cooldownMinutes: 60,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});
const AWAY = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
const base = { tenantId: "t1", phoneNumberId: "ph1", conversationId: "cv1", contactId: "c1", receivedAt: new Date("2026-10-26T20:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  db.contact.findFirst.mockResolvedValue({ optedOutAt: null, createdAt: new Date("2026-01-01T00:00:00Z") });
  db.conversation.findFirst.mockResolvedValue({ status: "open" });
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.automationRun.findFirst.mockResolvedValue(null);
  db.automationRun.create.mockResolvedValue({ id: "run1" });
  db.message.findFirst.mockResolvedValue(null);
  sendText.mockResolvedValue({ id: "m1" });
});

describe("rule ordering and selection", () => {
  it("orders keyword, then welcome, then away, then by age", () => {
    const rules = [rule({ id: "away", type: "away" }), rule({ id: "welcome", type: "welcome" }), rule({ id: "k2", type: "keyword", createdAt: new Date("2026-02-01") }), rule({ id: "k1", type: "keyword" })];
    expect(orderRules(rules).map((r) => r.id)).toEqual(["k1", "k2", "welcome", "away"]);
  });

  it("skips rules bound to another number but accepts unbound ones", async () => {
    const bound = rule({ id: "b", type: "keyword", keywords: ["hi"], phoneNumberId: "other" });
    const open = rule({ id: "o", type: "keyword", keywords: ["hi"] });
    const picked = await pickRule([bound, open], "ph1", { text: "hi", receivedAt: new Date(), silentMinutes: 0 }, async () => false);
    expect(picked?.id).toBe("o");
  });

  it("falls through to the next rule when the first is cooling down", async () => {
    const a = rule({ id: "a", type: "keyword", keywords: ["hi"] });
    const b = rule({ id: "b", type: "welcome" });
    const picked = await pickRule([a, b], "ph1", { text: "hi", receivedAt: new Date(), silentMinutes: null }, async (r) => r.id === "a");
    expect(picked?.id).toBe("b");
  });

  it("welcome fires for a first message or after the cooldown of silence only", async () => {
    const w = rule({ id: "w", type: "welcome", cooldownMinutes: 720 });
    const ctx = (silentMinutes: number | null) => ({ text: "x", receivedAt: new Date(), silentMinutes });
    expect(await pickRule([w], "p", ctx(null), async () => false)).toBe(w);
    expect(await pickRule([w], "p", ctx(719), async () => false)).toBeNull();
    expect(await pickRule([w], "p", ctx(720), async () => false)).toBe(w);
  });

  it("away fires only outside open hours, and never with a broken schedule", async () => {
    const away = rule({ id: "a", type: "away", schedule: AWAY });
    const at = (iso: string) => ({ text: "x", receivedAt: new Date(iso), silentMinutes: 0 });
    expect(await pickRule([away], "p", at("2026-10-26T20:00:00Z"), async () => false)).toBe(away);
    expect(await pickRule([away], "p", at("2026-10-26T10:00:00Z"), async () => false)).toBeNull();
    expect(await pickRule([rule({ id: "x", type: "away", schedule: { bad: true } })], "p", at("2026-10-26T20:00:00Z"), async () => false)).toBeNull();
  });
});

describe("runAutomationsForInbound", () => {
  it("sends exactly one reply even when several rules match, preferring keyword", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "away", type: "away", schedule: AWAY }), rule({ id: "k", type: "keyword", keywords: ["price"], replyText: "Prices: ..." }), rule({ id: "w", type: "welcome" })]);
    const result = await runAutomationsForInbound({ ...base, text: "what is the price" });
    expect(result).toEqual({ replied: true, ruleId: "k" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: "Prices: ...", origin: "automation" });
    expect(db.automationRun.create).toHaveBeenCalledWith({ data: { tenantId: "t1", ruleId: "k", conversationId: "cv1" } });
  });

  it("scopes every query to the tenant", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    await runAutomationsForInbound({ ...base, text: "hello" });
    expect(db.automationRule.findMany).toHaveBeenCalledWith({ where: { tenantId: "t1", enabled: true } });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    expect(db.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", conversationId: "cv1", direction: "inbound" }) }));
  });

  it("respects the per-rule cooldown through AutomationRun rows", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "k", type: "keyword", keywords: ["hi"], cooldownMinutes: 30 })]);
    db.automationRun.findFirst.mockImplementation(async ({ where }) => (where.ruleId === "k" ? { id: "old" } : null));
    const result = await runAutomationsForInbound({ ...base, text: "hi" });
    expect(result.replied).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    const cooldownQuery = db.automationRun.findFirst.mock.calls.find(([a]) => a.where.ruleId === "k")![0];
    const since = cooldownQuery.where.createdAt.gte as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(Date.now() - since.getTime()).toBeLessThan(30 * 60_000 + 5000);
  });

  it("loop protection: no automatic reply when one was sent to this conversation moments ago", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "k", type: "keyword", keywords: ["hi"] })]);
    db.automationRun.findFirst.mockImplementation(async ({ where }) => (where.ruleId === undefined ? { id: "recent" } : null));
    const result = await runAutomationsForInbound({ ...base, text: "hi" });
    expect(result).toMatchObject({ replied: false });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("never replies in a blocked conversation", async () => {
    db.conversation.findFirst.mockResolvedValue({ status: "blocked" });
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    expect(await runAutomationsForInbound({ ...base, text: "hello" })).toMatchObject({ replied: false, skipped: "conversation is blocked" });
    expect(sendText).not.toHaveBeenCalled();
    expect(db.automationRule.findMany).not.toHaveBeenCalled();
  });

  it("classic rules stay quiet when a chatbot or the AI agent already answered", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    expect(await runAutomationsForInbound({ ...base, text: "hello", botHandled: true })).toMatchObject({ replied: false });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("never replies to opted-out contacts", async () => {
    db.contact.findFirst.mockResolvedValue({ optedOutAt: new Date(), createdAt: new Date() });
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    expect((await runAutomationsForInbound({ ...base, text: "hello" })).replied).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(db.automationRule.findMany).not.toHaveBeenCalled();
  });

  it.each(["STOP", " unsubscribe ", "End"])("never replies to the opt-out message %j", async (text) => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    expect((await runAutomationsForInbound({ ...base, text })).replied).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does nothing when there are no enabled rules", async () => {
    db.automationRule.findMany.mockResolvedValue([]);
    expect((await runAutomationsForInbound({ ...base, text: "hi" })).replied).toBe(false);
  });

  it("computes silence from the previous inbound message for welcome", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome", cooldownMinutes: 720 })]);
    db.message.findFirst.mockResolvedValue({ createdAt: new Date(base.receivedAt.getTime() - 60 * 60_000) });
    expect((await runAutomationsForInbound({ ...base, text: "hello" })).replied).toBe(false);
    db.message.findFirst.mockResolvedValue({ createdAt: new Date(base.receivedAt.getTime() - 13 * 3600_000) });
    expect((await runAutomationsForInbound({ ...base, text: "hello" })).replied).toBe(true);
  });

  it("removes the run row when sending fails so the next message can retry", async () => {
    db.automationRule.findMany.mockResolvedValue([rule({ id: "w", type: "welcome" })]);
    sendText.mockRejectedValue(new Error("boom"));
    await expect(runAutomationsForInbound({ ...base, text: "hello" })).rejects.toThrow("boom");
    expect(db.automationRun.deleteMany).toHaveBeenCalledWith({ where: { id: "run1", tenantId: "t1" } });
  });
});
