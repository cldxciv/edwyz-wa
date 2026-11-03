import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "account-secret-account-secret-123456";
process.env.SITE_URL = "https://wa.edwyz.com";
process.env.EMAIL_VERIFICATION_REQUIRED = "false";

const db = vi.hoisted(() => {
  const prisma = {
    membership: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    session: { create: vi.fn(), updateMany: vi.fn() },
    tenant: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma),
  };
  return prisma;
});
const billing = vi.hoisted(() => ({ assertTenantCanWrite: vi.fn() }));
const mail = vi.hoisted(() => ({ queueEmail: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/email", () => mail);
vi.setConfig({ testTimeout: 60_000 });

import { POST as passwordPost } from "@/app/api/account/password/route";
import { PATCH as profilePatch } from "@/app/api/account/profile/route";
import { PATCH as workspacePatch } from "@/app/api/workspace/route";
import {
  MAX_NAME, MAX_NEW_PASSWORD, MIN_NEW_PASSWORD, SAME_PASSWORD, WRONG_CURRENT_PASSWORD, hasErrors, nameError, passwordErrors, passwordRefusal,
} from "@/components/account/account-helpers";
import { accountMenuItems } from "@/components/app/UserMenu";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from "@/lib/auth/password";
import { hashToken, signAccessToken, verifyAccessToken } from "@/lib/auth/tokens";
import { HttpError } from "@/lib/tenancy";

const ORIGIN = "https://wa.edwyz.com";
type Role = "owner" | "admin" | "agent";

/** `sub` picks the signed-in member; the password route limits attempts per member, so its tests sign in as a new one each time. */
function req(path: string, method: string, body: unknown, opts: { role?: Role; origin?: string; sub?: string } = {}) {
  const token = signAccessToken({ sub: opts.sub ?? "u1", tid: "t1", role: opts.role ?? "owner" });
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: opts.origin ?? ORIGIN, cookie: `wa_access=${token}`, "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

let role: Role = "owner";
let currentHash = "";

beforeEach(async () => {
  vi.clearAllMocks();
  role = "owner";
  currentHash ||= await hashPassword("the-current-password");
  db.membership.findUnique.mockImplementation(async ({ where }: { where: { tenantId_userId: { userId: string } } }) => ({
    userId: where.tenantId_userId.userId, tenantId: "t1", role, user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: null },
  }));
  db.user.findUnique.mockImplementation(async () => ({ id: "u1", email: "ann@shop.in", name: "Ann", passwordHash: currentHash }));
  db.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "u1", email: "ann@shop.in", name: "Ann", ...data }));
  db.session.create.mockResolvedValue({});
  db.session.updateMany.mockResolvedValue({ count: 3 });
  db.tenant.findUnique.mockResolvedValue({ name: "Old name" });
  db.tenant.update.mockImplementation(async ({ data }: { data: { name: string } }) => ({ id: "t1", name: data.name, slug: "old-name" }));
  db.auditLog.create.mockResolvedValue({});
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  mail.queueEmail.mockResolvedValue(undefined);
});

const actions = () => db.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);

