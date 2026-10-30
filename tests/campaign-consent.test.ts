import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contact: { findFirst: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
  auditLog: { findMany: vi.fn(), create: vi.fn(), createMany: vi.fn() },
  user: { findMany: vi.fn() },
}));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));

import { consentHistory, consentRecordedBy, recordConsent, recordConsentWithdrawn } from "@/lib/contacts/consent";
import { importContacts } from "@/lib/contacts/import";

const admin = { userId: "u1", tenantId: "t1", role: "admin" as const };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("consent record", () => {
  it("writes who recorded the opt-in and where it came from", async () => {
    await recordConsent(admin, "c1", { source: "website form" });
    expect(auditMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "u1", action: "contact.consent_recorded", target: "c1", meta: { source: "website form" } });
    await recordConsentWithdrawn(admin, "c1");
    expect(auditMock).toHaveBeenLastCalledWith({ tenantId: "t1", userId: "u1", action: "contact.consent_withdrawn", target: "c1" });
  });

  it("shows the current state and a history with the source, time and who", async () => {
    db.contact.findFirst.mockResolvedValue({ optIn: true, optInSource: "website form", optInAt: new Date("2026-03-01T10:00:00Z"), optedOutAt: null });
    db.auditLog.findMany.mockResolvedValue([
      { action: "contact.opted_in", userId: null, createdAt: new Date("2026-03-03T10:00:00Z"), meta: { via: "start_keyword" } },
      { action: "contact.opted_out", userId: null, createdAt: new Date("2026-03-02T10:00:00Z"), meta: { via: "stop_keyword" } },
      { action: "contact.consent_recorded", userId: "u1", createdAt: new Date("2026-03-01T10:00:00Z"), meta: { source: "website form" } },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u1", name: "Priya", email: "priya@example.com" }]);
    const out = await consentHistory(admin, "c1");
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(db.auditLog.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", target: "c1" });
    expect(out.current).toEqual({ optIn: true, optInSource: "website form", optInAt: "2026-03-01T10:00:00.000Z", optedOutAt: null });
    expect(out.events.map((e) => [e.kind, e.source, typeof e.by === "object" && e.by ? "name" in e.by : e.by])).toEqual([
      ["opt_in", "Replied START", "contact"],
      ["opted_out", "Replied STOP", "contact"],
      ["opt_in", "website form", true],
    ]);
  });

  it("404s for a contact of another workspace", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    await expect(consentHistory(admin, "other")).rejects.toThrow(/not found/);
  });

  it("looks up the recorder's email for the export, only for users in the workspace, and never throws", async () => {
    db.auditLog.findMany.mockResolvedValue([
      { target: "c1", userId: "u1" },
      { target: "c1", userId: "u2" },
      { target: "c2", userId: null },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u1", email: "priya@example.com" }]);
    const map = await consentRecordedBy("t1", ["c1", "c2"]);
    expect([...map]).toEqual([["c1", "priya@example.com"]]);
    expect(db.user.findMany.mock.calls[0][0].where.memberships).toEqual({ some: { tenantId: "t1" } });
    db.auditLog.findMany.mockRejectedValue(new Error("down"));
    expect((await consentRecordedBy("t1", ["c1"])).size).toBe(0);
    expect((await consentRecordedBy("t1", [])).size).toBe(0);
  });
});

describe("consent from a CSV import", () => {
  const csv = "phone,name,opt_in,opt_in_source\n+919800000001,Asha,yes,trade show\n+919800000002,Ravi,no,\n+919800000003,Mina,yes,\n";

  it("records one consent entry per person the import opted in, with the importer", async () => {
    db.contact.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.name
        ? []
        : [
            { id: "c1", phone: "+919800000001" },
            { id: "c3", phone: "+919800000003" },
          ],
    );
    db.contact.createMany.mockResolvedValue({ count: 3 });
    db.auditLog.createMany.mockResolvedValue({ count: 2 });
    const report = await importContacts("t1", csv, { recordedByUserId: "u1" });
    expect(report.created).toBe(3);
    expect(db.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: "t1", userId: "u1", action: "contact.consent_recorded", target: "c1", meta: { source: "trade show" } },
        { tenantId: "t1", userId: "u1", action: "contact.consent_recorded", target: "c3", meta: { source: "csv_import" } },
      ],
    });
  });

  it("writes nothing extra when the caller does not say who is importing", async () => {
    db.contact.findMany.mockResolvedValue([]);
    db.contact.createMany.mockResolvedValue({ count: 3 });
    await importContacts("t1", csv);
    expect(db.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("an audit failure never fails the import", async () => {
    db.contact.findMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => (select.name ? [] : [{ id: "c1", phone: "+919800000001" }]));
    db.contact.createMany.mockResolvedValue({ count: 3 });
    db.auditLog.createMany.mockRejectedValue(new Error("down"));
    await expect(importContacts("t1", csv, { recordedByUserId: "u1" })).resolves.toMatchObject({ created: 3 });
  });
});
