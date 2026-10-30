import { beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn(async () => user.current) } } }));
vi.mock("@/lib/auth", () => ({ getActor: vi.fn(async () => ({ userId: "u1", tenantId: "t1", role: "owner" })) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn(), syncPlanToRazorpay: vi.fn() }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));
vi.mock("@/lib/graph", () => ({ graphFetch: vi.fn(), GraphError: class extends Error {} }));

import { evaluateAdminAccess, requirePlatformAdmin } from "@/lib/admin/auth";
import { ADMIN_COOKIE, signStepUp, verifyStepUp } from "@/lib/admin/stepup";

const ALLOW = "boss@x.com,other@x.com";
const good = { email: "boss@x.com", emailVerifiedAt: new Date(), totpEnabledAt: new Date(), stepUpValid: true, allowlist: ALLOW };

beforeEach(() => {
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.PLATFORM_ADMIN_EMAILS = ALLOW;
  process.env.SITE_URL = "https://wa.edwyz.com";
  user.current = { email: "boss@x.com", name: "Boss", emailVerifiedAt: new Date(), disabledAt: null, totpEnabledAt: new Date() };
});

describe("access rule", () => {
  it("needs allowlist AND verified email AND enrolment AND step-up", () => {
    expect(evaluateAdminAccess(good)).toBe("ok");
    expect(evaluateAdminAccess({ ...good, email: "evil@x.com" })).toBe("deny");
    expect(evaluateAdminAccess({ ...good, emailVerifiedAt: null })).toBe("deny");
    expect(evaluateAdminAccess({ ...good, disabledAt: new Date() })).toBe("deny");
    expect(evaluateAdminAccess({ ...good, totpEnabledAt: null })).toBe("enroll");
    expect(evaluateAdminAccess({ ...good, stepUpValid: false })).toBe("verify");
  });
  it("strangers never learn about enrolment", () => {
    expect(evaluateAdminAccess({ ...good, email: "evil@x.com", totpEnabledAt: null })).toBe("deny");
  });
});

describe("step-up cookie", () => {
  it("is bound to the user and expires after 30 minutes", () => {
    const now = 1_700_000_000_000;
    const v = signStepUp("u1", now);
    expect(verifyStepUp(v, "u1", now + 29 * 60_000)).toBe(true);
    expect(verifyStepUp(v, "u1", now + 31 * 60_000)).toBe(false);
    expect(verifyStepUp(v, "u2", now)).toBe(false);
    expect(verifyStepUp(v.slice(0, -2) + "xx", "u1", now)).toBe(false);
    expect(verifyStepUp(null, "u1", now)).toBe(false);
  });
});

describe("requirePlatformAdmin", () => {
  const req = (cookie?: string) => new Request("https://wa.edwyz.com/api/admin/x", { headers: cookie ? { cookie } : {} });
  it("passes with a valid step-up cookie", async () => {
    await expect(requirePlatformAdmin(req(`${ADMIN_COOKIE}=${signStepUp("u1")}`))).resolves.toMatchObject({ email: "boss@x.com" });
  });
  it("404 without step-up, with unverified email, or off the list", async () => {
    await expect(requirePlatformAdmin(req())).rejects.toMatchObject({ status: 404 });
    user.current = { ...user.current, emailVerifiedAt: null };
    await expect(requirePlatformAdmin(req(`${ADMIN_COOKIE}=${signStepUp("u1")}`))).rejects.toMatchObject({ status: 404 });
    user.current = { ...user.current, emailVerifiedAt: new Date(), email: "evil@x.com" };
    await expect(requirePlatformAdmin(req(`${ADMIN_COOKIE}=${signStepUp("u1")}`))).rejects.toMatchObject({ status: 404 });
  });
});

