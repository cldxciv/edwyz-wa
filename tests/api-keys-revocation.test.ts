import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), count: vi.fn() });
  const db = {
    membership: model(),
    apiKey: model(),
    user: model(),
    session: model(),
    emailToken: model(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { db, actor: { userId: "owner1", tenantId: "t1", role: "owner" }, audit: vi.fn(async (_row: unknown) => undefined) };
});
vi.mock("@/lib/db", () => ({ prisma: h.db }));
// anonymiseUser also makes Eddy forget the user in the same transaction (EDDY-16); that is tested in tests/lifecycle-eddy-erasure.test.ts.
vi.mock("@/lib/eddy/forget-user", () => ({ eddyForgetUserEverywhere: vi.fn(async () => 0) }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => h.actor) }));
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));

import { DELETE, PATCH } from "@/app/api/workspace/members/[userId]/route";
import { applyUserAction } from "@/lib/admin/users";
import { anonymiseUser } from "@/lib/lifecycle/erasure";
import { revokeKeysBestEffort } from "@/lib/integrations/apikeys";

const ctx = (userId: string) => ({ params: Promise.resolve({ userId }) });
const del = (userId: string) => DELETE(new Request(`https://wa.edwyz.com/api/workspace/members/${userId}`, { method: "DELETE", headers: { origin: "https://wa.edwyz.com" } }), ctx(userId));
const patch = (userId: string, role: string) =>
  PATCH(
    new Request(`https://wa.edwyz.com/api/workspace/members/${userId}`, {
      method: "PATCH",
      headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
    ctx(userId),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.actor = { userId: "owner1", tenantId: "t1", role: "owner" };
  h.db.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: typeof h.db) => unknown)(h.db) : arg));
  h.db.membership.findUnique.mockResolvedValue({ role: "agent" });
  h.db.membership.count.mockResolvedValue(2);
  h.db.membership.delete.mockResolvedValue({});
  h.db.membership.update.mockResolvedValue({});
  h.db.apiKey.updateMany.mockResolvedValue({ count: 3 });
});

describe("revokeKeysBestEffort", () => {
  it("returns the count, and null (logged without key material) when the write fails", async () => {
    expect(await revokeKeysBestEffort("u1", "t1", "member_removed")).toBe(3);
    h.db.apiKey.updateMany.mockRejectedValue(new Error("db down"));
    expect(await revokeKeysBestEffort("u1", "t1", "member_removed")).toBeNull();
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
    expect(logged).toContain("member_removed");
    expect(logged).not.toMatch(/wak_|keyHash/);
  });
});

