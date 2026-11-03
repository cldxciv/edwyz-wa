import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contact: { findMany: vi.fn(), count: vi.fn() },
  broadcastRecipient: { updateMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  tenant: { findUnique: vi.fn() },
}));
const inbox = vi.hoisted(() => ({ sendTemplateMessage: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(), runDueJobs: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/inbox/service", () => inbox);
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined, getBillingStatus: async () => ({ canWrite: true }) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));

import { audienceWhere } from "@/lib/broadcasts/audience";
import { audiencePhones } from "@/lib/broadcasts/audience-data";
import { errorCodeText } from "@/lib/broadcasts/errors";
import { sendOne } from "@/lib/broadcasts/process";
import { countByCountry } from "@/lib/broadcasts/cost";

const BSUID = "IN.13491208655302741918";
const broadcast = (category: string) => ({ id: "b1", tenantId: "t1", phoneNumberId: "ph1", template: { name: "promo", language: "en", components: [], category } });
const recipient = (contact: Record<string, unknown>) => ({
  id: "r1",
  contact: { id: "c1", name: "Asha", phone: null, bsuid: BSUID, attributes: {}, optIn: true, optedOutAt: null, ...contact },
});
const skippedWith = (code: string) => db.broadcastRecipient.update.mock.calls.some((c) => c[0]?.data?.errorCode === code);

beforeEach(() => {
  vi.clearAllMocks();
  db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
  db.broadcastRecipient.update.mockResolvedValue({});
  inbox.sendTemplateMessage.mockResolvedValue({ id: "m1" });
});

describe("broadcast audience", () => {
  it("does not filter on phone, so opted-in BSUID-only contacts are in the audience", () => {
    const where = audienceWhere("t1", []);
    expect(where).toEqual({ tenantId: "t1", optIn: true, optedOutAt: null, conversations: { none: { status: "blocked" } } });
    expect(JSON.stringify(where)).not.toContain("phone");
  });

  it("counts BSUID-only contacts under the country in their BSUID for the cost estimate", async () => {
    db.broadcastRecipient.count.mockResolvedValue(0);
    db.contact.findMany.mockResolvedValue([{ phone: "+919876543210", bsuid: null }, { phone: null, bsuid: "IN.123" }, { phone: null, bsuid: "GB.9" }]);
    const probes = await audiencePhones({ id: "b1", tenantId: "t1", segmentTags: [], audienceFilter: null });
    expect(probes).toHaveLength(3);
    expect(Object.fromEntries(countByCountry(probes))).toEqual({ IN: 2, GB: 1 });
  });
});

describe("sending a broadcast message", () => {
  it("goes to a BSUID-only opted-in contact for marketing and utility templates", async () => {
    for (const category of ["MARKETING", "UTILITY"]) {
      inbox.sendTemplateMessage.mockClear();
      await sendOne(broadcast(category), recipient({}) as never);
      expect(inbox.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", contactId: "c1", templateName: "promo" }));
    }
  });

  it("skips a BSUID-only contact for an authentication template and says why", async () => {
    await sendOne(broadcast("AUTHENTICATION"), recipient({}) as never);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(db.broadcastRecipient.update).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1" }, data: { status: "skipped", errorCode: "bsuid_auth_template" } });
    expect(errorCodeText("bsuid_auth_template")).toMatch(/phone number/);
  });

  it("still sends an authentication template to a contact that has a phone", async () => {
    await sendOne(broadcast("AUTHENTICATION"), recipient({ phone: "+919876543210" }) as never);
    expect(inbox.sendTemplateMessage).toHaveBeenCalled();
    expect(skippedWith("bsuid_auth_template")).toBe(false);
  });

  it("skips a contact with neither a phone nor a BSUID", async () => {
    await sendOne(broadcast("UTILITY"), recipient({ bsuid: null }) as never);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
    expect(skippedWith("no_recipient")).toBe(true);
    expect(errorCodeText("no_recipient")).toMatch(/nobody to send to/);
  });

  it("never sends to a contact who opted out, BSUID or not", async () => {
    await sendOne(broadcast("MARKETING"), recipient({ optedOutAt: new Date() }) as never);
    expect(inbox.sendTemplateMessage).not.toHaveBeenCalled();
  });
});