describe("POST /api/account/password", () => {
  let member = 0;
  const change = (body: unknown) => passwordPost(req("/api/account/password", "POST", body, { sub: `pw-${++member}` }));

  it("changes the password, signs out every session and keeps this browser signed in with a fresh one", async () => {
    const res = await change({ currentPassword: "the-current-password", newPassword: "a brand new passphrase" });
    expect(res.status).toBe(200);
    const saved = (db.user.update.mock.calls[0][0] as { data: { passwordHash: string } }).data.passwordHash;
    expect(await verifyPassword("a brand new passphrase", saved)).toBe(true);
    // Every live session ends, including ones still inside their rotation grace minute.
    const revoke = db.session.updateMany.mock.calls[0][0] as { where: { userId: string; OR: unknown[] } };
    expect(revoke.where.userId).toBe("u1");
    expect(revoke.where.OR).toEqual([{ revokedAt: null }, { revokedAt: { gt: expect.any(Date) } }]);
    // A new session for this browser, and its cookies.
    const created = (db.session.create.mock.calls[0][0] as { data: { refreshTokenHash: string; tenantId: string } }).data;
    expect(created.tenantId).toBe("t1");
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const access = cookies.find((c) => c.startsWith("wa_access="))!.split(";")[0].slice("wa_access=".length);
    const refresh = cookies.find((c) => c.startsWith("wa_refresh="))!.split(";")[0].slice("wa_refresh=".length);
    expect(verifyAccessToken(access)).toMatchObject({ sub: "u1", tid: "t1", role: "owner", sid: hashToken(refresh) });
    expect(created.refreshTokenHash).toBe(hashToken(refresh));
    expect(actions()).toContain("auth.password_changed");
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain("brand new");
  });

  it("emails the account holder that the password changed, with no link in it", async () => {
    await change({ currentPassword: "the-current-password", newPassword: "a brand new passphrase" });
    expect(mail.queueEmail).toHaveBeenCalledOnce();
    const message = mail.queueEmail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(message.to).toBe("ann@shop.in");
    expect(message.subject).toMatch(/password was changed/i);
    expect(message.text).not.toMatch(/https?:\/\/\S+token=/);
  });

  it("refuses a wrong current password with 403 and changes nothing", async () => {
    const res = await change({ currentPassword: "not-the-password", newPassword: "a brand new passphrase" });
    expect(res.status).toBe(403);
    // Named for the page, which shows it under the Current password field (see passwordRefusal).
    expect(await res.json()).toEqual({ error: WRONG_CURRENT_PASSWORD, field: "currentPassword" });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.session.updateMany).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("checks the new password before anything else", async () => {
    expect((await change({ currentPassword: "the-current-password", newPassword: "short" })).status).toBe(400);
    expect((await change({ currentPassword: "the-current-password", newPassword: "the-current-password" })).status).toBe(400);
    expect((await change({ newPassword: "a brand new passphrase" })).status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("names the New password field when it refuses the new password", async () => {
    const short = await change({ currentPassword: "the-current-password", newPassword: "short" });
    expect(await short.json()).toEqual({ error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, field: "newPassword" });
    const long = await change({ currentPassword: "the-current-password", newPassword: "y".repeat(MAX_PASSWORD_LENGTH + 1) });
    expect((await long.json()).field).toBe("newPassword");
    const same = await change({ currentPassword: "the-current-password", newPassword: "the-current-password" });
    expect(await same.json()).toEqual({ error: SAME_PASSWORD, field: "newPassword" });
    // A missing current password is not a field the page can get wrong (it checks first), so it carries no field.
    expect((await (await change({ newPassword: "a brand new passphrase" })).json()).field).toBeUndefined();
  });

  it("limits attempts per person", async () => {
    const attempt = () => passwordPost(req("/api/account/password", "POST", { currentPassword: "x", newPassword: "short" }, { sub: "u-rate" }));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("works in a locked workspace: the password belongs to the person, not the workspace", async () => {
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscribe to continue."));
    const res = await change({ currentPassword: "the-current-password", newPassword: "a brand new passphrase" });
    expect(res.status).toBe(200);
    expect(billing.assertTenantCanWrite).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    const res = await passwordPost(req("/api/account/password", "POST", { currentPassword: "the-current-password", newPassword: "a brand new passphrase" }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/account/profile", () => {
  it("lets any member change their own name, trimmed, and audits it", async () => {
    role = "agent";
    const res = await profilePatch(req("/api/account/profile", "PATCH", { name: "  Ann Kumar " }, { role: "agent" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "u1", email: "ann@shop.in", name: "Ann Kumar" } });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { name: "Ann Kumar" }, select: { id: true, email: true, name: true } });
    expect(actions()).toContain("account.profile_updated");
  });

  it("refuses an empty or too long name", async () => {
    expect((await profilePatch(req("/api/account/profile", "PATCH", { name: "   " }))).status).toBe(400);
    expect((await profilePatch(req("/api/account/profile", "PATCH", { name: "x".repeat(101) }))).status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("works in a locked workspace", async () => {
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscribe to continue."));
    expect((await profilePatch(req("/api/account/profile", "PATCH", { name: "Ann" }))).status).toBe(200);
  });
});

describe("PATCH /api/workspace", () => {
  it("lets the owner rename the workspace and keeps its web address", async () => {
    const res = await workspacePatch(req("/api/workspace", "PATCH", { name: "Ann's Shop" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspace: { id: "t1", name: "Ann's Shop", slug: "old-name" } });
    expect(db.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { name: "Ann's Shop" }, select: { id: true, name: true, slug: true } });
    const entry = db.auditLog.create.mock.calls[0][0] as { data: { action: string; meta: Record<string, string> } };
    expect(entry.data).toMatchObject({ action: "workspace.renamed", meta: { from: "Old name", to: "Ann's Shop" } });
  });

  it("is for the owner only", async () => {
    for (const r of ["admin", "agent"] as const) {
      role = r;
      expect((await workspacePatch(req("/api/workspace", "PATCH", { name: "New" }, { role: r }))).status).toBe(403);
    }
    expect(db.tenant.update).not.toHaveBeenCalled();
  });

  it("refuses an empty name, and keeps the paywall (it is a workspace setting)", async () => {
    expect((await workspacePatch(req("/api/workspace", "PATCH", { name: "" }))).status).toBe(400);
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Subscribe to continue."));
    expect((await workspacePatch(req("/api/workspace", "PATCH", { name: "New" }))).status).toBe(402);
    expect(db.tenant.update).not.toHaveBeenCalled();
  });
});

describe("account page checks", () => {
  it("match the server's password limits", () => {
    expect(MIN_NEW_PASSWORD).toBe(MIN_PASSWORD_LENGTH);
    expect(MAX_NEW_PASSWORD).toBe(MAX_PASSWORD_LENGTH);
    expect(MAX_NAME).toBe(100);
  });

  it("say how to fix each password field", () => {
    const ok = passwordErrors({ current: "old-password-1", next: "a new long one", confirm: "a new long one" });
    expect(hasErrors(ok)).toBe(false);
    expect(passwordErrors({ current: "", next: "short", confirm: "other" })).toEqual({
      current: "Enter your current password.",
      next: "Use at least 10 characters.",
      confirm: "The two new passwords do not match. Type the new password again.",
    });
    expect(passwordErrors({ current: "same-password", next: "same-password", confirm: "same-password" }).next).toBe("Choose a password that is different from your current one.");
    expect(passwordErrors({ current: "x", next: "y".repeat(201), confirm: "y".repeat(201) }).next).toBe("Use 200 characters or fewer.");
  });

  it("put a refused password under the field the server names, and leave anything else to a toast", () => {
    const thrown = (message: string, body: unknown) => Object.assign(new Error(message), { body });
    expect(passwordRefusal(thrown(WRONG_CURRENT_PASSWORD, { error: WRONG_CURRENT_PASSWORD, field: "currentPassword" }))).toEqual({ field: "current", message: WRONG_CURRENT_PASSWORD });
    expect(passwordRefusal(thrown(SAME_PASSWORD, { error: SAME_PASSWORD, field: "newPassword" }))).toEqual({ field: "next", message: SAME_PASSWORD });
    // Too many attempts, a server fault, offline (no body) and anything that is not an Error: a toast.
    expect(passwordRefusal(thrown("Too many attempts. Please wait a few minutes and try again.", { error: "Too many attempts." }))).toBeNull();
    expect(passwordRefusal(thrown("We could not reach the server.", undefined))).toBeNull();
    expect(passwordRefusal(thrown("Odd", { field: "toString" }))).toBeNull();
    expect(passwordRefusal("nope")).toBeNull();
    // The page's own check and the server's refusal use the same words.
    expect(passwordErrors({ current: "same-password", next: "same-password", confirm: "same-password" }).next).toBe(SAME_PASSWORD);
  });

  it("say how to fix a name", () => {
    expect(nameError("  ", "your name")).toBe("Enter your name.");
    expect(nameError("", "a name for the workspace")).toBe("Enter a name for the workspace.");
    expect(nameError("x".repeat(101), "your name")).toBe("Use 100 characters or fewer.");
    expect(nameError("Ann", "your name")).toBeNull();
  });
});

describe("account menu", () => {
  const labels = (r: Role) => accountMenuItems(r, () => undefined).map((i) => ("separator" in i ? "-" : i.label));
  it("offers every member their account page and All projects, and team and billing to owners and admins", () => {
    expect(labels("agent")).toEqual(["Your account", "All projects", "-", "Sign out"]);
    expect(labels("admin")).toEqual(["Your account", "Team and roles", "Billing", "All projects", "-", "Sign out"]);
    expect(labels("owner")).toEqual(labels("admin"));
    expect(accountMenuItems("agent", () => undefined)[0]).toMatchObject({ href: "/app/account", icon: "user" });
  });
});
