import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  const prisma: Record<string, unknown> = {
    user: model(),
    tenant: model(),
    membership: model(),
    invite: model(),
    session: model(),
    auditLog: model(),
  };
  prisma.$executeRaw = vi.fn();
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>> & { $transaction: unknown };
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: async () => undefined, assertWithinLimit: async () => undefined, startTrial: async () => undefined }));
vi.setConfig({ testTimeout: 60_000 });

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as acceptPost } from "@/app/api/auth/accept-invite/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as meGet } from "@/app/api/auth/me/route";
import { POST as switchPost } from "@/app/api/auth/switch-workspace/route";
import { POST as invitePost } from "@/app/api/workspace/invites/route";
import { DELETE as memberDelete, PATCH as memberPatch } from "@/app/api/workspace/members/[userId]/route";
import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { resetLoginLimits } from "@/lib/auth/ratelimit";
import { createLimiter } from "@/lib/ratelimit";
import { hashToken, rotateRefreshToken, signAccessToken, successorToken, verifyAccessToken } from "@/lib/auth/tokens";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SITE_URL = "https://wa.edwyz.com";

const ORIGIN = "https://wa.edwyz.com";

function req(method: string, body?: unknown, opts: { cookie?: string; origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": opts.ip ?? "1.1.1.1" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request("https://wa.edwyz.com/api/x", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const asCookie = (userId = "u1", tenantId = "t1") =>
  `wa_access=${signAccessToken({ sub: userId, tid: tenantId, role: "owner" })}`;

/** Membership lookups: the caller (u1) has actorRole; other users come from `others`. */
function setMemberships(actorRole: string, others: Record<string, string> = {}) {
  db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
    const { tenantId, userId } = where.tenantId_userId;
    if (userId === "u1") return { userId, tenantId, role: actorRole };
    return others[userId] ? { userId, tenantId, role: others[userId] } : null;
  });
}

beforeEach(() => {
  for (const m of Object.values(db)) {
    if (m && typeof m === "object") for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  db.auditLog.create.mockResolvedValue({});
  resetLoginLimits();
});

describe("password", () => {
  it("hashes and verifies, with unique salts", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong password!!", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toMatchObject({ status: 400 });
  });
});

describe("access tokens", () => {
  it("signs and verifies", () => {
    const c = verifyAccessToken(signAccessToken({ sub: "u1", tid: "t1", role: "agent" }));
    expect(c).toMatchObject({ sub: "u1", tid: "t1", role: "agent" });
    expect(c!.exp - c!.iat).toBe(900);
  });

  it("rejects tampered payloads and signatures", () => {
    const [h, , s] = signAccessToken({ sub: "u1", tid: "t1", role: "agent" }).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u1", tid: "t1", role: "owner", iat: 1, exp: 9999999999 })).toString("base64url");
    expect(verifyAccessToken(`${h}.${forged}.${s}`)).toBeNull();
    expect(verifyAccessToken(`${h}.${forged}.AAAA`)).toBeNull();
    expect(verifyAccessToken("nope")).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = signAccessToken({ sub: "u1", tid: "t1", role: "agent" }, Date.now() - 16 * 60 * 1000);
    expect(verifyAccessToken(token)).toBeNull();
  });
});

