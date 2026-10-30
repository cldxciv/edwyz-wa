import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() });
  const prisma = { user: model(), membership: model(), auditLog: model(), apiKey: { updateMany: vi.fn() }, $executeRaw: vi.fn(), $transaction: undefined as unknown };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma;
});
const limiter = vi.hoisted(() => ({ allow: true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: async () => undefined, assertWithinLimit: async () => undefined, startTrial: async () => undefined }));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: async (given: string) => given === "right-password", hashPassword: async () => "hash" }));
vi.mock("@/lib/ratelimit", () => ({ createLimiter: () => ({ consumeShared: async () => limiter.allow, consume: () => true, clear: () => undefined }) }));
vi.mock("@/lib/teams/service", () => ({ removeUserFromTeams: vi.fn(async () => undefined) }));

import { POST as transferPost } from "@/app/api/workspace/ownership/route";
import { PATCH as rolePatch, DELETE as memberDelete } from "@/app/api/workspace/members/[userId]/route";
import { signAccessToken } from "@/lib/auth/tokens";
import { lastOwnerGuard, LAST_OWNER_MESSAGE, ROLES, transferOwnership, withOwnerLock } from "@/lib/auth/roles";
import { canRemoveMember, roleChangeConfirm, ROLE_INFO, roleLabel, type Person } from "@/components/team/helpers";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SITE_URL = "https://wa.edwyz.com";
const ORIGIN = "https://wa.edwyz.com";

const cookie = () => `wa_access=${signAccessToken({ sub: "u1", tid: "t1", role: "owner" })}`;
const call = (method: string, body?: unknown, origin: string | null = ORIGIN) =>
  new Request("https://wa.edwyz.com/api/workspace/x", {
    method,
    headers: { "content-type": "application/json", cookie: cookie(), ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (userId: string) => ({ params: Promise.resolve({ userId }) });

/** Memberships by user id; u1 is the signed-in caller. */
function members(roles: Record<string, string>) {
  db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
    const { tenantId, userId } = where.tenantId_userId;
    return roles[userId] ? { userId, tenantId, role: roles[userId], user: { disabledAt: null }, tenant: { deletedAt: null } } : null;
  });
}

beforeEach(() => {
  for (const m of Object.values(db)) if (m && typeof m === "object") for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  db.auditLog.create.mockResolvedValue({});
  db.membership.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ passwordHash: "stored" });
  db.apiKey.updateMany.mockResolvedValue({ count: 0 });
  limiter.allow = true;
});

