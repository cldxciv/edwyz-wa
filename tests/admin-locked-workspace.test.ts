import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The platform admin's own workspace can be locked (trial over while online payment is not set up) or suspended. Admin writes act on
 * other workspaces and have their own rule (allowlist, verified email, TOTP step-up), so they must keep working: before the fix every
 * admin write, the step-up included, answered 404. getActor, the billing status and the admin rule run for real here.
 */
process.env.SESSION_SECRET = "locked-admin-secret-locked-admin-secret";
process.env.SITE_URL = "https://wa.edwyz.com";
process.env.PLATFORM_ADMIN_EMAILS = "boss@edwyz.com";

const DAY = 86_400_000;
const db = vi.hoisted(() => ({
  membership: { findUnique: vi.fn() },
  tenant: { findUnique: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const security = vi.hoisted(() => ({ verifyStepUpCode: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/admin/security", () => security);

import { POST as verifyPost } from "@/app/api/admin/verify/route";
import { requireAdminIdentity } from "@/lib/admin/auth";
import { handleAdmin } from "@/lib/admin/http";
import { ADMIN_COOKIE, signStepUp } from "@/lib/admin/stepup";
import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";

const ORIGIN = "https://wa.edwyz.com";
const access = `wa_access=${signAccessToken({ sub: "u1", tid: "t1", role: "owner" })}`;
const post = (path: string, body: unknown, cookie = access) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify(body) });

type WorkspaceRow = { status: "active" | "suspended"; suspendedReason: string | null; billingExempt: boolean; trialEndsAt: Date | null; subscription: null };
const trialOver: WorkspaceRow = { status: "active", suspendedReason: null, billingExempt: false, trialEndsAt: new Date(Date.now() - DAY), subscription: null };

beforeEach(() => {
  vi.clearAllMocks();
  db.membership.findUnique.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner", user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: null } });
  db.tenant.findUnique.mockResolvedValue(trialOver);
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ email: "boss@edwyz.com", name: "Boss", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: new Date() });
  db.auditLog.create.mockResolvedValue({});
  security.verifyStepUpCode.mockResolvedValue(undefined);
});

describe("admin console while the admin's own workspace is locked", () => {
  it("the workspace really is read-only for ordinary writes", async () => {
    await expect(getActor(post("/api/contacts", {}))).rejects.toMatchObject({ status: 402 });
  });

  it("POST /api/admin/verify (the TOTP step-up) still answers 200 and sets the step-up cookie", async () => {
    const res = await verifyPost(post("/api/admin/verify", { code: "123456" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain(`${ADMIN_COOKIE}=`);
    expect(security.verifyStepUpCode).toHaveBeenCalledWith("u1", { code: "123456", recoveryCode: "" });
  });

  it("an admin mutation goes through once step-up is done, in a locked or a suspended workspace", async () => {
    const cookie = `${access}; ${ADMIN_COOKIE}=${signStepUp("u1")}`;
    const run = () => handleAdmin(post("/api/admin/tenants/t9", { action: "extend_trial" }, cookie), true, async () => ({ ok: true }));
    expect((await run()).status).toBe(200);
    db.tenant.findUnique.mockResolvedValue({ ...trialOver, status: "suspended", suspendedReason: "Testing" });
    expect((await run()).status).toBe(200);
  });

  it("only the workspace check is skipped: a non-admin, a disabled user or a missing step-up is still a 404", async () => {
    db.user.findUnique.mockResolvedValue({ email: "someone@shop.in", name: "S", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: null });
    expect((await verifyPost(post("/api/admin/verify", { code: "123456" }))).status).toBe(404);
    db.user.findUnique.mockResolvedValue({ email: "boss@edwyz.com", name: "Boss", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: new Date() });
    db.membership.findUnique.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner", user: { disabledAt: new Date() }, tenant: { deletedAt: null } });
    await expect(requireAdminIdentity(post("/api/admin/verify", {}))).rejects.toMatchObject({ status: 404 });
    db.membership.findUnique.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner", user: { disabledAt: null, emailVerifiedAt: new Date() }, tenant: { deletedAt: null } });
    expect((await handleAdmin(post("/api/admin/tenants/t9", {}), true, async () => ({ ok: true }))).status).toBe(404);
    expect(security.verifyStepUpCode).not.toHaveBeenCalled();
  });
});
