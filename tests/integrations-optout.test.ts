import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn() });
  return { contact: model(), auditLog: model() };
});
const events = vi.hoisted(() => ({ emitEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: vi.fn(), sendText: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAttributeChanges: vi.fn(), emitAutomationEvent: vi.fn(), emitTagChanges: vi.fn() }));
vi.mock("@/lib/integrations/events", () => events);

import { upsertContactV1 } from "@/lib/integrations/v1-service";

const actor = { userId: "u1", tenantId: "t1", role: "admin" } as never;
const row = (over: Record<string, unknown> = {}) => ({ id: "c1", phone: "+919800000001", bsuid: null, waId: null, username: null, name: "Asha", optIn: true, optInAt: new Date(), optInSource: "x", optedOutAt: null, tags: [], attributes: {}, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  db.contact.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.create.mockResolvedValue({});
});

describe("contact.opted_out from the public API (source api)", () => {
  it("is emitted once when the API withdraws consent of an opted-in contact", async () => {
    db.contact.findFirst.mockResolvedValue(row());
    await upsertContactV1(actor, { phone: "+919800000001", optIn: false });
    expect(events.emitEvent).toHaveBeenCalledTimes(1);
    expect(events.emitEvent).toHaveBeenCalledWith("t1", "contact.opted_out", expect.objectContaining({ contactId: "c1", source: "api" }));
  });

  it("is not emitted for a contact who was not opted in, or when optIn is not changed", async () => {
    db.contact.findFirst.mockResolvedValue(row({ optIn: false }));
    await upsertContactV1(actor, { phone: "+919800000001", optIn: false });
    db.contact.findFirst.mockResolvedValue(row());
    await upsertContactV1(actor, { phone: "+919800000001", name: "Asha K" });
    expect(events.emitEvent).not.toHaveBeenCalled();
  });

  it("a failing webhook queue never fails the update", async () => {
    events.emitEvent.mockRejectedValueOnce(new Error("queue down"));
    db.contact.findFirst.mockResolvedValue(row());
    await expect(upsertContactV1(actor, { phone: "+919800000001", optIn: false })).resolves.toMatchObject({ created: false });
  });
});
