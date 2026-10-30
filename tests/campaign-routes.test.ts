import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/tenancy";

const db = vi.hoisted(() => ({
  segment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  contact: { findMany: vi.fn(), count: vi.fn() },
  broadcast: { count: vi.fn(), findFirst: vi.fn() },
  broadcastRecipient: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}));
const session = vi.hoisted(() => ({ role: "admin" as "admin" | "agent", sameOrigin: true, platformAdmin: true }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: session.role }) }));
vi.mock("@/lib/auth/csrf", () => ({
  assertSameOrigin: () => {
    if (!session.sameOrigin) throw new HttpError(403, "Cross-site request refused.");
  },
}));
vi.mock("@/lib/admin/auth", () => ({
  requirePlatformAdmin: async () => {
    if (!session.platformAdmin) throw new HttpError(404, "Not found.");
    return { actor: { userId: "root", tenantId: "platform", role: "owner" }, email: "root@example.com" };
  },
}));

import { DELETE as ratecardDelete, GET as ratecardGet, PUT as ratecardPut } from "@/app/api/admin/ratecard/route";
import { GET as reportGet } from "@/app/api/broadcasts/[id]/report/route";
import { DELETE as segmentDelete, PATCH as segmentPatch } from "@/app/api/segments/[id]/route";
import { POST as previewPost } from "@/app/api/segments/preview/route";
import { GET as segmentsGet, POST as segmentsPost } from "@/app/api/segments/route";

const json = (body: unknown, method = "POST") => new Request("https://wa.test/api/x", { method, headers: { "content-type": "application/json", origin: "https://wa.test" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const filter = { all: [{ field: "tag", op: "has", value: "vip" }] };

beforeEach(() => {
  vi.resetAllMocks();
  session.role = "admin";
  session.sameOrigin = true;
  session.platformAdmin = true;
});

describe("segment routes", () => {
  it("lists for any role", async () => {
    session.role = "agent";
    db.segment.findMany.mockResolvedValue([]);
    db.contact.findMany.mockResolvedValue([]);
    const res = await segmentsGet(new Request("https://wa.test/api/segments"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("creating needs an admin, a same-origin request and a valid filter", async () => {
    session.role = "agent";
    expect((await segmentsPost(json({ name: "VIPs", filter }))).status).toBe(403);
    session.role = "admin";
    session.sameOrigin = false;
    expect((await segmentsPost(json({ name: "VIPs", filter }))).status).toBe(403);
    session.sameOrigin = true;
    expect((await segmentsPost(json({ name: "VIPs", filter: { all: [{ field: "nope", op: "is", value: "x" }] } }))).status).toBe(400);
  });
  it("creates and audits", async () => {
    db.segment.count.mockResolvedValue(0);
    db.segment.findFirst.mockResolvedValue(null);
    db.segment.create.mockResolvedValue({ id: "s1", name: "VIPs" });
    const res = await segmentsPost(json({ name: "VIPs", filter }));
    expect(res.status).toBe(201);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "segment.created", target: "s1" }));
  });
  it("changes and removes only a segment of the workspace", async () => {
    db.segment.findFirst.mockResolvedValue(null);
    expect((await segmentPatch(json({ name: "x" }, "PATCH"), ctx("s9"))).status).toBe(404);
    expect((await segmentDelete(new Request("https://wa.test/api/segments/s9", { method: "DELETE", headers: { origin: "https://wa.test" } }), ctx("s9"))).status).toBe(404);
    session.role = "agent";
    expect((await segmentDelete(new Request("https://wa.test/api/segments/s9", { method: "DELETE" }), ctx("s9"))).status).toBe(403);
  });
  it("previews without saving, for admins only", async () => {
    session.role = "agent";
    expect((await previewPost(json({ filter }))).status).toBe(403);
    session.role = "admin";
    db.contact.count.mockResolvedValue(3);
    db.contact.findMany.mockResolvedValue([]);
    const res = await previewPost(json({ filter }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 3, eligible: 3 });
    expect(db.segment.create).not.toHaveBeenCalled();
  });
});

describe("rate card admin route", () => {
  it("is hidden from everyone who is not a platform admin", async () => {
    session.platformAdmin = false;
    expect((await ratecardGet(new Request("https://wa.test/api/admin/ratecard"))).status).toBe(404);
    expect((await ratecardPut(json({ currency: "INR", rates: { IN: { MARKETING: 1 } } }, "PUT"))).status).toBe(404);
  });
  it("reads null while unconfigured", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    const res = await ratecardGet(new Request("https://wa.test/api/admin/ratecard"));
    expect(await res.json()).toEqual({ rateCard: null });
  });
  it("saves a valid card, refuses an invalid one and clears", async () => {
    const ok = await ratecardPut(json({ currency: "INR", rates: { IN: { MARKETING: "88" } } }, "PUT"));
    expect(ok.status).toBe(200);
    expect(db.platformSetting.upsert).toHaveBeenCalled();
    expect((await ratecardPut(json({ currency: "INR", rates: { IN: { MARKETING: "88.5" } } }, "PUT"))).status).toBe(400);
    session.sameOrigin = false;
    expect((await ratecardPut(json({ currency: "INR", rates: { IN: { MARKETING: 1 } } }, "PUT"))).status).toBe(403);
    session.sameOrigin = true;
    const cleared = await ratecardDelete(new Request("https://wa.test/api/admin/ratecard", { method: "DELETE" }));
    expect(await cleared.json()).toEqual({ rateCard: null });
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "ratecard" } });
  });
});

describe("broadcast report download", () => {
  const get = (id: string, query = "") => reportGet(new Request(`https://wa.test/api/broadcasts/${id}/report${query}`), ctx(id));

  it("needs an admin and a broadcast of this workspace", async () => {
    session.role = "agent";
    expect((await get("b1")).status).toBe(403);
    session.role = "admin";
    db.broadcast.findFirst.mockResolvedValue(null);
    expect((await get("other")).status).toBe(404);
    expect(db.broadcast.findFirst.mock.calls[0][0].where).toEqual({ id: "other", tenantId: "t1" });
  });
  it("downloads a CSV attachment", async () => {
    db.broadcast.findFirst.mockResolvedValue({ id: "b1", tenantId: "t1", name: "Spring", template: {} });
    db.broadcastRecipient.findMany.mockResolvedValue([]);
    const res = await get("b1", "?only=problems");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("Spring-report.csv");
    expect((await res.text()).split(/\r?\n/)[0]).toContain("failure_reason");
  });
});