describe("refresh rotation", () => {
  const live = { id: "s1", userId: "u1", tenantId: "t1", revokedAt: null, expiresAt: new Date(Date.now() + 1e9), user: { disabledAt: null } };

  it("rotates: revokes the old session and stores only a hash of the new token", async () => {
    db.session.findUnique.mockResolvedValue(live);
    db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "admin" });
    db.session.updateMany.mockResolvedValue({ count: 1 });
    db.session.createMany.mockResolvedValue({ count: 1 });
    const out = await rotateRefreshToken("old-token", "ua");
    expect(db.session.findUnique).toHaveBeenCalledWith({ where: { refreshTokenHash: hashToken("old-token") }, include: { user: { select: { disabledAt: true } } } });
    expect(out).toMatchObject({ userId: "u1", tenantId: "t1", role: "admin" });
    const call = db.session.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0].refreshTokenHash).toBe(hashToken(out.refreshToken));
    expect(JSON.stringify(call)).not.toContain(out.refreshToken);
    // Derived from the old token with the server secret, so a racing refresh arrives at the same one.
    expect(out.refreshToken).toBe(successorToken("old-token"));
    expect(out.refreshToken).not.toContain("old-token");
  });

  it("revokes all user sessions when a token revoked before the grace minute is reused", async () => {
    db.session.findUnique.mockResolvedValue({ ...live, revokedAt: new Date() });
    db.session.updateMany.mockResolvedValue({ count: 3 });
    await expect(rotateRefreshToken("old-token", null)).rejects.toMatchObject({ status: 401 });
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(db.session.createMany).not.toHaveBeenCalled();
  });

  it("rejects unknown and expired tokens", async () => {
    db.session.findUnique.mockResolvedValue(null);
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
    db.session.findUnique.mockResolvedValue({ ...live, expiresAt: new Date(Date.now() - 1000) });
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
  });

  it("gives a disabled account no new session", async () => {
    db.session.findUnique.mockResolvedValue({ ...live, user: { disabledAt: new Date() } });
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
    expect(db.session.updateMany).not.toHaveBeenCalled();
    expect(db.session.createMany).not.toHaveBeenCalled();
  });

  it("moves off a deleted workspace to the oldest one that still exists", async () => {
    db.session.findUnique.mockResolvedValue(live);
    db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "owner", tenant: { deletedAt: new Date() } });
    db.membership.findFirst.mockResolvedValue({ tenantId: "t2", userId: "u1", role: "agent" });
    db.session.updateMany.mockResolvedValue({ count: 1 });
    db.session.createMany.mockResolvedValue({ count: 1 });
    expect(await rotateRefreshToken("x", null)).toMatchObject({ tenantId: "t2", role: "agent" });
    expect(db.membership.findFirst.mock.calls[0][0].where).toEqual({ userId: "u1", tenant: { deletedAt: null } });
    expect(db.session.createMany.mock.calls[0][0].data[0].tenantId).toBe("t2");
  });

  it("ends the session when no workspace is left, instead of looping between the app and the renewal", async () => {
    db.session.findUnique.mockResolvedValue(live);
    db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "owner", tenant: { deletedAt: new Date() } });
    db.membership.findFirst.mockResolvedValue(null);
    db.session.updateMany.mockResolvedValue({ count: 1 });
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
    expect(db.session.createMany).not.toHaveBeenCalled();
  });

  describe("two refreshes at once (tabs, wake-up)", () => {
    type Row = { id: string; userId: string; tenantId: string | null; refreshTokenHash: string; revokedAt: Date | null; expiresAt: Date };
    /** An in-memory session table, so the race plays out on real rows. */
    function sessionTable(rows: Row[]) {
      const table = new Map(rows.map((r) => [r.refreshTokenHash, r]));
      const matches = (r: Row, where: Record<string, unknown>) => {
        const hashes = (where.refreshTokenHash as { in?: string[] } | undefined)?.in;
        const or = where.OR as { revokedAt: null | { gt: Date } }[] | undefined;
        return (
          (where.id === undefined || r.id === where.id) &&
          (where.userId === undefined || r.userId === where.userId) &&
          (!hashes || hashes.includes(r.refreshTokenHash)) &&
          (!("revokedAt" in where) || r.revokedAt === null) &&
          (!or || or.some((c) => (c.revokedAt === null ? r.revokedAt === null : !!r.revokedAt && r.revokedAt > c.revokedAt.gt)))
        );
      };
      db.session.findUnique.mockImplementation(async ({ where }: { where: { refreshTokenHash?: string; id?: string } }) => {
        const row = where.refreshTokenHash ? table.get(where.refreshTokenHash) : [...table.values()].find((r) => r.id === where.id);
        return row ? { ...row, user: { disabledAt: null } } : null;
      });
      db.session.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: { revokedAt: Date } }) => {
        let count = 0;
        for (const r of table.values()) {
          if (!matches(r, where)) continue;
          r.revokedAt = data.revokedAt;
          count++;
        }
        return { count };
      });
      db.session.createMany.mockImplementation(async ({ data, skipDuplicates }: { data: Omit<Row, "id" | "revokedAt">[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const d of data) {
          if (table.has(d.refreshTokenHash)) {
            if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            continue;
          }
          table.set(d.refreshTokenHash, { id: `s${table.size + 1}`, revokedAt: null, ...d });
          count++;
        }
        return { count };
      });
      return table;
    }
    const first = (): Row => ({ id: "s1", userId: "u1", tenantId: "t1", refreshTokenHash: hashToken("tok"), revokedAt: null, expiresAt: new Date(Date.now() + 1e9) });
    const signedOutEverywhere = () => db.session.updateMany.mock.calls.some((c) => (c[0] as { where: { userId?: string } }).where.userId === "u1");

    beforeEach(() => {
      db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "admin" });
    });

    it("both get the same new session and nobody is signed out", async () => {
      const table = sessionTable([first()]);
      const [a, b] = await Promise.all([rotateRefreshToken("tok", "ua"), rotateRefreshToken("tok", "ua")]);
      expect(a.refreshToken).toBe(b.refreshToken);
      expect(a.refreshToken).toBe(successorToken("tok"));
      expect(table.size).toBe(2);
      expect(signedOutEverywhere()).toBe(false);
      expect(table.get(hashToken(a.refreshToken))?.revokedAt).toBeNull();
    });

    it("the old token presented again within the grace minute gets the same successor", async () => {
      sessionTable([first()]);
      const a = await rotateRefreshToken("tok", "ua");
      const b = await rotateRefreshToken("tok", "ua");
      expect(b).toEqual(a);
      expect(signedOutEverywhere()).toBe(false);
    });

    it("after the grace minute, the old token is treated as stolen and every session ends", async () => {
      const table = sessionTable([first()]);
      await rotateRefreshToken("tok", "ua");
      table.get(hashToken("tok"))!.revokedAt = new Date(Date.now() - 1000);
      await expect(rotateRefreshToken("tok", "ua")).rejects.toMatchObject({ status: 401 });
      expect(signedOutEverywhere()).toBe(true);
      expect(table.get(hashToken(successorToken("tok")))!.revokedAt).not.toBeNull();
    });

    it("a successor that was signed out is not handed out again by its old token", async () => {
      const table = sessionTable([first()]);
      const a = await rotateRefreshToken("tok", "ua");
      table.get(hashToken(a.refreshToken))!.revokedAt = new Date(Date.now() - 1);
      await expect(rotateRefreshToken("tok", "ua")).rejects.toMatchObject({ status: 401 });
      expect(table.size).toBe(2);
    });

    it("a sign-out that lands between the read and the claim is not undone", async () => {
      const table = sessionTable([first()]);
      const read = db.session.findUnique.getMockImplementation()!;
      db.session.findUnique.mockImplementationOnce(async (args: unknown) => {
        const row = await read(args);
        table.get(hashToken("tok"))!.revokedAt = new Date(Date.now() - 1);
        return row;
      });
      await expect(rotateRefreshToken("tok", "ua")).rejects.toMatchObject({ status: 401 });
      expect(table.size).toBe(1);
    });

    const signOut = (token: string) => logoutPost(req("POST", {}, { cookie: `wa_refresh=${token}` }));
    const ended = (row: Row | undefined) => !!row?.revokedAt && row.revokedAt.getTime() <= Date.now();

    it("signing out with the old token in its grace minute also ends the new session", async () => {
      const table = sessionTable([first()]);
      // The rotation went through, but its response never reached the browser (or the sign-out raced it).
      const a = await rotateRefreshToken("tok", "ua");
      expect((await signOut("tok")).status).toBe(200);
      expect(ended(table.get(hashToken("tok")))).toBe(true);
      expect(ended(table.get(hashToken(a.refreshToken)))).toBe(true);
      // The old token no longer fetches the successor, and a late rotation response cannot sign the browser back in.
      await expect(rotateRefreshToken("tok", "ua")).rejects.toMatchObject({ status: 401 });
      await expect(rotateRefreshToken(a.refreshToken, "ua")).rejects.toMatchObject({ status: 401 });
      expect(table.size).toBe(2);
    });

    it("signing out reaches a successor that was itself rotated a moment ago", async () => {
      const table = sessionTable([first()]);
      const a = await rotateRefreshToken("tok", "ua");
      const b = await rotateRefreshToken(a.refreshToken, "ua");
      await signOut("tok");
      expect(ended(table.get(hashToken(a.refreshToken)))).toBe(true);
      expect(ended(table.get(hashToken(b.refreshToken)))).toBe(true);
    });

    it("signing out ends only this browser's sessions, not the person's other devices", async () => {
      const table = sessionTable([first(), { ...first(), id: "s9", refreshTokenHash: hashToken("other-device") }]);
      await signOut("tok");
      expect(ended(table.get(hashToken("tok")))).toBe(true);
      expect(table.get(hashToken("other-device"))!.revokedAt).toBeNull();
      expect(signedOutEverywhere()).toBe(false);
    });
  });
});