describe("roles", () => {
  it("are exactly owner, admin and agent", () => {
    expect([...ROLES]).toEqual(["owner", "admin", "agent"]);
    expect(Object.keys(ROLE_INFO)).toEqual(["owner", "admin", "agent"]);
    expect(roleLabel("nope")).toBe("Member");
  });

  it("changing a role needs an owner and a valid role, checks the origin, and never touches another workspace", async () => {
    members({ u1: "owner", u2: "agent" });
    expect((await rolePatch(call("PATCH", { role: "admin" }, null), ctx("u2"))).status).toBe(403);
    expect((await rolePatch(call("PATCH", { role: "superuser" }), ctx("u2"))).status).toBe(400);
    expect((await rolePatch(call("PATCH", {}), ctx("u2"))).status).toBe(400);
    expect((await rolePatch(call("PATCH", { role: "admin" }), ctx("missing"))).status).toBe(404);
    expect(db.membership.update).not.toHaveBeenCalled();
    const ok = await rolePatch(call("PATCH", { role: "admin" }), ctx("u2"));
    expect(ok.status).toBe(200);
    expect(db.membership.update).toHaveBeenCalledWith({ where: { tenantId_userId: { tenantId: "t1", userId: "u2" } }, data: { role: "admin" } });
  });

  it("promoting to owner is refused here and sent to Transfer ownership, which asks for the password", async () => {
    members({ u1: "owner", u2: "agent" });
    const res = await rolePatch(call("PATCH", { role: "owner" }), ctx("u2"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Transfer ownership/);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it("agents and admins cannot change roles", async () => {
    for (const role of ["agent", "admin"]) {
      members({ u1: role, u2: "agent" });
      expect((await rolePatch(call("PATCH", { role: "admin" }), ctx("u2"))).status).toBe(403);
    }
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it("takes the owner lock for a role change and audits the change without personal data", async () => {
    members({ u1: "owner", u2: "owner" });
    db.membership.count.mockResolvedValue(2);
    await rolePatch(call("PATCH", { role: "agent" }), ctx("u2"));
    expect(db.$executeRaw).toHaveBeenCalled();
    const row = db.auditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ tenantId: "t1", userId: "u1", action: "member.role_changed", target: "u2" });
    expect(JSON.stringify(row)).not.toMatch(/@/);
  });

  it("a sole owner cannot demote or remove themselves", async () => {
    members({ u1: "owner" });
    db.membership.count.mockResolvedValue(1);
    const demote = await rolePatch(call("PATCH", { role: "admin" }), ctx("u1"));
    expect(demote.status).toBe(400);
    expect((await demote.json()).error).toBe(LAST_OWNER_MESSAGE);
    expect((await memberDelete(call("DELETE"), ctx("u1"))).status).toBe(400);
    expect(db.membership.update).not.toHaveBeenCalled();
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it("an owner may demote themselves when another owner exists", async () => {
    members({ u1: "owner", u2: "owner" });
    db.membership.count.mockResolvedValue(2);
    expect((await rolePatch(call("PATCH", { role: "admin" }), ctx("u1"))).status).toBe(200);
  });

  it("removal: agents cannot remove, admins can remove agents and leave, only owners remove admins and owners", async () => {
    members({ u1: "agent", u2: "agent" });
    expect((await memberDelete(call("DELETE"), ctx("u2"))).status).toBe(403);
    members({ u1: "admin", u2: "agent", u3: "admin", u4: "owner" });
    db.membership.count.mockResolvedValue(2);
    db.membership.delete.mockResolvedValue({});
    expect((await memberDelete(call("DELETE"), ctx("u3"))).status).toBe(403);
    expect((await memberDelete(call("DELETE"), ctx("u4"))).status).toBe(403);
    expect((await memberDelete(call("DELETE"), ctx("u2"))).status).toBe(200);
    expect((await memberDelete(call("DELETE"), ctx("u1"))).status).toBe(200);
  });
});

describe("lastOwnerGuard and withOwnerLock", () => {
  it("only blocks when the member is an owner and the only one", async () => {
    const tx = db as never;
    db.membership.findUnique.mockResolvedValueOnce({ role: "admin" });
    await expect(lastOwnerGuard(tx, "t1", "u2")).resolves.toBeUndefined();
    db.membership.findUnique.mockResolvedValueOnce(null);
    await expect(lastOwnerGuard(tx, "t1", "u2")).resolves.toBeUndefined();
    db.membership.findUnique.mockResolvedValue({ role: "owner" });
    db.membership.count.mockResolvedValueOnce(2);
    await expect(lastOwnerGuard(tx, "t1", "u2")).resolves.toBeUndefined();
    db.membership.count.mockResolvedValueOnce(1);
    await expect(lastOwnerGuard(tx, "t1", "u2")).rejects.toMatchObject({ status: 400, message: LAST_OWNER_MESSAGE });
    expect(db.membership.count).toHaveBeenLastCalledWith({ where: { tenantId: "t1", role: "owner" } });
  });

  it("runs its work inside one transaction after taking an advisory lock for that workspace", async () => {
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async () => void order.push("lock"));
    await withOwnerLock("t1", async () => void order.push("work"));
    expect(order).toEqual(["lock", "work"]);
  });
});

describe("transferOwnership", () => {
  const input = { tenantId: "t1", fromUserId: "u1", toUserId: "u2", password: "right-password", keepOwner: false };

  it("makes the other member the owner and the caller an admin", async () => {
    members({ u1: "owner", u2: "admin" });
    await expect(transferOwnership(input)).resolves.toEqual({ newOwnerId: "u2", previousOwnerRole: "admin" });
    expect(db.membership.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { tenantId_userId: { tenantId: "t1", userId: "u2" } }, data: { role: "owner" } },
      { where: { tenantId_userId: { tenantId: "t1", userId: "u1" } }, data: { role: "admin" } },
    ]);
    expect(db.auditLog.create.mock.calls.at(-1)?.[0].data).toMatchObject({ action: "member.ownership_transferred", target: "u2" });
  });

  it("keeps the caller as an owner when asked", async () => {
    members({ u1: "owner", u2: "agent" });
    await expect(transferOwnership({ ...input, keepOwner: true })).resolves.toMatchObject({ previousOwnerRole: "owner" });
    expect(db.membership.update).toHaveBeenCalledTimes(1);
  });

  it("refuses a wrong password, audits the attempt and changes nothing", async () => {
    members({ u1: "owner", u2: "admin" });
    await expect(transferOwnership({ ...input, password: "guess" })).rejects.toMatchObject({ status: 403, message: "That password is not right." });
    expect(db.membership.update).not.toHaveBeenCalled();
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("member.ownership_transfer_denied");
  });

  it("refuses to hand the workspace to yourself, to a stranger, or when the caller is no longer an owner", async () => {
    members({ u1: "owner", u2: "admin" });
    await expect(transferOwnership({ ...input, toUserId: "u1" })).rejects.toMatchObject({ status: 400 });
    await expect(transferOwnership({ ...input, toUserId: "nobody" })).rejects.toMatchObject({ status: 404 });
    members({ u1: "admin", u2: "admin" });
    await expect(transferOwnership(input)).rejects.toMatchObject({ status: 403 });
    expect(db.membership.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspace/ownership", () => {
  it("is owner only, same-origin only, rate limited and validated", async () => {
    members({ u1: "admin", u2: "agent" });
    expect((await transferPost(call("POST", { userId: "u2", password: "right-password" }))).status).toBe(403);
    members({ u1: "owner", u2: "admin" });
    expect((await transferPost(call("POST", { userId: "u2", password: "right-password" }, null))).status).toBe(403);
    expect((await transferPost(call("POST", { password: "right-password" }))).status).toBe(400);
    expect((await transferPost(call("POST", { userId: "u2" }))).status).toBe(400);
    expect((await transferPost(call("POST", { userId: "u2", password: "right-password", keepOwner: "yes" }))).status).toBe(400);
    limiter.allow = false;
    expect((await transferPost(call("POST", { userId: "u2", password: "right-password" }))).status).toBe(429);
    expect(db.membership.update).not.toHaveBeenCalled();
  });

  it("transfers and answers with no-store", async () => {
    members({ u1: "owner", u2: "admin" });
    const res = await transferPost(call("POST", { userId: "u2", password: "right-password" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, newOwnerId: "u2", previousOwnerRole: "admin" });
  });
});

describe("team screen rules", () => {
  const owner: Person = { userId: "u1", role: "owner" };
  const admin: Person = { userId: "u3", role: "admin" };
  const agent: Person = { userId: "u2", role: "agent" };

  it("shows Remove only to people who may use it", () => {
    expect(canRemoveMember(null, agent)).toBe(false);
    expect(canRemoveMember(agent, agent)).toBe(false);
    expect(canRemoveMember(admin, agent)).toBe(true);
    expect(canRemoveMember(admin, owner)).toBe(false);
    expect(canRemoveMember(admin, admin)).toBe(true);
    expect(canRemoveMember(owner, admin)).toBe(true);
  });

  it("asks before making an owner or lowering your own access, and not for routine changes", () => {
    expect(roleChangeConfirm(owner, { ...agent, name: "Asha" }, "owner")?.title).toBe("Make Asha an owner?");
    expect(roleChangeConfirm(owner, { ...owner, name: "Me" }, "admin")?.tone).toBe("danger");
    expect(roleChangeConfirm(owner, { ...agent, name: "Asha" }, "admin")).toBeNull();
    expect(roleChangeConfirm(owner, { ...agent, name: "Asha" }, "agent")).toBeNull();
  });
});
