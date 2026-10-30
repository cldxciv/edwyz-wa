import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  segment: { findFirst: vi.fn() },
  contact: { findMany: vi.fn(), count: vi.fn() },
  broadcast: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
  broadcastRecipient: { createMany: vi.fn(), count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  platformSetting: { findUnique: vi.fn(), deleteMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
const usage = vi.hoisted(() => ({ limit: 250, used: 0 }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/broadcasts/portfolio", () => ({ portfolioUsage: async () => ({ ...usage, oldest: null, phones: [] }) }));

import { freezeAudience } from "@/lib/broadcasts/audience";
import { createFollowUp, followUpTemplates, parseOutcome } from "@/lib/broadcasts/followup";
import { broadcastReportCsv } from "@/lib/broadcasts/report";
import { createBroadcast, estimateBroadcast, getBroadcast, startBroadcast } from "@/lib/broadcasts/service";
import { errorCodeText } from "@/lib/broadcasts/errors";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const components = [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }];
const variableMap = { header: { source: "attribute", key: "photo" }, "1": { source: "field", key: "first_name" } };
const template = { id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "approved", category: "MARKETING", name: "promo", language: "en", components };
const phone = { id: "p1", tenantId: "t1", wabaRefId: "w1", messagingLimitTier: "TIER_250" };
const card = { value: { currency: "INR", rates: { IN: { MARKETING: 100 } }, note: "", updatedAt: null } };

beforeEach(() => {
  vi.resetAllMocks();
  usage.limit = 250;
  usage.used = 0;
  db.template.findFirst.mockResolvedValue(template);
  db.phoneNumber.findFirst.mockResolvedValue(phone);
  db.broadcast.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "b1", ...data }));
  db.broadcastRecipient.count.mockResolvedValue(0);
});

describe("createBroadcast with an audience and a value mapping", () => {
  it("stores the audience, mapping and policy", async () => {
    const b = await createBroadcast(actor, {
      name: "Spring",
      phoneNumberId: "p1",
      templateId: "tpl1",
      audience: { filter: { all: [{ field: "attr:city", op: "is", value: "Pune" }] } },
      variableMap,
      missingValuePolicy: "fallback",
    }).catch((e: Error) => e);
    expect(b).toBeInstanceOf(Error);
    expect((b as Error).message).toMatch(/fallback/);

    const ok = await createBroadcast(actor, {
      name: "Spring",
      phoneNumberId: "p1",
      templateId: "tpl1",
      audience: { filter: { all: [{ field: "attr:city", op: "is", value: "Pune" }] } },
      variableMap,
      missingValuePolicy: "skip",
    });
    expect(db.broadcast.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      missingValuePolicy: "skip",
      audienceFilter: { filter: { all: [{ field: "attr:city", op: "is", value: "Pune" }] } },
      variableMap,
    });
    expect(ok.id).toBe("b1");
  });
  it("needs the media header to be mapped", async () => {
    await expect(createBroadcast(actor, { name: "x", phoneNumberId: "p1", templateId: "tpl1" })).rejects.toThrow(/Header image link/);
  });
  it("rejects a segment of another workspace", async () => {
    db.template.findFirst.mockResolvedValue({ ...template, components: [{ type: "BODY", text: "Hello" }] });
    db.segment.findFirst.mockResolvedValue(null);
    await expect(createBroadcast(actor, { name: "x", phoneNumberId: "p1", templateId: "tpl1", audience: { segmentId: "foreign" } })).rejects.toThrow(/not found/);
    expect(db.segment.findFirst).toHaveBeenCalledWith({ where: { id: "foreign", tenantId: "t1" }, select: { filter: true } });
  });
  it("refuses templates that cannot be broadcast", async () => {
    db.template.findFirst.mockResolvedValue({ ...template, components: [{ type: "BODY", text: "x" }, { type: "CAROUSEL" }] });
    await expect(createBroadcast(actor, { name: "x", phoneNumberId: "p1", templateId: "tpl1" })).rejects.toThrow(/Carousel/);
  });
});

