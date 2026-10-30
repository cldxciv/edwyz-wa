import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.SITE_URL = "https://wa.edwyz.com";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  membership: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const mail = vi.hoisted(() => ({ queueEmail: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: mail.queueEmail, EMAIL_QUEUE: "email", emailJobHandler: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/auth/audit", () => ({ audit }));

import { DELETE, GET, POST } from "@/app/api/billing/workspace-deletion/route";
import { cancelWorkspaceDeletion, deletionKey, getDeletionRequest, requestWorkspaceDeletion } from "@/lib/lifecycle/export-deletion";

const ORIGIN = "https://wa.edwyz.com";
const owner = { userId: "u1", tenantId: "t1", role: "owner" as const };
const call = (method: string, body?: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/billing/workspace-deletion`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

let state: Map<string, unknown>;
const sent = () => mail.queueEmail.mock.calls.map((c) => c[0] as { to: string; subject: string; text: string });

beforeEach(() => {
  vi.resetAllMocks();
  state = new Map();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  auth.getActor.mockResolvedValue(owner);
  db.tenant.findUnique.mockResolvedValue({ name: "Acme Traders" });
  db.membership.findMany.mockResolvedValue([{ user: { email: "owner@acme.test", name: "Olivia" } }]);
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (state.has(where.key) ? { value: state.get(where.key) } : null));
  db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    state.set(where.key, create.value);
    return {};
  });
  mail.queueEmail.mockResolvedValue(undefined);
});

describe("asking to delete a workspace", () => {
  it("records the request, confirms it to the owners and tells the platform team, without erasing anything", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "Boss@edwyz.test, ops@edwyz.test";
    const now = new Date("2026-10-27T10:00:00Z");
    const request = await requestWorkspaceDeletion(owner, "  acme   TRADERS ", now);
    expect(request).toMatchObject({ status: "requested", requestedByUserId: "u1", requestedAt: now.toISOString(), deleteBy: "2026-11-26T10:00:00.000Z" });
    expect(state.get(deletionKey("t1"))).toEqual(request);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: "u1", action: "workspace.deletion_requested" }));
    expect(sent().map((m) => m.to)).toEqual(["owner@acme.test", "boss@edwyz.test", "ops@edwyz.test"]);
    expect(sent()[0].subject).toMatch(/request to delete/i);
    expect(sent()[0].text).toContain("30 days");
    expect(sent()[1].text).toContain("t1");
  });

  it("needs the exact workspace name and records nothing otherwise", async () => {
    await expect(requestWorkspaceDeletion(owner, "Acme")).rejects.toMatchObject({ status: 400 });
    await expect(requestWorkspaceDeletion(owner, undefined)).rejects.toMatchObject({ status: 400 });
    expect(state.size).toBe(0);
    expect(mail.queueEmail).not.toHaveBeenCalled();
  });

  it("is for owners only", async () => {
    await expect(requestWorkspaceDeletion({ ...owner, role: "admin" }, "Acme Traders")).rejects.toMatchObject({ status: 403 });
    await expect(cancelWorkspaceDeletion({ ...owner, role: "agent" })).rejects.toMatchObject({ status: 403 });
  });

  it("is idempotent: a second request neither mails nor moves the deadline", async () => {
    const first = await requestWorkspaceDeletion(owner, "Acme Traders", new Date("2026-10-27T10:00:00Z"));
    mail.queueEmail.mockClear();
    const second = await requestWorkspaceDeletion(owner, "Acme Traders", new Date("2026-11-05T10:00:00Z"));
    expect(second).toEqual(first);
    expect(mail.queueEmail).not.toHaveBeenCalled();
  });

  it("a mail problem does not lose the request", async () => {
    mail.queueEmail.mockRejectedValue(new Error("smtp down"));
    const request = await requestWorkspaceDeletion(owner, "Acme Traders");
    expect(await getDeletionRequest("t1")).toEqual(request);
  });

  it("can be withdrawn, after which no request is open", async () => {
    await requestWorkspaceDeletion(owner, "Acme Traders");
    mail.queueEmail.mockClear();
    expect(await cancelWorkspaceDeletion(owner)).toEqual({ cancelled: true });
    expect(await getDeletionRequest("t1")).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.deletion_cancelled" }));
    expect(sent()[0].subject).toMatch(/will be kept/i);
    expect(await cancelWorkspaceDeletion(owner)).toEqual({ cancelled: false });
  });

  it("keys the stored request by workspace id so workspace erasure removes it", () => {
    expect(deletionKey("t1")).toContain("t1");
  });
});

describe("the deletion route", () => {
  it("returns the open request to an owner", async () => {
    const res = await GET(call("GET"));
    expect(await res.json()).toEqual({ request: null });
    await POST(call("POST", { confirmName: "Acme Traders" }));
    const after = await (await GET(call("GET"))).json();
    expect(after.request.status).toBe("requested");
  });

  it("creates with 201, rejects a wrong name with 400, and checks the origin", async () => {
    expect((await POST(call("POST", { confirmName: "nope" }))).status).toBe(400);
    expect((await POST(call("POST", { confirmName: "Acme Traders" }, "https://evil.example"))).status).toBe(403);
    expect((await POST(call("POST", { confirmName: "Acme Traders" }))).status).toBe(201);
    expect(await (await DELETE(call("DELETE"))).json()).toEqual({ cancelled: true });
  });

  it("refuses admins and agents, and anonymous callers", async () => {
    auth.getActor.mockResolvedValue({ ...owner, role: "admin" });
    expect((await GET(call("GET"))).status).toBe(403);
    expect((await POST(call("POST", { confirmName: "Acme Traders" }))).status).toBe(403);
    expect((await DELETE(call("DELETE"))).status).toBe(403);
    auth.getActor.mockRejectedValue(Object.assign(new Error("Not signed in."), { status: 401 }));
    expect((await GET(call("GET"))).status).toBeGreaterThanOrEqual(400);
  });
});
