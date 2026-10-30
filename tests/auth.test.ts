import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
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
import { POST as invitePost } from "@/app/api/workspace/invites/route";
import { DELETE as memberDelete, PATCH as memberPatch } from "@/app/api/workspace/members/[userId]/route";
import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { resetLoginLimits } from "@/lib/auth/ratelimit";
import { createLimiter } from "@/lib/ratelimit";
import { hashToken, rotateRefreshToken, signAccessToken, verifyAccessToken } from "@/lib/auth/tokens";

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
  const live = { id: "s1", userId: "u1", tenantId: "t1", revokedAt: null, expiresAt: new Date(Date.now() + 1e9) };

  it("rotates: revokes the old session and stores only a hash of the new token", async () => {
    db.session.findUnique.mockResolvedValue(live);
    db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "admin" });
    db.session.updateMany.mockResolvedValue({ count: 1 });
    const out = await rotateRefreshToken("old-token", "ua");
    expect(db.session.findUnique).toHaveBeenCalledWith({ where: { refreshTokenHash: hashToken("old-token") } });
    expect(out).toMatchObject({ userId: "u1", tenantId: "t1", role: "admin" });
    const stored = db.session.create.mock.calls[0][0].data;
    expect(stored.refreshTokenHash).toBe(hashToken(out.refreshToken));
    expect(JSON.stringify(stored)).not.toContain(out.refreshToken);
  });

  it("revokes all user sessions when a revoked token is reused", async () => {
    db.session.findUnique.mockResolvedValue({ ...live, revokedAt: new Date() });
    db.session.updateMany.mockResolvedValue({ count: 3 });
    await expect(rotateRefreshToken("old-token", null)).rejects.toMatchObject({ status: 401 });
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(db.session.create).not.toHaveBeenCalled();
  });

  it("treats losing the rotation race as reuse", async () => {
    db.session.findUnique.mockResolvedValue(live);
    db.membership.findUnique.mockResolvedValue({ tenantId: "t1", userId: "u1", role: "agent" });
    db.session.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 2 });
    await expect(rotateRefreshToken("t", null)).rejects.toMatchObject({ status: 401 });
    expect(db.session.create).not.toHaveBeenCalled();
  });

  it("rejects unknown and expired tokens", async () => {
    db.session.findUnique.mockResolvedValue(null);
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
    db.session.findUnique.mockResolvedValue({ ...live, expiresAt: new Date(Date.now() - 1000) });
    await expect(rotateRefreshToken("x", null)).rejects.toMatchObject({ status: 401 });
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