describe("freezing the audience from filters", () => {
  it("keeps only opted-in contacts who match the filter and the tags", async () => {
    db.segment.findFirst.mockResolvedValue({ filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    db.contact.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    db.broadcastRecipient.count.mockResolvedValue(2);
    const total = await freezeAudience("t1", "b1", ["spring"], { segmentId: "seg1" });
    expect(total).toBe(2);
    const where = db.contact.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"optIn":true');
    expect(JSON.stringify(where)).toContain('"optedOutAt":null');
    expect(JSON.stringify(where)).toContain('"hasSome":["spring"]');
    expect(JSON.stringify(where)).toContain('"has":"vip"');
    expect(where.AND[0].tenantId).toBe("t1");
    expect(db.broadcastRecipient.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: "t1", broadcastId: "b1", contactId: "c1" },
        { tenantId: "t1", broadcastId: "b1", contactId: "c2" },
      ],
      skipDuplicates: true,
    });
  });
  it("evaluates attribute filters in code", async () => {
    const row = (id: string, city: string) => ({ id, name: "A", phone: "+911", tags: [], attributes: { city }, optInSource: null, optInAt: null, createdAt: new Date(), leadStage: null, ownerUserId: null });
    db.contact.findMany.mockResolvedValue([row("c1", "Pune"), row("c2", "Delhi")]);
    db.broadcastRecipient.count.mockResolvedValue(1);
    await freezeAudience("t1", "b1", [], { filter: { all: [{ field: "attr:city", op: "is", value: "Pune" }] } });
    expect(db.broadcastRecipient.createMany.mock.calls[0][0].data).toEqual([{ tenantId: "t1", broadcastId: "b1", contactId: "c1" }]);
  });
});

describe("startBroadcast", () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    tenantId: "t1",
    status: "draft",
    segmentTags: [],
    audienceFilter: null,
    variableMap: null,
    missingValuePolicy: "skip",
    scheduledAt: null,
    startedAt: null,
    template: { ...template, components: [{ type: "BODY", text: "Hello" }] },
    ...over,
  });

  it("stores the estimate in paise only when every recipient has a price on an INR card", async () => {
    db.broadcast.findFirst.mockResolvedValue(draft());
    db.contact.count.mockResolvedValue(2);
    db.contact.findMany.mockResolvedValue([{ id: "c1", phone: "+919800000001" }, { id: "c2", phone: "+919800000002" }]);
    db.broadcastRecipient.count.mockResolvedValue(2);
    db.platformSetting.findUnique.mockResolvedValue(card);
    db.broadcast.update.mockImplementation(async ({ data }: { data: object }) => data);
    const updated = await startBroadcast(actor, "b1");
    expect(updated).toMatchObject({ status: "sending", estimatedCostPaise: 200 });
    expect(queue.enqueue).toHaveBeenCalled();
  });
  it("leaves the estimate empty while the rate card is not configured", async () => {
    db.broadcast.findFirst.mockResolvedValue(draft());
    db.contact.count.mockResolvedValue(1);
    db.contact.findMany.mockResolvedValue([{ id: "c1", phone: "+919800000001" }]);
    db.broadcastRecipient.count.mockResolvedValue(1);
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.broadcast.update.mockImplementation(async ({ data }: { data: object }) => data);
    expect(await startBroadcast(actor, "b1")).toMatchObject({ estimatedCostPaise: null });
  });
  it("refuses to start when the stop policy would hit a contact with no value, and keeps no recipients", async () => {
    db.broadcast.findFirst.mockResolvedValue(draft({ missingValuePolicy: "fail", template: { ...template, components: [{ type: "BODY", text: "Hi {{1}}" }] } }));
    const contacts = [{ id: "c1", phone: "+919800000001", name: null, attributes: {} }];
    db.contact.count.mockResolvedValue(1);
    db.contact.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => (select.id && !select.name ? [{ id: "c1" }] : contacts));
    db.broadcastRecipient.count.mockResolvedValue(1);
    await expect(startBroadcast(actor, "b1")).rejects.toThrow(/no value for a placeholder/);
    expect(db.broadcastRecipient.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", broadcastId: "b1", status: "pending" } });
    expect(db.broadcast.update).not.toHaveBeenCalled();
  });
  it("refuses when the template is no longer approved", async () => {
    db.broadcast.findFirst.mockResolvedValue(draft({ template: { ...template, status: "paused" } }));
    await expect(startBroadcast(actor, "b1")).rejects.toThrow(/no longer approved/);
  });
});

