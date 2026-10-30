import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() });
  return { automationRule: model(), conversation: model(), contact: model(), platformSetting: model(), ruleExecution: model(), membership: model(), plan: model(), segment: model() };
});
const fire = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
const email = vi.hoisted(() => vi.fn());
const billing = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/automation/v2/run", () => ({ fireRulesSafely: fire, byPriority: () => 0 }));
vi.mock("@/lib/queue", () => ({ enqueue }));
vi.mock("@/lib/email", () => ({ queueEmail: email }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: billing }));

import { highestThreshold, readLimit, resetMeteringCache, sendQuotaAlerts } from "@/lib/automation/v2/metering";
import { audienceWhere, dueRunKey, MAX_AUDIENCE, MAX_SCAN, purgeOld, scanNoResponse, scanScheduled, scheduledJobHandler, SCHEDULE_QUEUE } from "@/lib/automation/v2/timed";
import { worker } from "@/lib/automation/worker";
import { eventJobHandler } from "@/lib/automation/v2/event-handler";
import { EVENT_QUEUE } from "@/lib/automation/v2/emit";

const NOW = new Date("2026-10-27T10:00:00Z");
const ctx = { attempt: 1, maxAttempts: 3, isLastAttempt: false };
const filters = { root: { type: "group", op: "and", items: [] }, options: { allowWhenHumanActive: false } };
const row = (trigger: unknown, over: Record<string, unknown> = {}) => ({
  id: "r1",
  tenantId: "t1",
  name: "Rule",
  version: 2,
  enabled: true,
  phoneNumberId: null,
  priority: 10,
  cooldownMinutes: 5,
  stopAfterMatch: false,
  createdAt: new Date(1),
  trigger,
  filters,
  actions: [{ type: "add_tag", tag: "cold", scope: "contact" }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetMeteringCache();
  fire.mockResolvedValue({ fired: 1, replied: false });
  db.platformSetting.create.mockResolvedValue({});
  db.platformSetting.deleteMany.mockResolvedValue({ count: 0 });
  db.ruleExecution.deleteMany.mockResolvedValue({ count: 3 });
  billing.mockResolvedValue({ state: "exempt", planId: null });
});

describe("no customer response", () => {
  it("checks chats whose last message is ours and old enough, once per customer message", async () => {
    const r = row({ type: "no_customer_response", minutes: 60 });
    db.automationRule.findMany.mockResolvedValue([r]);
    db.conversation.findMany.mockResolvedValue([
      { id: "cv1", contactId: "c1", lastInboundAt: new Date("2026-10-27T07:00:00Z"), lastMessageAt: new Date("2026-10-27T08:30:00Z") },
      { id: "cv2", contactId: "c2", lastInboundAt: new Date("2026-10-27T08:45:00Z"), lastMessageAt: new Date("2026-10-27T08:40:00Z") },
      { id: "cv3", contactId: "c3", lastInboundAt: null, lastMessageAt: new Date("2026-10-27T08:00:00Z") },
    ]);
    expect(await scanNoResponse(NOW)).toBe(2);
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect((where.lastMessageAt.lte as Date).toISOString()).toBe("2026-10-27T09:00:00.000Z");
    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire.mock.calls[0][0]).toMatchObject({ type: "no_customer_response", tenantId: "t1", contactId: "c1", conversationId: "cv1", ruleId: "r1", dedupeSince: new Date("2026-10-27T07:00:00Z") });
    expect(fire.mock.calls[1][0].dedupeSince.getTime()).toBe(NOW.getTime() - 30 * 86_400_000);
    expect(fire.mock.calls[0][1]).toEqual([r]);
  });

  it("restricts to the rule's WhatsApp number and ignores other trigger types", async () => {
    db.automationRule.findMany.mockResolvedValue([row({ type: "no_customer_response", minutes: 30 }, { phoneNumberId: "ph9" }), row({ type: "message_received" }, { id: "r2" })]);
    db.conversation.findMany.mockResolvedValue([]);
    await scanNoResponse(NOW);
    expect(db.conversation.findMany).toHaveBeenCalledTimes(1);
    expect(db.conversation.findMany.mock.calls[0][0].where.phoneNumberId).toBe("ph9");
  });
});

