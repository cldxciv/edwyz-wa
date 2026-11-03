import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/contacts/import passes the dialog's "people already in your contacts" choice (?existing=skip) to importContacts.
 * The import itself is covered in contacts.test.ts; here it is a stub so only the route's own wiring is checked.
 */
const actor = vi.hoisted(() => ({ current: { userId: "u1", tenantId: "t1", role: "admin" as "admin" | "agent" } }));
const importer = vi.hoisted(() => ({ importContacts: vi.fn() }));
const audit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ getActor: async () => actor.current }));
vi.mock("@/lib/auth/audit", () => ({ audit }));
vi.mock("@/lib/contacts/import", async (orig) => ({ ...(await orig<typeof import("@/lib/contacts/import")>()), importContacts: importer.importContacts }));

import { POST } from "@/app/api/contacts/import/route";

const ORIGIN = "https://wa.edwyz.com";
const CSV = "phone,name\n+919876543210,Asha\n";
const post = (query = "") =>
  POST(new Request(`${ORIGIN}/api/contacts/import${query}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "text/csv" }, body: CSV }));

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { userId: "u1", tenantId: "t1", role: "admin" };
  importer.importContacts.mockResolvedValue({ created: 0, updated: 0, skipped: 1, errors: [] });
});

describe("POST /api/contacts/import", () => {
  it("leaves people already saved untouched with ?existing=skip, and records the choice in the audit log", async () => {
    const res = await post("?existing=skip");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: { created: 0, updated: 0, skipped: 1, errors: [] } });
    expect(importer.importContacts).toHaveBeenCalledWith("t1", CSV, { recordedByUserId: "u1", existing: "skip" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.imported", meta: expect.objectContaining({ skipped: 1, existing: "skip" }) }));
  });

  it("updates people already saved by default, and for any other value", async () => {
    await post();
    await post("?existing=SKIP");
    await post("?existing=delete");
    for (const call of importer.importContacts.mock.calls) expect(call[2]).toEqual({ recordedByUserId: "u1", existing: "update" });
  });

  it("is still for admins only", async () => {
    actor.current = { userId: "u2", tenantId: "t1", role: "agent" };
    expect((await post("?existing=skip")).status).toBe(403);
    expect(importer.importContacts).not.toHaveBeenCalled();
  });
});