describe("getActor", () => {
  it("returns the role from the database, not the token", async () => {
    setMemberships("agent");
    const actor = await getActor(req("GET", undefined, { cookie: asCookie() }));
    expect(actor).toEqual({ userId: "u1", tenantId: "t1", role: "agent" });
  });

  it("accepts a Bearer header", async () => {
    setMemberships("admin");
    const token = signAccessToken({ sub: "u1", tid: "t1", role: "owner" });
    const r = new Request("https://wa.edwyz.com/api/x", { headers: { authorization: `Bearer ${token}` } });
    expect((await getActor(r)).role).toBe("admin");
  });

  it("rejects a valid token whose membership no longer exists", async () => {
    db.membership.findUnique.mockResolvedValue(null);
    await expect(getActor(req("GET", undefined, { cookie: asCookie() }))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects missing or forged tokens", async () => {
    await expect(getActor(req("GET"))).rejects.toMatchObject({ status: 401 });
    await expect(getActor(req("GET", undefined, { cookie: "wa_access=abc.def.ghi" }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("invites and roles", () => {
  const created = { id: "i1", email: "a@b.co", role: "agent", expiresAt: new Date() };

  it("agents cannot invite", async () => {
    setMemberships("agent");
    const res = await invitePost(req("POST", { email: "a@b.co", role: "agent" }, { cookie: asCookie() }));
    expect(res.status).toBe(403);
  });

  it("admins cannot invite admins but can invite agents", async () => {
    setMemberships("admin");
    db.user.findUnique.mockResolvedValue(null);
    db.invite.create.mockResolvedValue(created);
    const denied = await invitePost(req("POST", { email: "a@b.co", role: "admin" }, { cookie: asCookie() }));
    expect(denied.status).toBe(403);
    const ok = await invitePost(req("POST", { email: "a@b.co", role: "agent" }, { cookie: asCookie() }));
    expect(ok.status).toBe(201);
  });

  it("owners get a link and only the hash is stored", async () => {
    setMemberships("owner");
    db.user.findUnique.mockResolvedValue(null);
    db.invite.create.mockResolvedValue({ ...created, role: "admin" });
    const res = await invitePost(req("POST", { email: "A@B.co", role: "admin" }, { cookie: asCookie() }));
    expect(res.status).toBe(201);
    const { acceptUrl } = await res.json();
    const token = new URL(acceptUrl).searchParams.get("token")!;
    const data = db.invite.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(token));
    expect(data.email).toBe("a@b.co");
    expect(data.tenantId).toBe("t1");
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(token);
  });

  it("rejects inviting an owner and invalid input", async () => {
    setMemberships("owner");
    expect((await invitePost(req("POST", { email: "a@b.co", role: "owner" }, { cookie: asCookie() }))).status).toBe(400);
    expect((await invitePost(req("POST", { email: "nope", role: "agent" }, { cookie: asCookie() }))).status).toBe(400);
  });

  it("protects the last owner on demote and remove", async () => {
    setMemberships("owner", { u2: "owner" });
    db.membership.count.mockResolvedValue(1);
    const ctx = { params: Promise.resolve({ userId: "u2" }) };
    const demote = await memberPatch(req("PATCH", { role: "agent" }, { cookie: asCookie() }), ctx);
    expect(demote.status).toBe(400);
    const remove = await memberDelete(req("DELETE", undefined, { cookie: asCookie() }), ctx);
    expect(remove.status).toBe(400);
    expect(db.membership.update).not.toHaveBeenCalled();
    expect(db.membership.delete).not.toHaveBeenCalled();
  });

  it("allows demoting an owner when another owner exists, and audits it", async () => {
    setMemberships("owner", { u2: "owner" });
    db.membership.count.mockResolvedValue(2);
    db.membership.update.mockResolvedValue({});
    const res = await memberPatch(req("PATCH", { role: "admin" }, { cookie: asCookie() }), { params: Promise.resolve({ userId: "u2" }) });
    expect(res.status).toBe(200);
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("member.role_changed");
  });

  it("only owners change roles; admins cannot remove admins", async () => {
    setMemberships("admin", { u2: "admin" });
    const ctx = { params: Promise.resolve({ userId: "u2" }) };
    expect((await memberPatch(req("PATCH", { role: "agent" }, { cookie: asCookie() }), ctx)).status).toBe(403);
    expect((await memberDelete(req("DELETE", undefined, { cookie: asCookie() }), ctx)).status).toBe(403);
  });
});

describe("accept-invite", () => {
  const invite = (over = {}) => ({
    id: "i1",
    tenantId: "t1",
    email: "new@b.co",
    role: "agent",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + 1e8),
    tenant: { id: "t1", name: "Acme" },
    ...over,
  });
  const body = { token: "tok", name: "New Person", password: "a-long-enough-password" };

  it("rejects expired and already accepted invites", async () => {
    db.invite.findUnique.mockResolvedValue(invite({ expiresAt: new Date(Date.now() - 1000) }));
    expect((await acceptPost(req("POST", body))).status).toBe(400);
    db.invite.findUnique.mockResolvedValue(invite({ acceptedAt: new Date() }));
    expect((await acceptPost(req("POST", body))).status).toBe(400);
    db.invite.findUnique.mockResolvedValue(null);
    expect((await acceptPost(req("POST", body))).status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("is single use: a lost claim race creates nothing", async () => {
    db.invite.findUnique.mockResolvedValue(invite());
    db.user.findUnique.mockResolvedValue(null);
    db.invite.updateMany.mockResolvedValue({ count: 0 });
    expect((await acceptPost(req("POST", body))).status).toBe(400);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.membership.create).not.toHaveBeenCalled();
  });

  it("creates the user and membership, looks up by hash, and sets cookies", async () => {
    db.invite.findUnique.mockResolvedValue(invite());
    db.user.findUnique.mockResolvedValue(null);
    db.invite.updateMany.mockResolvedValue({ count: 1 });
    db.user.create.mockResolvedValue({ id: "u9", email: "new@b.co", name: "New Person" });
    db.membership.findUnique.mockResolvedValue(null);
    db.membership.create.mockResolvedValue({ role: "agent" });
    const res = await acceptPost(req("POST", body));
    expect(res.status).toBe(200);
    expect(db.invite.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: hashToken("tok") });
    expect(db.user.create.mock.calls[0][0].data.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("wa_access=") && c.includes("HttpOnly"))).toBe(true);
  });

  it("requires the existing password for an existing user", async () => {
    db.invite.findUnique.mockResolvedValue(invite());
    db.user.findUnique.mockResolvedValue({ id: "u5", email: "new@b.co", name: "X", passwordHash: await hashPassword("the-real-password") });
    const res = await acceptPost(req("POST", { token: "tok", password: "not-the-password!" }));
    expect(res.status).toBe(401);
    expect(db.invite.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a turned-off account with 403 and leaves the invite open", async () => {
    db.invite.findUnique.mockResolvedValue(invite());
    db.user.findUnique.mockResolvedValue({ id: "u5", email: "new@b.co", name: "X", disabledAt: new Date(), passwordHash: await hashPassword("the-real-password") });
    const res = await acceptPost(req("POST", { token: "tok", password: "the-real-password" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/turned off/);
    expect(db.invite.updateMany).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("treats an invite into a deleted workspace as invalid", async () => {
    db.invite.findUnique.mockResolvedValue(invite({ tenant: { id: "t1", name: "Acme", deletedAt: new Date() } }));
    expect((await acceptPost(req("POST", body))).status).toBe(400);
    expect(db.invite.findUnique.mock.calls[0][0].include.tenant.select.deletedAt).toBe(true);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe("login", () => {
  it("gives the same error for unknown email and wrong password", async () => {
    db.user.findUnique.mockResolvedValueOnce(null);
    const unknown = await loginPost(req("POST", { email: "x@y.co", password: "whatever-password" }));
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "x@y.co", name: "X", passwordHash: await hashPassword("right-password-1") });
    const wrong = await loginPost(req("POST", { email: "x@y.co", password: "wrong-password-1" }));
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("rate limits after 10 attempts per email and IP", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await loginPost(req("POST", { email: "x@y.co", password: "whatever-password" }, { ip: "9.9.9.9" }))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  // 31 logins, each running the deliberately slow scrypt check against the dummy hash: about 30 s of CPU on its own and
  // 46-60+ s while the full suite loads every core, so this one test gets a budget above the file's 60 s.
  it("rate limits per IP across emails", { timeout: 180_000 }, async () => {
    db.user.findUnique.mockResolvedValue(null);
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await loginPost(req("POST", { email: `u${i}@y.co`, password: "whatever-password" }))).status;
    }
    expect(last).toBe(429);
  });

  it("logs in, audits, and sets httpOnly cookies", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "x@y.co", name: "X", passwordHash: await hashPassword("right-password-1") });
    db.membership.findFirst.mockResolvedValue({ tenantId: "t1", role: "owner" });
    db.session.create.mockResolvedValue({});
    const res = await loginPost(req("POST", { email: "x@y.co", password: "right-password-1" }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => c.includes("HttpOnly") && c.includes("SameSite=Lax") && c.includes("Path=/"))).toBe(true);
    expect(db.auditLog.create.mock.calls.map((c) => c[0].data.action)).toContain("auth.login");
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain("right-password-1");
  });

  it("signs into the oldest workspace that was not deleted", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "x@y.co", name: "X", disabledAt: null, passwordHash: await hashPassword("right-password-1") });
    db.membership.findFirst.mockResolvedValue({ tenantId: "t2", role: "agent" });
    db.session.create.mockResolvedValue({});
    const res = await loginPost(req("POST", { email: "x@y.co", password: "right-password-1" }));
    expect(res.status).toBe(200);
    expect(db.membership.findFirst.mock.calls[0][0]).toMatchObject({ where: { userId: "u1", tenant: { deletedAt: null } }, orderBy: { createdAt: "asc" } });
    expect((await res.json()).tenantId).toBe("t2");
  });

  it("refuses a turned-off account with a clear 403 and no cookies, but only after the password matched", async () => {
    const hash = await hashPassword("right-password-1");
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "x@y.co", name: "X", disabledAt: new Date(), passwordHash: hash });
    const wrong = await loginPost(req("POST", { email: "x@y.co", password: "wrong-password-1" }));
    expect(wrong.status).toBe(401);
    const res = await loginPost(req("POST", { email: "x@y.co", password: "right-password-1" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/turned off/);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(db.session.create).not.toHaveBeenCalled();
    expect(db.auditLog.create.mock.calls.map((c) => c[0].data.action)).toContain("auth.login_refused");
  });

  it("answers 403 when every workspace of the account was deleted", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "x@y.co", name: "X", disabledAt: null, passwordHash: await hashPassword("right-password-1") });
    db.membership.findFirst.mockResolvedValue(null);
    const res = await loginPost(req("POST", { email: "x@y.co", password: "right-password-1" }));
    expect(res.status).toBe(403);
    expect(db.session.create).not.toHaveBeenCalled();
  });
});

describe("workspace list and switching", () => {
  it("/api/auth/me leaves deleted workspaces out of the switcher", async () => {
    setMemberships("owner");
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "x@y.co", name: "X", emailVerifiedAt: new Date() });
    db.membership.findMany.mockResolvedValue([{ role: "owner", tenant: { id: "t1", name: "Acme", slug: "acme" } }]);
    const res = await meGet(req("GET", undefined, { cookie: asCookie() }));
    expect(res.status).toBe(200);
    expect(db.membership.findMany.mock.calls[0][0].where).toEqual({ userId: "u1", tenant: { deletedAt: null } });
    expect((await res.json()).workspaces).toHaveLength(1);
  });

  it("refuses to switch into a deleted workspace and leaves the session where it was", async () => {
    db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
      const { tenantId, userId } = where.tenantId_userId;
      return { userId, tenantId, role: "owner", tenant: { deletedAt: tenantId === "t2" ? new Date() : null } };
    });
    const res = await switchPost(req("POST", { tenantId: "t2" }, { cookie: `${asCookie()}; wa_refresh=r1` }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/deleted/);
    expect(db.session.updateMany).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("switches into a live workspace", async () => {
    db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { tenantId: string; userId: string } } }) => {
      const { tenantId, userId } = where.tenantId_userId;
      return { userId, tenantId, role: tenantId === "t2" ? "agent" : "owner", tenant: { deletedAt: null } };
    });
    db.session.updateMany.mockResolvedValue({ count: 1 });
    const res = await switchPost(req("POST", { tenantId: "t2" }, { cookie: `${asCookie()}; wa_refresh=r1` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "t2", role: "agent" });
    expect(db.session.updateMany.mock.calls[0][0].data).toEqual({ tenantId: "t2" });
  });
});

describe("rate limiter", () => {
  it("resets after the window", () => {
    const l = createLimiter(2, 1000, "test-window");
    expect([l.consume("k", 0), l.consume("k", 1), l.consume("k", 2)]).toEqual([true, true, false]);
    expect(l.consume("k", 1001)).toBe(true);
  });
});

describe("origin check", () => {
  it("accepts the site origin only", () => {
    expect(() => assertSameOrigin(req("POST"))).not.toThrow();
    expect(() => assertSameOrigin(req("POST", undefined, { origin: "https://evil.example" }))).toThrow();
    expect(() => assertSameOrigin(req("POST", undefined, { origin: null }))).toThrow();
    expect(() => assertSameOrigin(req("POST", undefined, { origin: "not a url" }))).toThrow();
  });

  it("is enforced by state-changing routes", async () => {
    setMemberships("owner");
    const res = await invitePost(req("POST", { email: "a@b.co", role: "agent" }, { cookie: asCookie(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(db.invite.create).not.toHaveBeenCalled();
  });
});