describe("estimateBroadcast", () => {
  it("reports cost per country, value coverage and how many days the daily limit needs", async () => {
    usage.limit = 250;
    usage.used = 50;
    db.broadcast.findFirst.mockResolvedValue({
      id: "b1",
      tenantId: "t1",
      phoneNumberId: "p1",
      segmentTags: [],
      audienceFilter: null,
      variableMap: null,
      missingValuePolicy: "skip",
      template: { ...template, components: [{ type: "BODY", text: "Hi {{1}}" }] },
    });
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(600);
    db.contact.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => (select.attributes ? [{ name: "A", phone: "+919800000001", attributes: {} }, { name: null, phone: "+14155550123", attributes: {} }] : [{ phone: "+919800000001" }, { phone: "+14155550123" }]));
    db.platformSetting.findUnique.mockResolvedValue(card);
    db.phoneNumber.findFirst.mockResolvedValue({ wabaRefId: "w1", messagingLimitTier: "TIER_250" });
    const out = await estimateBroadcast(actor, "b1");
    expect(out.count).toBe(600);
    // Conservative (spend controls 4.9): the US number has no price, so it is priced at the card's highest rate, not left out.
    expect(out.cost).toMatchObject({ configured: true, currency: "INR", unpricedCount: 0, highestRateCount: 1, totalMinor: 200 });
    expect(out.coverage).toMatchObject({ contactsMissing: 1, checked: 2, policy: "skip" });
    expect(out.sending).toMatchObject({ limit: 250, used: 50, days: 3 });
    expect(out.sending?.hint).toMatch(/2,000/);
  });
  it("says the rate card is not configured instead of guessing", async () => {
    db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", phoneNumberId: "p1", segmentTags: [], audienceFilter: null, variableMap: null, missingValuePolicy: "skip", template });
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.contact.count.mockResolvedValue(0);
    db.contact.findMany.mockResolvedValue([]);
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue(null);
    const out = await estimateBroadcast(actor, "b1");
    expect(out.cost.configured).toBe(false);
    expect(out.label).toBe("rate card not configured");
  });
});

