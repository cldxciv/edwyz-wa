import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  segment: { findFirst: vi.fn() },
  contact: { findMany: vi.fn(), count: vi.fn() },
  broadcast: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
  broadcastRecipient: { createMany: vi.fn(), count: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
  platformSetting: { findUnique: vi.fn(), deleteMany: vi.fn() },
  job: { findFirst: vi.fn(), updateMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { createFollowUp } from "@/lib/broadcasts/followup";
import { startBroadcast } from "@/lib/broadcasts/service";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const template = { id: "tpl1", tenantId: "t1", wabaRefId: "w1", status: "approved", category: "MARKETING", name: "promo", language: "en", components: [{ type: "BODY", text: "Hi {{1}}" }] };
const plain = { ...template, id: "tpl2", components: [{ type: "BODY", text: "Hello" }] };

const row = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  tenantId: "t1",
  name: "Spring sale",
  phoneNumberId: "p1",
  templateId: "tpl1",
  status: "paused",
  segmentTags: [],
  audienceFilter: { filter: { all: [{ field: "tag", op: "has", value: "vip" }] } },
  variableMap: null,
  missingValuePolicy: "skip",
  retryDays: 0,
  scheduledAt: null,
  startedAt: new Date("2026-03-01T00:00:00Z"),
  template: plain,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.broadcast.update.mockImplementation(async ({ data }: { data: object }) => ({ id: "b1", ...data }));
  db.broadcast.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "d1", ...data }));
  db.template.findFirst.mockResolvedValue(plain);
  db.phoneNumber.findFirst.mockResolvedValue({ id: "p1", wabaRefId: "w1" });
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.job.findFirst.mockResolvedValue(null);
});

describe("resuming a paused broadcast", () => {
  it("keeps the audience frozen at the first start: nobody who matched later is added", async () => {
    db.broadcast.findFirst.mockResolvedValue(row());
    db.broadcastRecipient.count.mockResolvedValue(40);
    db.contact.findMany.mockResolvedValue([{ id: "late1", phone: "+919800000001" }]);

    await startBroadcast(actor, "b1");

    expect(db.broadcastRecipient.createMany).not.toHaveBeenCalled();
    expect(db.broadcast.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "b1", tenantId: "t1", status: "paused" }, data: expect.objectContaining({ status: "sending" }) }));
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not resume while a contact still has no value and the broadcast is set to stop, and keeps every recipient", async () => {
    db.broadcast.findFirst.mockResolvedValue(row({ missingValuePolicy: "fail", template: template }));
    db.broadcastRecipient.count.mockResolvedValue(1);
    db.contact.findMany.mockResolvedValue([{ name: null, phone: "+919800000001", attributes: {} }]);

    await expect(startBroadcast(actor, "b1")).rejects.toThrow(/no value for a placeholder/);

    expect(db.broadcast.update).not.toHaveBeenCalled();
    expect(db.broadcastRecipient.deleteMany).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("resumes once the missing value is filled in", async () => {
    db.broadcast.findFirst.mockResolvedValue(row({ missingValuePolicy: "fail", template: template }));
    db.broadcastRecipient.count.mockResolvedValue(1);
    db.contact.findMany.mockResolvedValue([{ name: "Asha", phone: "+919800000001", attributes: {} }]);
    await startBroadcast(actor, "b1");
    expect(db.broadcast.update).toHaveBeenCalled();
  });
});

