import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  message: { findFirst: vi.fn(), updateMany: vi.fn() },
  broadcast: { findMany: vi.fn(), updateMany: vi.fn() },
  broadcastRecipient: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  template: { updateMany: vi.fn(), findFirst: vi.fn() },
  waba: { findUnique: vi.fn() },
  platformSetting: { upsert: vi.fn() },
  auditLog: { create: vi.fn() },
  membership: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/automation/engine", () => ({ runAutomationsForInbound: vi.fn() }));
vi.mock("@/lib/inbox/service", () => ({ sendText: vi.fn(), sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));

import { handleStatus, processChange } from "@/lib/webhooks/processor";

const broadcastRef = (status = "sending") => ({ id: "b1", name: "Spring sale", templateId: "tpl1", status, retryDays: 0, startedAt: new Date("2026-03-01T00:00:00Z") });

beforeEach(() => {
  vi.resetAllMocks();
  db.message.updateMany.mockResolvedValue({ count: 1 });
  db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
  db.broadcast.updateMany.mockResolvedValue({ count: 1 });
  db.template.updateMany.mockResolvedValue({ count: 1 });
  db.membership.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  db.waba.findUnique.mockResolvedValue({ id: "w1", tenantId: "t1" });
});

const outbound = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  status: "sent",
  statusTimeline: [],
  conversationId: "cv1",
  direction: "outbound",
  conversation: { contact: { id: "c1", phone: "+919800000001", bsuid: null } },
  wamid: "wamid.1",
  errorCode: null,
  ...over,
});
const failedStatus = { id: "wamid.1", status: "failed", timestamp: "1760000100", recipient_id: "919800000001", errors: [{ code: 132015 }] };

describe("a template block code arriving as a delivery status", () => {
  it("puts the person back to pending, pauses the open broadcast with the template reason and marks the template paused", async () => {
    db.message.findFirst.mockResolvedValue(outbound());
    db.broadcastRecipient.findUnique.mockResolvedValue(null);
    db.broadcastRecipient.findFirst.mockResolvedValue({ id: "r1", status: "sent", broadcast: broadcastRef("sending") });

    await handleStatus("t1", failedStatus);

    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "r1", tenantId: "t1", wamid: "wamid.1" }),
      data: { status: "pending", messageId: null, wamid: null, sentAt: null, errorCode: null },
    });
    expect(db.broadcast.updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: "b1", tenantId: "t1", status: { in: ["scheduled", "sending"] } }), data: { status: "paused" } });
    expect(db.template.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value).toMatchObject({ reason: "template_paused" });
    // Never the generic "failed with the raw code" update.
    expect(db.broadcastRecipient.updateMany.mock.calls.every(([arg]) => arg.data.status !== "failed")).toBe(true);
  });

  it("shows the person as failed when the broadcast is already finished, and pauses nothing", async () => {
    db.message.findFirst.mockResolvedValue(outbound());
    db.broadcastRecipient.findUnique.mockResolvedValue(null);
    db.broadcastRecipient.findFirst.mockResolvedValue({ id: "r1", status: "sent", broadcast: broadcastRef("completed") });

    await handleStatus("t1", failedStatus);

    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "failed", errorCode: "132015" } }));
    expect(db.broadcast.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing more when the same status is delivered again", async () => {
    db.message.findFirst.mockResolvedValue(outbound());
    db.broadcastRecipient.findUnique.mockResolvedValue(null);
    db.broadcastRecipient.findFirst.mockResolvedValue(null);
    await handleStatus("t1", failedStatus);
    expect(db.broadcast.updateMany).not.toHaveBeenCalled();
  });

  it("settles a recipient that has no wamid yet (still queued) straight from the message, before the worker next runs", async () => {
    db.message.findFirst.mockResolvedValue(outbound({ status: "failed", errorCode: "132015" }));
    db.broadcastRecipient.findUnique.mockResolvedValue({ id: "r1", tenantId: "t1", status: "queued", attempts: 0, broadcast: broadcastRef("sending") });
    db.broadcastRecipient.findFirst.mockResolvedValue(null);

    await handleStatus("t1", failedStatus);

    expect(db.broadcastRecipient.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { messageId: "m1" } }));
    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1", status: "queued" }, data: { status: "pending", messageId: null, errorCode: null } });
    expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
  });

  it("copies a delivered status onto a queued recipient right away", async () => {
    db.message.findFirst.mockResolvedValue(outbound({ status: "delivered", statusTimeline: [{ status: "delivered", at: "2026-03-01T10:00:00.000Z" }] }));
    db.broadcastRecipient.findUnique.mockResolvedValue({ id: "r1", tenantId: "t1", status: "queued", attempts: 0, broadcast: broadcastRef("sending") });
    await handleStatus("t1", { id: "wamid.1", status: "delivered", timestamp: "1760000100", recipient_id: "919800000001" });
    expect(db.broadcastRecipient.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", tenantId: "t1", status: "queued" }, data: expect.objectContaining({ status: "delivered", wamid: "wamid.1" }) }));
  });
});

describe("template events stop campaigns at once", () => {
  const statusChange = (event: string) => ({ field: "message_template_status_update", wabaId: "waba1", value: { event, message_template_id: "meta1", message_template_name: "promo", message_template_language: "en" } });

  it("pauses the open broadcasts that use a template Meta paused, with the reason", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", category: "MARKETING" });
    db.broadcast.findMany.mockResolvedValue([{ id: "b1", name: "Spring sale" }]);
    await processChange(statusChange("PAUSED") as never);
    expect(db.broadcast.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", templateId: "tpl1", status: { in: ["scheduled", "sending"] } } }));
    expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value).toMatchObject({ reason: "template_paused" });
  });

  it("leaves broadcasts alone when the template is approved", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", category: "MARKETING" });
    await processChange(statusChange("APPROVED") as never);
    expect(db.broadcast.findMany).not.toHaveBeenCalled();
  });
});

describe("template quality updates", () => {
  const quality = (to: string) => ({ field: "message_template_quality_update", wabaId: "waba1", value: { previous_quality_score: "GREEN", new_quality_score: to, message_template_id: "meta1", message_template_name: "promo", message_template_language: "en" } });

  it("stops campaigns that use the template when its quality falls to RED, and keeps the template approved", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", category: "MARKETING" });
    db.broadcast.findMany.mockResolvedValue([{ id: "b1", name: "Spring sale" }]);
    const out = await processChange(quality("RED") as never);
    expect(out.tenantId).toBe("t1");
    expect(db.broadcast.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "paused" } }));
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value).toMatchObject({ reason: "template_quality" });
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", action: "template.quality_dropped", meta: expect.objectContaining({ to: "RED", from: "GREEN" }) }) });
  });

  it("only records a warning for YELLOW", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", category: "MARKETING" });
    await processChange(quality("YELLOW") as never);
    expect(db.broadcast.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "template.quality_warning" }) });
  });

  it("ignores GREEN and unknown accounts without writing anything", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", category: "MARKETING" });
    await processChange(quality("GREEN") as never);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    db.waba.findUnique.mockResolvedValue(null);
    const out = await processChange(quality("RED") as never);
    expect(out.note).toMatch(/unknown waba/);
  });
});
