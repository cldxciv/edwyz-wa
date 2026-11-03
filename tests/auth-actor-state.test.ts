import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { membership: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

const assertTenantCanWrite = vi.fn();
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: (...a: unknown[]) => assertTenantCanWrite(...a) }));

const authenticateApiKey = vi.fn();
vi.mock("@/lib/integrations/apikeys", () => ({ authenticateApiKey: (...a: unknown[]) => authenticateApiKey(...a) }));

import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";
import { HttpError } from "@/lib/tenancy";

const token = () => signAccessToken({ sub: "u1", tid: "t1", role: "admin" });
const membership = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  tenantId: "t1",
  role: "admin",
  user: { disabledAt: null },
  tenant: { deletedAt: null },
  ...over,
});
const req = (method: string, path = "/api/contacts", headers: Record<string, string> = {}) =>
  new Request(`https://wa.test${path}`, { method, headers: { authorization: `Bearer ${token()}`, ...headers } });

beforeEach(() => {
  findUnique.mockReset();
  assertTenantCanWrite.mockReset();
  authenticateApiKey.mockReset();
});

describe("getActor workspace state", () => {
  it("returns the actor and skips the paywall check for reads", async () => {
    findUnique.mockResolvedValue(membership());
    await expect(getActor(req("GET"))).resolves.toEqual({ userId: "u1", tenantId: "t1", role: "admin" });
    expect(assertTenantCanWrite).not.toHaveBeenCalled();
  });

  it("runs the paywall check for writes and lets its error through", async () => {
    findUnique.mockResolvedValue(membership());
    assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscription required"));
    await expect(getActor(req("POST"))).rejects.toMatchObject({ status: 402 });
    expect(assertTenantCanWrite).toHaveBeenCalledWith("t1");
  });

  it("keeps sign-in, billing and workspace switching usable when locked", async () => {
    findUnique.mockResolvedValue(membership());
    assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscription required"));
    await expect(getActor(req("POST", "/api/billing/subscribe"))).resolves.toBeTruthy();
    await expect(getActor(req("POST", "/api/auth/switch-workspace"))).resolves.toBeTruthy();
  });

  it("keeps the notice receipts and Team activity's Turn off (a lowering) usable when locked, and nothing next to them", async () => {
    findUnique.mockResolvedValue(membership());
    assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscription required"));
    await expect(getActor(req("POST", "/api/notices"))).resolves.toBeTruthy();
    await expect(getActor(req("PATCH", "/api/notices/n_1"))).resolves.toBeTruthy();
    expect(assertTenantCanWrite).not.toHaveBeenCalled();
    // An exact path, not a loose prefix: a look-alike route still gets the paywall.
    await expect(getActor(req("POST", "/api/noticesx"))).rejects.toMatchObject({ status: 402 });
    await expect(getActor(req("POST", "/api/eddy/settings"))).rejects.toMatchObject({ status: 402 });
  });

  it("keeps a member's own account (password, name) usable when locked", async () => {
    findUnique.mockResolvedValue(membership());
    assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscription required"));
    await expect(getActor(req("POST", "/api/account/password"))).resolves.toBeTruthy();
    await expect(getActor(req("PATCH", "/api/account/profile"))).resolves.toBeTruthy();
    expect(assertTenantCanWrite).not.toHaveBeenCalled();
    // Renaming the workspace is a workspace setting and keeps the paywall.
    await expect(getActor(req("PATCH", "/api/workspace"))).rejects.toMatchObject({ status: 402 });
  });

  it("skips the workspace check only when the caller asks (the admin console), and still checks the person", async () => {
    findUnique.mockResolvedValue(membership());
    assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscription required"));
    await expect(getActor(req("POST", "/api/admin/verify"))).rejects.toMatchObject({ status: 402 });
    await expect(getActor(req("POST", "/api/admin/verify"), { skipWorkspaceState: true })).resolves.toEqual({ userId: "u1", tenantId: "t1", role: "admin" });
    expect(assertTenantCanWrite).toHaveBeenCalledTimes(1);
    findUnique.mockResolvedValue(membership({ user: { disabledAt: new Date() } }));
    await expect(getActor(req("POST", "/api/admin/verify"), { skipWorkspaceState: true })).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a disabled user and a deleted workspace", async () => {
    findUnique.mockResolvedValue(membership({ user: { disabledAt: new Date() } }));
    await expect(getActor(req("GET"))).rejects.toMatchObject({ status: 401 });
    findUnique.mockResolvedValue(membership({ tenant: { deletedAt: new Date() } }));
    await expect(getActor(req("GET"))).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a user with no membership in the token's workspace", async () => {
    findUnique.mockResolvedValue(null);
    await expect(getActor(req("GET"))).rejects.toMatchObject({ status: 401 });
  });
});

describe("getActor ties the access token to its session", () => {
  const sessionReq = () =>
    new Request("https://wa.test/api/contacts", { headers: { authorization: `Bearer ${signAccessToken({ sub: "u1", tid: "t1", role: "admin", sid: "hash-1" })}` } });

  it("accepts a token whose session is still live and asks the database about that session only", async () => {
    findUnique.mockResolvedValue(membership({ user: { disabledAt: null, sessions: [{ id: "s1" }] } }));
    await expect(getActor(sessionReq())).resolves.toEqual({ userId: "u1", tenantId: "t1", role: "admin" });
    const sessions = findUnique.mock.calls[0][0].include.user.select.sessions;
    expect(sessions.where).toMatchObject({ refreshTokenHash: "hash-1", OR: [{ revokedAt: null }, { revokedAt: { gt: expect.any(Date) } }] });
  });

  it("refuses a token whose session was revoked, for example by a password reset", async () => {
    findUnique.mockResolvedValue(membership({ user: { disabledAt: null, sessions: [] } }));
    await expect(getActor(sessionReq())).rejects.toMatchObject({ status: 401 });
  });
});

describe("getActor does not accept API keys (P3-02)", () => {
  const keyReq = (method = "POST", extra: Record<string, string> = {}) =>
    new Request("https://wa.test/api/inbox/conversations", { method, headers: { authorization: "Bearer wak_abc123", ...extra } });

  it("rejects a wak_ bearer on session routes without consulting the key store or the database", async () => {
    authenticateApiKey.mockResolvedValue({ actor: { userId: "u9", tenantId: "t9", role: "agent" }, keyId: "k", scopes: ["messages:write"] });
    await expect(getActor(keyReq("GET"))).rejects.toMatchObject({ status: 401 });
    await expect(getActor(keyReq("POST"))).rejects.toMatchObject({ status: 401 });
    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(assertTenantCanWrite).not.toHaveBeenCalled();
  });

  it("does not fall back to a session cookie when the bearer is an API key", async () => {
    findUnique.mockResolvedValue(membership());
    await expect(getActor(keyReq("GET", { cookie: `wa_access=${token()}` }))).rejects.toMatchObject({ status: 401 });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