describe("schedules", () => {
  const daily = { type: "scheduled", repeat: "daily", time: "10:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" };

  it("claims a due run once and queues its first chunk", async () => {
    db.automationRule.findMany.mockResolvedValue([row(daily)]);
    expect(await scanScheduled(NOW)).toBe(1);
    expect(db.platformSetting.create).toHaveBeenCalledWith({ data: { key: "automation-run:r1:day:2026-10-27", value: { at: NOW.toISOString() } } });
    expect(enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, { tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0, fired: 0 }, { maxAttempts: 3 });
    db.platformSetting.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    enqueue.mockClear();
    expect(await scanScheduled(new Date("2026-10-27T10:01:00Z"))).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing before the time of day", async () => {
    db.automationRule.findMany.mockResolvedValue([row(daily)]);
    expect(await scanScheduled(new Date("2026-10-27T09:59:00Z"))).toBe(0);
    expect(db.platformSetting.create).not.toHaveBeenCalled();
  });

  it("works through the audience in chunks, scoped to the tenant and skipping opted-out people", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    const people = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` }));
    db.contact.findMany.mockResolvedValue(people);
    db.conversation.findFirst.mockImplementation(async ({ where }) => (where.contactId === "c0" ? { id: "cv0" } : null));
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0 }, ctx);
    expect(db.contact.findMany.mock.calls[0][0].where).toEqual({ AND: [{ tenantId: "t1", optedOutAt: null }, {}] });
    expect(db.automationRule.findFirst).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1", enabled: true, version: 2 } });
    expect(fire).toHaveBeenCalledTimes(50);
    expect(fire.mock.calls[0][0]).toMatchObject({ type: "scheduled", contactId: "c0", conversationId: "cv0", ruleId: "r1", dedupeSince: NOW });
    expect(fire.mock.calls[1][0].conversationId).toBeNull();
    expect(enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, expect.objectContaining({ cursor: "c49", processed: 50, fired: 50 }), { maxAttempts: 3 });
  });

  it("stops at the last page, at the audience cap, and when the rule is gone", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    db.contact.findMany.mockResolvedValue([{ id: "c1" }]);
    db.conversation.findFirst.mockResolvedValue(null);
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: "c0", processed: 0 }, ctx);
    expect(enqueue).not.toHaveBeenCalled();
    db.contact.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` })));
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 6000, fired: MAX_AUDIENCE - 50 }, ctx);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.ruleExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", ruleId: "r1", outcome: "skipped", detail: expect.stringContaining("5,000") }) });
    db.automationRule.findFirst.mockResolvedValue(null);
    fire.mockClear();
    await scheduledJobHandler({ tenantId: "t1", ruleId: "gone", startedAt: NOW.toISOString(), cursor: null, processed: 0 }, ctx);
    expect(fire).not.toHaveBeenCalled();
    await scheduledJobHandler({ nonsense: true }, ctx);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("scheduled runs: audience and timing", () => {
  const daily = { type: "scheduled", repeat: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" };
  const triggerOf = (t: unknown) => t as Parameters<typeof dueRunKey>[0];

  it("the audience cap counts contacts the rule reached, not contacts looked at", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    db.conversation.findFirst.mockResolvedValue(null);
    db.contact.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` })));
    fire.mockResolvedValue({ fired: 0, replied: false });
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: "x", processed: MAX_AUDIENCE + 100, fired: 0 }, ctx);
    expect(enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, expect.objectContaining({ processed: MAX_AUDIENCE + 150, fired: 0 }), { maxAttempts: 3 });
    expect(db.ruleExecution.create).not.toHaveBeenCalled();
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: "x", processed: MAX_SCAN - 10, fired: 0 }, ctx);
    expect(db.ruleExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ outcome: "skipped", detail: expect.stringContaining("200,000") }) });
  });

  it("narrows the walk with the rule's tag and segment conditions", async () => {
    db.segment.findFirst.mockResolvedValue({ filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    const def = {
      trigger: daily,
      filters: { root: { type: "group", op: "and", items: [{ type: "tag", tag: "vip", has: true }, { type: "segment", segmentId: "s1", member: true }] }, options: { allowWhenHumanActive: false } },
      actions: [],
    } as unknown as Parameters<typeof audienceWhere>[1];
    const where = await audienceWhere("t1", def, NOW);
    expect(JSON.stringify(where)).toContain("hasSome");
    expect(JSON.stringify(where)).toContain('"tags":{"has":"vip"}');
    expect(db.segment.findFirst).toHaveBeenCalledWith({ where: { id: "s1", tenantId: "t1" }, select: { filter: true } });
    const or = { ...def, filters: { ...def.filters, root: { ...def.filters.root, op: "or" } } } as typeof def;
    expect(await audienceWhere("t1", or, NOW)).toEqual({});
  });

  it("does not run at once for a rule that was saved or switched on after today's time", () => {
    const t = triggerOf(daily);
    const afternoon = new Date("2026-10-27T15:00:00Z");
    expect(dueRunKey(t, afternoon)).toBe("day:2026-10-27");
    expect(dueRunKey(t, afternoon, new Date("2026-10-27T14:59:00Z"))).toBeNull();
    expect(dueRunKey(t, afternoon, new Date("2026-10-27T08:00:00Z"))).toBe("day:2026-10-27");
    expect(dueRunKey(t, new Date("2026-10-28T09:00:20Z"), new Date("2026-10-27T14:59:00Z"))).toBe("day:2026-10-28");
    expect(dueRunKey(t, new Date("2026-10-27T09:00:20Z"), new Date("2026-10-27T09:00:10Z"))).toBeNull();
  });

  it("applies the same rule to one-time schedules, including the late catch-up the next morning", () => {
    const once = triggerOf({ type: "scheduled", repeat: "once", date: "2026-10-27", time: "09:00", days: [], timezone: "UTC" });
    expect(dueRunKey(once, new Date("2026-10-27T09:05:00Z"), new Date("2026-10-26T12:00:00Z"))).toBe("once:2026-10-27");
    expect(dueRunKey(once, new Date("2026-10-27T09:05:00Z"), new Date("2026-10-27T09:04:00Z"))).toBeNull();
    expect(dueRunKey(once, new Date("2026-10-28T01:00:00Z"), new Date("2026-10-26T12:00:00Z"))).toBe("once:2026-10-27");
    expect(dueRunKey(once, new Date("2026-10-29T01:00:00Z"), new Date("2026-10-26T12:00:00Z"))).toBeNull();
  });

  it("the scan passes the rule's last edit time, so a fresh rule waits for its next time", async () => {
    db.automationRule.findMany.mockResolvedValue([row(daily, { updatedAt: new Date("2026-10-27T09:30:00Z") })]);
    expect(await scanScheduled(new Date("2026-10-27T10:00:00Z"))).toBe(0);
    expect(db.platformSetting.create).not.toHaveBeenCalled();
    db.automationRule.findMany.mockResolvedValue([row(daily, { updatedAt: new Date("2026-10-27T08:30:00Z") })]);
    expect(await scanScheduled(new Date("2026-10-27T10:00:00Z"))).toBe(1);
  });

  it("gives the day's run back when it could not be queued, so the next tick retries", async () => {
    db.automationRule.findMany.mockResolvedValue([row(daily)]);
    enqueue.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await scanScheduled(NOW)).toBe(0);
    spy.mockRestore();
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "automation-run:r1:day:2026-10-27" } });
  });

  it("writes a failed note when the last attempt of a chunk fails", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    db.contact.findMany.mockRejectedValue(new Error("db down"));
    const payload = { tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0 };
    await expect(scheduledJobHandler(payload, ctx)).rejects.toThrow("db down");
    expect(db.ruleExecution.create).not.toHaveBeenCalled();
    await expect(scheduledJobHandler(payload, { ...ctx, isLastAttempt: true })).rejects.toThrow("db down");
    expect(db.ruleExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", ruleId: "r1", outcome: "failed" }) });
  });
});

describe("quota alerts", () => {
  it("reads the limit from plan features", () => {
    expect(readLimit({ automationTriggersMonthly: 500 })).toBe(500);
    expect(readLimit({ automationTriggersMonthly: -1 })).toBeNull();
    expect(readLimit({ automationTriggersMonthly: "lots" })).toBeNull();
    expect(readLimit(null)).toBeNull();
    expect(highestThreshold(79, 100)).toBeNull();
    expect(highestThreshold(80, 100)).toBe(80);
    expect(highestThreshold(95, 100)).toBe(90);
    expect(highestThreshold(130, 100)).toBe(100);
    expect(highestThreshold(5, 0)).toBeNull();
  });

  it("emails owners and admins once per month and threshold", async () => {
    billing.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue({ features: { automationTriggersMonthly: 100 } });
    db.ruleExecution.groupBy.mockResolvedValue([
      { tenantId: "t1", _count: { _all: 91 } },
      { tenantId: "t2", _count: { _all: 10 } },
    ]);
    db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", disabledAt: null } }, { user: { email: "off@example.com", disabledAt: new Date() } }]);
    expect(await sendQuotaAlerts(NOW)).toBe(1);
    expect(db.platformSetting.create).toHaveBeenCalledWith({ data: { key: "automation-alert:t1:2026-10:90", value: { at: NOW.toISOString() } } });
    expect(email).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com", subject: expect.stringContaining("90%") }));
    expect(db.membership.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", role: { in: ["owner", "admin"] } });
    email.mockClear();
    db.platformSetting.create.mockRejectedValue(new Error("exists"));
    expect(await sendQuotaAlerts(NOW)).toBe(0);
    expect(email).not.toHaveBeenCalled();
  });

  it("sends nothing for plans without a limit", async () => {
    db.ruleExecution.groupBy.mockResolvedValue([{ tenantId: "t1", _count: { _all: 9999 } }]);
    expect(await sendQuotaAlerts(NOW)).toBe(0);
    expect(email).not.toHaveBeenCalled();
  });
});

describe("housekeeping and wiring", () => {
  it("deletes history older than 90 days", async () => {
    expect(await purgeOld(NOW)).toBe(3);
    const cutoff = db.ruleExecution.deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    expect(Math.round((NOW.getTime() - cutoff.getTime()) / 86_400_000)).toBe(90);
  });

  it("registers its queues and periodic tasks with the worker", () => {
    expect(Object.keys(worker.queues).sort()).toEqual([EVENT_QUEUE, SCHEDULE_QUEUE].sort());
    expect(worker.periodic.map((p) => p.name).sort()).toEqual(["automation-no-response", "automation-purge", "automation-quota-alerts", "automation-scheduled"]);
    expect(worker.periodic.every((p) => p.everyMs >= 60_000)).toBe(true);
  });

  it("the event handler ignores payloads it does not understand and passes real ones on", async () => {
    await eventJobHandler({ type: "bogus" }, ctx);
    expect(fire).not.toHaveBeenCalled();
    await eventJobHandler({ type: "tag_added", tenantId: "t1", contactId: "c1", conversationId: "cv1", tags: ["vip"] }, ctx);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ type: "tag_added", tenantId: "t1", contactId: "c1", conversationId: "cv1", tags: ["vip"] }));
    await eventJobHandler({ type: "status_changed", tenantId: "t1", contactId: "c1", from: "open", to: "solved" }, ctx);
    expect(fire.mock.calls[1][0].status).toEqual({ from: "open", to: "solved" });
  });
});

describe("scheduled runs and the WhatsApp limit (docs/SPEND-CONTROLS-SPEC.md 4.9)", () => {
  const daily = { type: "scheduled", repeat: "daily", time: "10:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" };

  it("a run's hold goes to every send of every chunk, and the rest is given back a little after the last chunk", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    db.contact.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    db.conversation.findFirst.mockResolvedValue(null);
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0, reservationId: "sr_1" }, ctx);
    expect(fire).toHaveBeenCalledTimes(2);
    for (const [event] of fire.mock.calls) expect(event).toMatchObject({ type: "scheduled", reservationId: "sr_1" });
    expect(enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, { tenantId: "t1", releaseReservationId: "sr_1" }, expect.objectContaining({ maxAttempts: 3, runAt: expect.any(Date) }));
  });

  it("a run without a hold fires as before and queues no release", async () => {
    db.automationRule.findFirst.mockResolvedValue(row(daily));
    db.contact.findMany.mockResolvedValue([{ id: "c1" }]);
    db.conversation.findFirst.mockResolvedValue(null);
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0 }, ctx);
    expect(fire.mock.calls[0][0]).not.toHaveProperty("reservationId");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a rule switched off mid-run still gives its hold back", async () => {
    db.automationRule.findFirst.mockResolvedValue(null);
    await scheduledJobHandler({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: "c9", processed: 50, reservationId: "sr_2" }, ctx);
    expect(fire).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(SCHEDULE_QUEUE, { tenantId: "t1", releaseReservationId: "sr_2" }, expect.anything());
  });

  it("without a price list a rule that sends templates starts as before, with no hold", async () => {
    db.automationRule.findMany.mockResolvedValue([row(daily, { actions: [{ type: "send_template", templateId: "tp1", variables: [] }] })]);
    expect(await scanScheduled(NOW)).toBe(1);
    expect(enqueue.mock.calls[0][1]).toEqual({ tenantId: "t1", ruleId: "r1", startedAt: NOW.toISOString(), cursor: null, processed: 0, fired: 0 });
  });
});