describe("every admin API is a 404 without step-up", () => {
  const ctx = { params: Promise.resolve({ id: "x" }) };
  const post = (url: string, body: unknown = {}) =>
    new Request(`https://wa.edwyz.com${url}`, { method: "POST", headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (url: string) => new Request(`https://wa.edwyz.com${url}`);

  it("returns 404 for each handler", async () => {
    const calls: Promise<Response>[] = [];
    const t = await import("@/app/api/admin/tenants/route");
    const td = await import("@/app/api/admin/tenants/[id]/route");
    const u = await import("@/app/api/admin/users/route");
    const ud = await import("@/app/api/admin/users/[id]/route");
    const p = await import("@/app/api/admin/plans/route");
    const pd = await import("@/app/api/admin/plans/[id]/route");
    const s = await import("@/app/api/admin/settings/route");
    const a = await import("@/app/api/admin/audit/route");
    const pay = await import("@/app/api/admin/payments/route");
    const m = await import("@/app/api/admin/metrics/route");
    const tm = await import("@/app/api/admin/test-message/route");
    const tms = await import("@/app/api/admin/test-message/[id]/route");
    // Spending (docs/SPEND-CONTROLS-SPEC.md 8.3): the list, a workspace's card and actions, the platform switch, the settings.
    const sp = await import("@/app/api/admin/spending/route");
    const spt = await import("@/app/api/admin/spending/[tenantId]/route");
    const spp = await import("@/app/api/admin/spending/platform/route");
    const sps = await import("@/app/api/admin/spending/settings/route");
    const tctx = { params: Promise.resolve({ tenantId: "x" }) };
    calls.push(
      t.GET(get("/api/admin/tenants")), td.GET(get("/api/admin/tenants/x"), ctx), td.POST(post("/api/admin/tenants/x", { action: "suspend" }), ctx),
      u.GET(get("/api/admin/users")), ud.POST(post("/api/admin/users/x", { action: "disable" }), ctx),
      p.GET(get("/api/admin/plans")), p.POST(post("/api/admin/plans")), pd.PATCH(post("/api/admin/plans/x"), ctx), pd.POST(post("/api/admin/plans/x"), ctx),
      s.GET(get("/api/admin/settings")), s.PUT(post("/api/admin/settings")), a.GET(get("/api/admin/audit")), pay.GET(get("/api/admin/payments")), m.GET(get("/api/admin/metrics")),
      tm.POST(post("/api/admin/test-message")), tms.GET(get("/api/admin/test-message/x"), ctx),
      sp.GET(get("/api/admin/spending")),
      spt.GET(get("/api/admin/spending/x"), tctx), spt.POST(post("/api/admin/spending/x", { action: "lift_probation", reason: "x" }), tctx),
      spp.POST(post("/api/admin/spending/platform", { action: "stop_all", reason: "x", confirm: "STOP SPENDING" })),
      sps.GET(get("/api/admin/spending/settings")), sps.PUT(post("/api/admin/spending/settings", { section: "fx", currency: "USD", rate: "84", reason: "x" })),
    );
    const statuses = (await Promise.all(calls)).map((r) => r.status);
    expect(statuses.every((s) => s === 404)).toBe(true);
    expect(statuses).toHaveLength(22);
  }, 60_000); // imports every admin route module; cold imports under a busy machine exceed the default 5 s

  it("the spending handlers' other methods are a 404 too, and a 405 only for a signed-in admin", async () => {
    const sp = await import("@/app/api/admin/spending/route");
    const spp = await import("@/app/api/admin/spending/platform/route");
    const sps = await import("@/app/api/admin/spending/settings/route");
    const send = (method: string, url: string, cookie?: string) =>
      new Request(`https://wa.edwyz.com${url}`, { method, headers: { origin: "https://wa.edwyz.com", ...(cookie ? { cookie } : {}) } });
    const hidden = await Promise.all([sp.POST(send("POST", "/api/admin/spending")), spp.GET(send("GET", "/api/admin/spending/platform")), sps.POST(send("POST", "/api/admin/spending/settings"))]);
    expect(hidden.map((r) => r.status)).toEqual([404, 404, 404]);
    expect((await spp.GET(send("GET", "/api/admin/spending/platform", `${ADMIN_COOKIE}=${signStepUp("u1")}`))).status).toBe(405);
  }, 60_000);

  it("a method the route does not implement is a 404 too, and a 405 only for a signed-in admin", async () => {
    const s = await import("@/app/api/admin/settings/route");
    const td = await import("@/app/api/admin/tenants/[id]/route");
    const ud = await import("@/app/api/admin/users/[id]/route");
    const send = (method: string, url: string, cookie?: string) =>
      new Request(`https://wa.edwyz.com${url}`, { method, headers: { origin: "https://wa.edwyz.com", ...(cookie ? { cookie } : {}) } });
    const hidden = await Promise.all([s.POST(send("POST", "/api/admin/settings")), td.PATCH(send("PATCH", "/api/admin/tenants/x")), ud.PATCH(send("PATCH", "/api/admin/users/x"))]);
    expect(hidden.map((r) => r.status)).toEqual([404, 404, 404]);
    const admin = `${ADMIN_COOKIE}=${signStepUp("u1")}`;
    expect((await s.POST(send("POST", "/api/admin/settings", admin))).status).toBe(405);
  });

  it("identity-only endpoints also 404 for non-admins", async () => {
    user.current = { ...user.current, email: "evil@x.com" };
    const verify = await import("@/app/api/admin/verify/route");
    const enroll = await import("@/app/api/admin/security/enroll/route");
    const confirm = await import("@/app/api/admin/security/confirm/route");
    for (const r of await Promise.all([verify.POST(post("/api/admin/verify")), enroll.POST(post("/api/admin/security/enroll")), confirm.POST(post("/api/admin/security/confirm"))])) {
      expect(r.status).toBe(404);
    }
  });
});