describe("starting is a single step", () => {
  it("lets only one of two near-simultaneous starts through and queues the worker once", async () => {
    db.broadcast.findFirst.mockResolvedValue(row());
    db.broadcastRecipient.count.mockResolvedValue(5);
    db.broadcast.update.mockRejectedValue(Object.assign(new Error("not found"), { code: "P2025" }));
    await expect(startBroadcast(actor, "b1")).rejects.toThrow(/just changed/);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("does not add a second worker job when one is already waiting", async () => {
    db.broadcast.findFirst.mockResolvedValue(row());
    db.broadcastRecipient.count.mockResolvedValue(5);
    db.job.findFirst.mockResolvedValue({ id: "j1", runAt: new Date(Date.now() - 1000) });
    await startBroadcast(actor, "b1");
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe("retry with another template", () => {
  it("refuses to retry the rest of a broadcast that is still sending, so nobody is messaged by both", async () => {
    db.broadcast.findFirst.mockResolvedValue(row({ status: "sending" }));
    await expect(createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unsent" })).rejects.toThrow(/Pause it first/);
    db.broadcast.findFirst.mockResolvedValue(row({ status: "scheduled" }));
    await expect(createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unsent" })).rejects.toThrow(/Pause it first/);
    expect(db.broadcast.create).not.toHaveBeenCalled();
  });

  it("still lets a running broadcast be followed up for people who read or did not read it", async () => {
    db.broadcast.findFirst.mockResolvedValue(row({ status: "sending" }));
    db.broadcastRecipient.findMany.mockResolvedValue([{ contactId: "c1" }]);
    const out = await createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unread" });
    expect(out.people).toBe(1);
  });

  it("allows only one open retry per broadcast", async () => {
    db.broadcast.findFirst.mockResolvedValue(row());
    db.broadcast.count.mockResolvedValue(1);
    await expect(createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unsent" })).rejects.toThrow(/already an unfinished retry/);
    expect(db.broadcast.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: { in: ["draft", "scheduled", "sending", "paused"] } });
    expect(db.broadcast.create).not.toHaveBeenCalled();
  });

  it("leaves a paused source untouched when the draft is made, so a draft that is never sent loses nobody", async () => {
    db.broadcast.findFirst.mockResolvedValue(row());
    db.broadcast.count.mockResolvedValue(0);
    db.broadcastRecipient.findMany.mockResolvedValue([{ contactId: "c1" }, { contactId: "c2" }]);
    await createFollowUp(actor, "b1", { templateId: "tpl2", outcome: "unsent" });
    expect(db.broadcast.update).not.toHaveBeenCalled();
    expect(db.broadcastRecipient.updateMany).not.toHaveBeenCalled();
  });

  describe("sending the retry draft", () => {
    const draft = (over: Record<string, unknown> = {}) =>
      row({ id: "d1", status: "draft", templateId: "tpl2", startedAt: null, audienceFilter: { fixed: true, sourceBroadcastId: "b1", outcome: "unsent" }, ...over });
    const bySource = (source: Record<string, unknown>) => async ({ where }: { where: { id: string } }) => (where.id === "d1" ? draft() : where.id === "b1" ? source : null);

    it("cancels the paused source and drops anyone the source reached since the draft was made", async () => {
      db.broadcast.findFirst.mockImplementation(bySource(row({ status: "paused" })));
      db.broadcastRecipient.count.mockResolvedValue(2);

      await startBroadcast(actor, "d1");

      expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ broadcastId: "d1", status: "pending", contact: { broadcastRecipients: { some: expect.objectContaining({ broadcastId: "b1", status: { in: ["queued", "sent", "delivered", "read"] } }) } } }),
        data: { status: "skipped", errorCode: "already_sent" },
      });
      expect(db.broadcast.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "b1", tenantId: "t1" }, data: expect.objectContaining({ status: "canceled" }) }));
      expect(db.broadcast.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", tenantId: "t1", status: "draft" }, data: expect.objectContaining({ status: "sending" }) }));
    });

    it("refuses to send while the source is still running", async () => {
      db.broadcast.findFirst.mockImplementation(bySource(row({ status: "sending" })));
      db.broadcastRecipient.count.mockResolvedValue(2);
      await expect(startBroadcast(actor, "d1")).rejects.toThrow(/still running/);
      expect(db.broadcast.update).not.toHaveBeenCalled();
    });

    it("sends without touching a source that has already finished", async () => {
      db.broadcast.findFirst.mockImplementation(bySource(row({ status: "completed" })));
      db.broadcastRecipient.count.mockResolvedValue(2);
      await startBroadcast(actor, "d1");
      expect(db.broadcast.update).toHaveBeenCalledTimes(1);
    });
  });
});