describe("failure reasons and the report download", () => {
  it("explains common failure codes in plain words", () => {
    expect(errorCodeText("131049")).toMatch(/\S/);
    expect(errorCodeText("132015")).toMatch(/paused/i);
    expect(errorCodeText("missing_variable")).toMatch(/value/i);
    expect(errorCodeText(null)).toBeNull();
  });
  it("streams one row per person with the code and the reason, scoped to the workspace", async () => {
    db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", name: "Spring sale!", template });
    db.broadcastRecipient.findMany.mockResolvedValueOnce([
      { id: "r1", status: "failed", errorCode: "131049", attempts: 1, sentAt: null, deliveredAt: null, readAt: null, retryAfter: null, contact: { phone: "+919800000001", name: "Asha" } },
      { id: "r2", status: "skipped", errorCode: "missing_variable", attempts: 0, sentAt: null, deliveredAt: null, readAt: null, retryAfter: null, contact: { phone: "+919800000002", name: null } },
    ]);
    const { stream, filename } = await broadcastReportCsv(actor, "b1", "problems");
    expect(filename).toBe("Spring_sale_-report.csv");
    const text = await new Response(stream).text();
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe("phone,name,username,bsuid,status,failure_code,failure_reason,attempts,sent_at,delivered_at,read_at,retry_after");
    expect(lines[1]).toContain("+919800000001");
    expect(lines[1]).toContain("131049");
    expect(lines[2]).toContain("not sent");
    expect(db.broadcastRecipient.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", broadcastId: "b1", status: { in: ["failed", "skipped"] } });
  });
});

describe("retry with another template", () => {
  const source = (over: Record<string, unknown> = {}) => ({
    id: "b1",
    tenantId: "t1",
    name: "Spring sale",
    phoneNumberId: "p1",
    templateId: "tpl1",
    status: "paused",
    variableMap: null,
    missingValuePolicy: "skip",
    retryDays: 2,
    template: { ...template, components: [{ type: "BODY", text: "Hello" }] },
    ...over,
  });

  it("lists approved templates on the same account that the mapping can fill", async () => {
    db.broadcast.findFirst.mockResolvedValue(source());
    db.template.findMany.mockResolvedValue([
      { id: "tpl2", name: "plain", language: "en", category: "MARKETING", components: [{ type: "BODY", text: "Hi" }] },
      { id: "tpl3", name: "carousel", language: "en", category: "MARKETING", components: [{ type: "CAROUSEL" }] },
      { id: "tpl4", name: "needs_media", language: "en", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi" }] },
    ]);
    const list = await followUpTemplates(actor, "b1");
    expect(list.map((t) => t.id)).toEqual(["tpl2"]);
    expect(db.template.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", wabaRefId: "w1", status: "approved", id: { not: "tpl1" } });
  });
  it("creates a draft for the people not yet messaged and leaves the paused source alone until the draft is sent", async () => {
    db.broadcast.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "b1" ? source() : null));
    db.template.findFirst.mockResolvedValue({ ...template, id: "tpl2", components: [{ type: "BODY", text: "Hi" }] });
    db.broadcastRecipient.findMany.mockResolvedValue([{ contactId: "c1" }, { contactId: "c2" }]);
    db.broadcast.count.mockResolvedValue(0);
    const out = await createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unsent" });
    expect(out.people).toBe(2);
    expect(db.broadcast.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", templateId: "tpl2", name: "Spring sale (retry)", audienceFilter: { fixed: true, sourceBroadcastId: "b1", outcome: "unsent" } });
    expect(db.broadcastRecipient.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: { in: ["pending", "failed"] }, contact: { optIn: true, optedOutAt: null } });
    expect(db.broadcastRecipient.createMany.mock.calls[0][0].data).toEqual([
      { tenantId: "t1", broadcastId: "b1", contactId: "c1" },
      { tenantId: "t1", broadcastId: "b1", contactId: "c2" },
    ]);
    // Changed on purpose: the source is no longer canceled when the draft is made (people would be dropped if the draft was never sent). See tests/campaign-followup.test.ts.
    expect(db.broadcast.update).not.toHaveBeenCalled();
  });
  it("validates the outcome and refuses an unsent source or an empty audience", async () => {
    expect(() => parseOutcome("everyone")).toThrow(/Choose/);
    db.broadcast.findFirst.mockResolvedValue(source({ status: "draft" }));
    await expect(createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "read" })).rejects.toThrow(/not been sent/);
    db.broadcast.findFirst.mockResolvedValue(source());
    db.broadcastRecipient.findMany.mockResolvedValue([]);
    await expect(createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "read" })).rejects.toThrow(/No one matches/);
  });
});

describe("broadcast page data", () => {
  it("includes the stored pause reason and the failure summary for a paused broadcast", async () => {
    db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", status: "paused", template });
    db.broadcastRecipient.groupBy.mockImplementation(async ({ by }: { by: string[] }) => (by.length === 1 ? [{ status: "pending", _count: { _all: 3 } }] : [{ errorCode: "131049", status: "failed", _count: { _all: 2 } }]));
    db.broadcastRecipient.findMany.mockResolvedValue([]);
    db.platformSetting.findUnique.mockResolvedValue({ value: { reason: "template_paused", at: "2026-03-01T00:00:00.000Z" } });
    const out = await getBroadcast(actor, "b1");
    expect(out.pauseReason).toEqual({ reason: "template_paused", at: "2026-03-01T00:00:00.000Z" });
    expect(out.failures).toEqual([{ code: "131049", status: "failed", count: 2 }]);
  });
});
