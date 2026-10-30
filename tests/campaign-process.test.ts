import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  broadcast: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  template: { updateMany: vi.fn() },
  platformSetting: { upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  broadcastRecipient: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  message: { findMany: vi.fn(), findFirst: vi.fn() },
  membership: { findMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
const inbox = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));
const email = vi.hoisted(() => ({ queueEmail: vi.fn(async () => undefined), sendEmail: vi.fn() }));
const gate = vi.hoisted(() => ({ value: "ok" as "ok" | "blocked" | "unknown" }));
const usage = vi.hoisted(() => ({ limit: 1000, used: 0, oldest: null as Date | null }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/email", () => email);
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/tenant-lifecycle-state", () => ({ backgroundGate: async () => gate.value }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/broadcasts/portfolio", () => ({ portfolioUsage: async () => ({ ...usage, phones: [] }) }));

import { PAUSE_COPY, pauseReasonKey, readPauseReason } from "@/lib/broadcasts/pause";
import { processBroadcast, recipientUpdateFromMessage, sendOne, syncRecipientFromMessage } from "@/lib/broadcasts/process";

const now = new Date("2026-03-01T12:00:00Z");

const mapped = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Hi {{1}}" },
  { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://shop.example/{{1}}" }] },
];
const variableMap = {
  header: { source: "attribute", key: "photo", fallback: "https://cdn.example/default.png" },
  "1": { source: "field", key: "first_name", fallback: "friend" },
  "button:0": { source: "attribute", key: "code", fallback: "home" },
};

const broadcast = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  tenantId: "t1",
  name: "Spring sale",
  phoneNumberId: "p1",
  templateId: "tpl1",
  status: "sending",
  scheduledAt: null,
  startedAt: now,
  retryDays: 0,
  variableMap: null,
  missingValuePolicy: "skip",
  template: { name: "promo", language: "en", status: "approved", category: "MARKETING", components: [{ type: "BODY", text: "Hello" }] },
  phoneNumber: { qualityRating: "GREEN", messagingLimitTier: "TIER_1K", wabaRefId: "w1" },
  ...over,
});
const recipient = (id: string, contact: Record<string, unknown> = {}) => ({
  id: `r${id}`,
  attempts: 0,
  contact: { id: `c${id}`, name: "Asha Rao", phone: "+919800000001", attributes: {}, optIn: true, optedOutAt: null, ...contact },
});

function setup(pending: ReturnType<typeof recipient>[], remaining = pending.length) {
  db.broadcastRecipient.count.mockImplementation(async ({ where }: { where: { status?: string } }) => (where.status === "pending" ? remaining : 0));
  db.broadcastRecipient.findMany.mockImplementation(async ({ where }: { where: { status?: string } }) => (where.status === "queued" ? [] : pending));
  db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
  db.broadcastRecipient.update.mockResolvedValue({});
  db.broadcast.updateMany.mockResolvedValue({ count: 1 });
  db.broadcast.update.mockResolvedValue({});
  db.template.updateMany.mockResolvedValue({ count: 1 });
  db.membership.findMany.mockResolvedValue([{ user: { email: "owner@example.com", disabledAt: null } }, { user: { email: "gone@example.com", disabledAt: new Date() } }]);
  db.message.findMany.mockResolvedValue([]);
  inbox.sendTemplateMessage.mockResolvedValue({ id: "m1" });
}

beforeEach(() => {
  vi.resetAllMocks();
  gate.value = "ok";
  usage.limit = 1000;
  usage.used = 0;
  usage.oldest = null;
  email.queueEmail.mockResolvedValue(undefined);
});

describe("per-recipient values at send time", () => {
  it("sends the personalised header, body and button for each recipient", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "promo", language: "en", status: "approved", components: mapped }, variableMap }));
    setup([recipient("1", { attributes: { photo: "https://cdn.example/asha.png", code: "A1" } })]);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        components: [
          { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example/asha.png" } }] },
          { type: "body", parameters: [{ type: "text", text: "Asha" }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A1" }] },
        ],
      }),
    );
  });

  it("uses the fallback when the policy says so", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "promo", language: "en", status: "approved", components: mapped }, variableMap, missingValuePolicy: "fallback" }));
    setup([recipient("1", { name: null })]);
    await processBroadcast("b1", now);
    const sent = inbox.sendTemplateMessage.mock.calls[0][0];
    expect(sent.components[0].parameters[0].image.link).toBe("https://cdn.example/default.png");
    expect(sent.components[1].parameters[0].text).toBe("friend");
  });

  it("skips a contact with a missing value under the skip policy and carries on", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "promo", language: "en", status: "approved", components: mapped }, variableMap }));
    setup([recipient("1", { attributes: {} }), recipient("2", { attributes: { photo: "https://cdn.example/b.png", code: "B2" } })]);
    await processBroadcast("b1", now);
    expect(db.broadcastRecipient.update).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1" }, data: { status: "skipped", errorCode: "missing_variable" } });
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("stops the whole broadcast under the stop policy, keeps the person pending and explains why", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { name: "promo", language: "en", status: "approved", components: mapped }, variableMap, missingValuePolicy: "fail" }));
    setup([recipient("1", { attributes: {} }), recipient("2", { attributes: { photo: "https://cdn.example/b.png", code: "B2" } })]);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.broadcastRecipient.update).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1" }, data: { status: "pending" } });
    expect(db.broadcast.updateMany).toHaveBeenCalledWith({ where: { id: "b1", tenantId: "t1", status: { in: ["scheduled", "sending"] } }, data: { status: "paused" } });
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value.reason).toBe("missing_values");
    expect(email.queueEmail).toHaveBeenCalledTimes(1);
  });

  it("never sends to a contact who opted out", async () => {
    const r = recipient("1", { optedOutAt: now });
    setup([r]);
    expect(await sendOne({ ...broadcast(), template: broadcast().template }, r)).toBeUndefined();
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.broadcastRecipient.update.mock.calls[0][0].data).toEqual({ status: "skipped" });
  });
});

