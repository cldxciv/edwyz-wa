import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() });
  return { contact: model(), conversation: model(), automationRule: model(), automationRun: model(), message: model(), ruleExecution: model(), platformSetting: model() };
});
const sendText = vi.hoisted(() => vi.fn());
const fire = vi.hoisted(() => vi.fn());
const mayRun = vi.hoisted(() => vi.fn());
const busy = vi.hoisted(() => vi.fn());
const remaining = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => ({ sendText }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: mayRun }));
vi.mock("@/lib/automation/v2/run", () => ({ fireRulesSafely: fire, busyReason: busy }));
vi.mock("@/lib/automation/v2/metering", () => ({ remainingTriggers: remaining }));

import { runAutomationsForInbound } from "@/lib/automation/engine";
import { answerWithHolidayMode } from "@/lib/automation/v2/holiday";
import { getAutomationSettings, isHolidayActive, updateAutomationSettings, validateSettingsPatch } from "@/lib/automation/v2/settings";

const base = { tenantId: "t1", phoneNumberId: "ph1", conversationId: "cv1", contactId: "c1", receivedAt: new Date("2026-10-27T10:00:00Z"), text: "hello" };
const v2 = { id: "v2a", version: 2, type: "keyword", keywords: [], matchMode: "contains", replyText: "", schedule: null, cooldownMinutes: 5, phoneNumberId: null, createdAt: new Date("2026-01-01") };
const classic = { id: "w", version: 1, type: "welcome", keywords: [], matchMode: "contains", replyText: "Classic hello", schedule: null, cooldownMinutes: 60, phoneNumberId: null, createdAt: new Date("2026-01-01") };