describe("member removal revokes the member's keys in that workspace only", () => {
  it("DELETE revokes after the membership is gone and records the count in the audit row", async () => {
    const order: string[] = [];
    h.db.membership.delete.mockImplementation(async () => (order.push("membership"), {}));
    h.db.apiKey.updateMany.mockImplementation(async () => (order.push("keys"), { count: 3 }));
    const res = await del("u2");
    expect(res.status).toBe(200);
    expect(order).toEqual(["membership", "keys"]);
    expect(h.db.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByUserId: "u2", revokedAt: null, tenantId: "t1" } }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.removed", target: "u2", meta: { role: "agent", keysRevoked: 3 } }));
  });

  it("a failing revoke never blocks the removal: 200, member gone, failure logged", async () => {
    h.db.apiKey.updateMany.mockRejectedValue(new Error("db down"));
    const res = await del("u2");
    expect(res.status).toBe(200);
    expect(h.db.membership.delete).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.removed", meta: { role: "agent", keysRevoked: null } }));
    expect(console.warn).toHaveBeenCalled();
  });

  it("revokes nothing when the removal is refused (unknown member, last owner)", async () => {
    h.db.membership.findUnique.mockResolvedValue(null);
    expect((await del("nobody")).status).toBe(404);
    h.db.membership.findUnique.mockResolvedValue({ role: "owner" });
    h.db.membership.count.mockResolvedValue(1);
    expect((await del("owner1")).status).toBe(400);
    expect(h.db.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it("a role change does not revoke keys (keys never act above agent level)", async () => {
    expect((await patch("u2", "admin")).status).toBe(200);
    expect(h.db.membership.update).toHaveBeenCalled();
    expect(h.db.apiKey.updateMany).not.toHaveBeenCalled();
  });
});

describe("admin disable revokes the user's keys in every workspace", () => {
  beforeEach(() => {
    h.db.user.findUnique.mockResolvedValue({ id: "u9", email: "a@b.com", name: "A", emailVerifiedAt: null });
    h.db.user.update.mockResolvedValue({});
    h.db.session.updateMany.mockResolvedValue({ count: 1 });
  });

  it("disable revokes keys with no tenant filter and audits the count", async () => {
    await applyUserAction("admin", "u9", { action: "disable", reason: "abuse", confirm: "a@b.com" });
    expect(h.db.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByUserId: "u9", revokedAt: null } }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.user.disable", meta: { reason: "abuse", keysRevoked: 3 } }));
  });

  it("a failing revoke does not block the disable", async () => {
    h.db.apiKey.updateMany.mockRejectedValue(new Error("db down"));
    await expect(applyUserAction("admin", "u9", { action: "disable", reason: "abuse", confirm: "a@b.com" })).resolves.toEqual({ ok: true });
    expect(h.db.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { disabledAt: expect.any(Date) } }));
  });

  it("refused disables (wrong confirmation, self) revoke nothing", async () => {
    await expect(applyUserAction("admin", "u9", { action: "disable", reason: "x", confirm: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(applyUserAction("u9", "u9", { action: "disable", reason: "x", confirm: "a@b.com" })).rejects.toMatchObject({ status: 400 });
    expect(h.db.apiKey.updateMany).not.toHaveBeenCalled();
  });

  it("enable sweeps the user's keys before clearing disabledAt, so a failed revoke at disable time cannot revive them", async () => {
    const order: string[] = [];
    h.db.apiKey.updateMany.mockImplementation(async () => (order.push("keys"), { count: 2 }));
    h.db.user.update.mockImplementation(async () => (order.push("enable"), {}));
    await applyUserAction("admin", "u9", { action: "enable", reason: "ok" });
    expect(order).toEqual(["keys", "enable"]);
    expect(h.db.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByUserId: "u9", revokedAt: null } }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.user.enable", meta: { reason: "ok", keysRevoked: 2 } }));
  });

  it("a failing sweep on enable is logged and does not block the enable", async () => {
    h.db.apiKey.updateMany.mockRejectedValue(new Error("db down"));
    await expect(applyUserAction("admin", "u9", { action: "enable", reason: "ok" })).resolves.toEqual({ ok: true });
    expect(h.db.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { disabledAt: null } }));
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("anonymiseUser (also reached by workspace erasure for users left with no workspace)", () => {
  beforeEach(() => {
    h.db.user.findUnique.mockResolvedValue({ id: "u5" });
    h.db.membership.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1", role: "agent" }]);
    h.db.user.update.mockResolvedValue({});
    h.db.session.updateMany.mockResolvedValue({ count: 0 });
    h.db.emailToken.deleteMany.mockResolvedValue({ count: 0 });
    h.db.membership.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("revokes every key the user created, in all workspaces, after the transaction commits", async () => {
    const order: string[] = [];
    h.db.membership.deleteMany.mockImplementation(async () => (order.push("tx"), { count: 1 }));
    h.db.apiKey.updateMany.mockImplementation(async () => (order.push("keys"), { count: 2 }));
    expect(await anonymiseUser("u5")).toEqual({ found: true, retainedWorkspaceIds: [] });
    expect(order).toEqual(["tx", "keys"]);
    expect(h.db.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByUserId: "u5", revokedAt: null } }));
  });

  it("still revokes keys for a sole owner whose workspace is retained (the account is disabled)", async () => {
    h.db.membership.findMany.mockResolvedValue([{ id: "m1", tenantId: "t1", role: "owner" }]);
    h.db.membership.count.mockResolvedValue(0);
    expect((await anonymiseUser("u5")).retainedWorkspaceIds).toEqual(["t1"]);
    expect(h.db.apiKey.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a failing revoke never undoes or blocks the anonymisation", async () => {
    h.db.apiKey.updateMany.mockRejectedValue(new Error("db down"));
    await expect(anonymiseUser("u5")).resolves.toMatchObject({ found: true });
    expect(console.warn).toHaveBeenCalled();
  });

  it("does nothing for an unknown user", async () => {
    h.db.user.findUnique.mockResolvedValue(null);
    expect(await anonymiseUser("ghost")).toEqual({ found: false, retainedWorkspaceIds: [] });
    expect(h.db.apiKey.updateMany).not.toHaveBeenCalled();
  });
});

describe("public docs say what the code does", () => {
  const root = path.resolve(__dirname, "..");
  const page = (name: string) => readFileSync(path.join(root, "src/app/(site)/docs", name, "page.tsx"), "utf8").replace(/\s+/g, " ");

  it("authentication: creator leaves, is disabled or erased, or the workspace is suspended", () => {
    const text = page("authentication");
    expect(text).toMatch(/removed from the workspace/);
    expect(text).toMatch(/disabled or erased/);
    expect(text).toMatch(/suspended/);
    expect(text).toMatch(/create a new token/);
    expect(text).toMatch(/closed or deleted \(the key is refused/);
    expect(text).not.toMatch(/revoked for good, when/);
  });

  it("rate-limits: the 10,000 cap matches the code, names filters and says there are no cursors; 422 for a changed body", () => {
    const text = page("rate-limits");
    const code = readFileSync(path.join(root, "src/lib/compat/common.ts"), "utf8");
    expect(code).toMatch(/MAX_OFFSET_WINDOW = 10_000/);
    expect(text).toContain("10,000");
    expect(text).toMatch(/answers 400/);
    expect(text).toMatch(/Cursors do not exist yet/);
    expect(text).toMatch(/narrow the query with the endpoint/i);
    expect(text).toMatch(/different body answers 422/);
  });

  it("errors: lists the 400 cap, the 422 changed body and the suspended 403", () => {
    const text = page("errors");
    expect(text).toMatch(/400 invalid_request.*10,000/);
    expect(text).toMatch(/422 unprocessable.*local_message_id.*different body/);
    expect(text).toMatch(/403 forbidden.*suspen/);
  });
});