describe("throttling by unique recipients across the portfolio", () => {
  it("sends only what is left of the shared rolling 24 hour limit", async () => {
    usage.limit = 250;
    usage.used = 245;
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup(Array.from({ length: 5 }, (_, i) => recipient(String(i))), 50);
    await processBroadcast("b1", now);
    expect(db.broadcastRecipient.findMany.mock.calls.find(([a]) => a.where.status === "pending")?.[0].take).toBe(5);
  });

  it("waits until the oldest person in the window ages out when the limit is used up", async () => {
    usage.limit = 250;
    usage.used = 250;
    usage.oldest = new Date("2026-03-01T03:00:00Z");
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup([], 40);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith("broadcast", { broadcastId: "b1" }, { runAt: new Date("2026-03-02T03:00:00Z") });
  });

  it("does not throttle an unlimited portfolio", async () => {
    usage.limit = Infinity;
    usage.used = 5_000_000;
    db.broadcast.findUnique.mockResolvedValue(broadcast());
    setup([recipient("1")]);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("template paused or disabled by WhatsApp", () => {
  it("does not send when the template is already paused, and says why", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { ...broadcast().template, status: "paused" } }));
    setup([recipient("1")]);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    expect(db.platformSetting.upsert.mock.calls[0][0].create).toMatchObject({ key: pauseReasonKey("b1"), value: { reason: "template_paused" } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "broadcast.paused_template_paused", target: "b1" }));
  });

  it("emails only active owners and admins, with the next step", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ template: { ...broadcast().template, status: "disabled" } }));
    setup([recipient("1")]);
    await processBroadcast("b1", now);
    expect(email.queueEmail).toHaveBeenCalledTimes(1);
    const sent = (email.queueEmail.mock.calls as unknown as [{ to: string; subject: string; text: string }][])[0][0];
    expect(sent.to).toBe("owner@example.com");
    expect(sent.subject).toContain("Spring sale");
    expect(sent.text).toContain(PAUSE_COPY.template_paused.body);
    expect(db.membership.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", role: { in: ["owner", "admin"] } });
  });

  it("a recipient refused with 132015 goes back to pending and the template and broadcast are paused", () => {
    const update = recipientUpdateFromMessage({ status: "failed", wamid: null, errorCode: "132015", statusTimeline: [] }, now);
    expect(update).toEqual({ status: "pending", messageId: null, errorCode: null });
    expect(recipientUpdateFromMessage({ status: "failed", wamid: null, errorCode: "132016", statusTimeline: [] }, now)).toMatchObject({ status: "pending" });
  });

  it("marks the template paused and pauses the broadcast when a queued message comes back refused", async () => {
    db.broadcastRecipient.findUnique.mockResolvedValue({
      id: "r1",
      tenantId: "t1",
      status: "queued",
      attempts: 0,
      broadcast: { id: "b1", name: "Spring sale", templateId: "tpl1", retryDays: 0, startedAt: now },
    });
    db.message.findFirst.mockResolvedValue({ status: "failed", wamid: null, errorCode: "132015", statusTimeline: [] });
    setup([]);
    expect(await syncRecipientFromMessage("m1")).toBe(true);
    expect(db.template.updateMany).toHaveBeenCalledWith({ where: { id: "tpl1", tenantId: "t1", status: "approved" }, data: { status: "paused" } });
    expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
  });

  it("reads back the stored reason for the broadcast page", async () => {
    db.platformSetting.findUnique.mockResolvedValue({ value: { reason: "template_paused", at: "2026-03-01T12:00:00.000Z" } });
    expect(await readPauseReason("b1")).toEqual({ reason: "template_paused", at: "2026-03-01T12:00:00.000Z" });
    db.platformSetting.findUnique.mockResolvedValue({ value: { reason: "made_up" } });
    expect(await readPauseReason("b1")).toBeNull();
  });
});

describe("number quality", () => {
  it("pauses with a stored reason and emails the admins", async () => {
    db.broadcast.findUnique.mockResolvedValue(broadcast({ phoneNumber: { qualityRating: "RED", messagingLimitTier: "TIER_1K", wabaRefId: "w1" } }));
    setup([recipient("1")]);
    await processBroadcast("b1", now);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value.reason).toBe("number_quality");
    expect(email.queueEmail).toHaveBeenCalledTimes(1);
  });
});