function holiday(over: Record<string, unknown> = {}) {
  db.platformSetting.findUnique.mockResolvedValue({ value: { mode: "first_match", holiday: { enabled: true, message: "We are away, {{first_name}}.", endsOn: null, timezone: "UTC", ...over } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.contact.findFirst.mockResolvedValue({ optedOutAt: null, createdAt: new Date("2026-01-01"), name: "Asha Rao", phone: "+91", attributes: {} });
  db.conversation.findFirst.mockResolvedValue({ status: "open" });
  db.message.findFirst.mockResolvedValue({ createdAt: new Date("2026-10-26T10:00:00Z") });
  db.automationRun.findFirst.mockResolvedValue(null);
  db.automationRun.create.mockResolvedValue({ id: "run1" });
  db.ruleExecution.findFirst.mockResolvedValue(null);
  db.ruleExecution.create.mockResolvedValue({});
  db.platformSetting.findUnique.mockResolvedValue(null);
  sendText.mockResolvedValue({ id: "m1" });
  fire.mockResolvedValue({ fired: 0, replied: false });
  mayRun.mockResolvedValue(true);
  busy.mockResolvedValue(null);
  remaining.mockResolvedValue(null);
});

describe("inbound orchestration", () => {
  it("runs v2 rules for a message and skips the classic ones when v2 replied", async () => {
    db.automationRule.findMany.mockResolvedValue([v2, classic]);
    fire.mockResolvedValue({ fired: 1, replied: true });
    expect(await runAutomationsForInbound(base)).toEqual({ replied: true });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0][0]).toMatchObject({ type: "message_received", tenantId: "t1", contactId: "c1", conversationId: "cv1", message: { text: "hello", messageType: "text", newChat: false, answeredBy: null, phoneNumberId: "ph1" } });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falls back to the classic rules when no v2 rule replied", async () => {
    db.automationRule.findMany.mockResolvedValue([v2, classic]);
    const result = await runAutomationsForInbound({ ...base, receivedAt: new Date("2026-10-28T10:00:00Z") });
    expect(result).toEqual({ replied: true, ruleId: "w" });
    expect(sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: "Classic hello", origin: "automation" });
  });

  it("classic rows never run twice because a v2 row shares the table", async () => {
    db.automationRule.findMany.mockResolvedValue([{ ...v2, replyText: "should never be sent" }]);
    expect((await runAutomationsForInbound(base)).replied).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("fires the new-contact trigger first for a first message from a brand new contact, then tells message rules it was answered", async () => {
    db.automationRule.findMany.mockResolvedValue([v2]);
    db.message.findFirst.mockResolvedValue(null);
    db.contact.findFirst.mockResolvedValue({ optedOutAt: null, createdAt: new Date("2026-10-27T09:59:30Z") });
    fire.mockResolvedValueOnce({ fired: 1, replied: true }).mockResolvedValueOnce({ fired: 0, replied: false });
    await runAutomationsForInbound(base);
    expect(fire.mock.calls.map(([e]) => e.type)).toEqual(["contact_created", "message_received"]);
    expect(fire.mock.calls[0][0].message).toMatchObject({ newChat: true, answeredBy: null });
    expect(fire.mock.calls[1][0].message).toMatchObject({ newChat: true, answeredBy: "rule" });
  });

  it("does not fire the new-contact trigger for an old contact writing for the first time in a new chat", async () => {
    db.automationRule.findMany.mockResolvedValue([v2]);
    db.message.findFirst.mockResolvedValue(null);
    await runAutomationsForInbound(base);
    expect(fire.mock.calls.map(([e]) => e.type)).toEqual(["message_received"]);
  });

  it("when a chatbot or the AI agent answered, only internal steps may run and classic rules stay quiet", async () => {
    db.automationRule.findMany.mockResolvedValue([v2, classic]);
    const result = await runAutomationsForInbound({ ...base, botHandled: true });
    expect(result).toMatchObject({ replied: false, skipped: expect.stringContaining("chatbot") });
    expect(fire.mock.calls[0][0].message.answeredBy).toBe("bot");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("passes the kind of message through", async () => {
    db.automationRule.findMany.mockResolvedValue([v2]);
    await runAutomationsForInbound({ ...base, text: "", messageType: "image" });
    expect(fire.mock.calls[0][0].message).toMatchObject({ text: "", messageType: "image" });
  });

  it("never runs anything for opted-out contacts or STOP", async () => {
    db.automationRule.findMany.mockResolvedValue([v2, classic]);
    expect((await runAutomationsForInbound({ ...base, text: "STOP" })).replied).toBe(false);
    db.contact.findFirst.mockResolvedValue({ optedOutAt: new Date(), createdAt: new Date() });
    expect((await runAutomationsForInbound(base)).replied).toBe(false);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("holiday mode", () => {
  it("answers once, logs it, and pauses classic rules and customer-facing v2 steps", async () => {
    holiday();
    db.automationRule.findMany.mockResolvedValue([v2, classic]);
    const result = await runAutomationsForInbound(base);
    expect(result).toEqual({ replied: true });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: "We are away, Asha.", origin: "automation" });
    expect(db.ruleExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", ruleId: "holiday", outcome: "ok", conversationId: "cv1" }) });
    expect(fire.mock.calls[0][0].message.answeredBy).toBe("rule");
  });

  it("does not repeat within 12 hours and still blocks the classic reply", async () => {
    holiday();
    db.automationRule.findMany.mockResolvedValue([classic]);
    db.ruleExecution.findFirst.mockResolvedValue({ id: "earlier" });
    const result = await runAutomationsForInbound({ ...base, receivedAt: new Date("2026-10-28T10:00:00Z") });
    expect(result).toMatchObject({ replied: false, skipped: "holiday mode answered" });
    expect(sendText).not.toHaveBeenCalled();
    const since = db.ruleExecution.findFirst.mock.calls[0][0].where.createdAt.gte as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThan(0);
  });

  it("works even when the workspace has no rules at all", async () => {
    holiday();
    db.automationRule.findMany.mockResolvedValue([]);
    expect((await runAutomationsForInbound(base)).replied).toBe(true);
  });

  it("an expired or switched off holiday does nothing", async () => {
    const now = new Date("2026-10-27T10:00:00Z");
    expect(isHolidayActive({ enabled: true, message: "x", endsOn: "2026-10-26", timezone: "UTC" }, now)).toBe(false);
    expect(isHolidayActive({ enabled: true, message: "x", endsOn: "2026-10-27", timezone: "UTC" }, now)).toBe(true);
    expect(isHolidayActive({ enabled: false, message: "x", endsOn: null, timezone: "UTC" }, now)).toBe(false);
    expect(isHolidayActive({ enabled: true, message: "  ", endsOn: null, timezone: "UTC" }, now)).toBe(false);
    holiday({ enabled: false });
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now })).toBe("inactive");
  });

  it("stays out of chats a person or a chatbot is handling, and lets the normal rules decide", async () => {
    holiday();
    busy.mockResolvedValue("a person is handling this chat");
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("inactive");
    expect(sendText).not.toHaveBeenCalled();
    expect(db.ruleExecution.create).not.toHaveBeenCalled();
  });

  it("stops when the monthly rule allowance is used up", async () => {
    holiday();
    remaining.mockResolvedValue(0);
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("inactive");
    remaining.mockResolvedValue(3);
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("sent");
  });

  it("an enabled holiday with no message, or one that ended yesterday, never sends", async () => {
    holiday({ message: "   " });
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("inactive");
    holiday({ endsOn: "2026-10-26" });
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("inactive");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("logs a failed holiday reply without throwing", async () => {
    holiday();
    sendText.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await answerWithHolidayMode({ tenantId: "t1", conversationId: "cv1", contactId: "c1", now: base.receivedAt })).toBe("failed");
    expect(db.ruleExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ outcome: "failed", ruleId: "holiday" }) });
    spy.mockRestore();
  });
});

describe("settings", () => {
  it("defaults to first match with holiday mode off", async () => {
    expect(await getAutomationSettings("t1")).toEqual({ mode: "first_match", holiday: { enabled: false, message: "", endsOn: null, timezone: "UTC" } });
  });

  it("validates the patch", () => {
    expect(() => validateSettingsPatch({ mode: "everything" })).toThrow(/mode/);
    expect(() => validateSettingsPatch({ holiday: { endsOn: "tomorrow" } })).toThrow(/last day/);
    expect(() => validateSettingsPatch({ holiday: { timezone: "Mars/Base" } })).toThrow(/timezone/);
    expect(() => validateSettingsPatch({ holiday: { message: "x".repeat(1025) } })).toThrow(/1024/);
    expect(validateSettingsPatch({ mode: "all_matching", holiday: { enabled: true } })).toEqual({ mode: "all_matching", holiday: { enabled: true } });
  });

  it("will not switch holiday mode on without a message, and saves per tenant", async () => {
    await expect(updateAutomationSettings("t1", { holiday: { enabled: true } })).rejects.toThrow(/holiday message/);
    const saved = await updateAutomationSettings("t1", { holiday: { enabled: true, message: "Away", endsOn: "2026-11-01", timezone: "Asia/Kolkata" }, mode: "all_matching" });
    expect(saved.holiday).toMatchObject({ enabled: true, message: "Away", endsOn: "2026-11-01" });
    expect(db.platformSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "automation:t1" } }));
  });
});
