import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin pages answered 404 once the 15-minute sign-in expired (QA 2026-10-30): /app renews through /api/auth/continue, admin did not.
const jar = vi.hoisted(() => ({ cookies: {} as Record<string, string>, path: "/admin/spending" as string | null }));
const denied = vi.hoisted(() => ({ value: true }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar.cookies ? { name, value: jar.cookies[name] } : undefined),
    toString: () => Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join("; "),
  }),
  headers: async () => new Headers(jar.path ? { "x-pathname": jar.path } : {}),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/admin/auth", () => ({
  requireAdminIdentity: vi.fn(async () => {
    if (denied.value) throw new Error("denied");
    return { actor: {}, userId: "u1", email: "boss@x.com", name: "Boss", totpEnabled: true, access: "ok" };
  }),
}));

import { needsRenewal, requireAdminPage } from "@/lib/admin/page";
import { signAccessToken } from "@/lib/auth/tokens";

beforeEach(() => {
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.SITE_URL = "https://wa.edwyz.com";
  jar.cookies = {};
  jar.path = "/admin/spending";
  denied.value = true;
});

describe("needsRenewal", () => {
  it("renews only when the access token is missing or expired and a refresh cookie exists", () => {
    const now = Date.now();
    const fresh = signAccessToken({ sub: "u1", tid: "t1", role: "owner" }, now);
    const stale = signAccessToken({ sub: "u1", tid: "t1", role: "owner" }, now - 16 * 60_000);
    expect(needsRenewal(undefined, "r", now)).toBe(true);
    expect(needsRenewal(stale, "r", now)).toBe(true);
    expect(needsRenewal("garbage", "r", now)).toBe(true);
    // A valid token that still fails the admin check must not renew: continue would send it straight back (a loop).
    expect(needsRenewal(fresh, "r", now)).toBe(false);
    // No refresh cookie: a stranger, 404 at once.
    expect(needsRenewal(undefined, undefined, now)).toBe(false);
    expect(needsRenewal(stale, undefined, now)).toBe(false);
  });
});

describe("requireAdminPage", () => {
  it("sends an expired admin session through /api/auth/continue back to the same page", async () => {
    jar.cookies = { wa_refresh: "r" };
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT /api/auth/continue?next=%2Fadmin%2Fspending");
  });

  it("keeps the query string of the page", async () => {
    jar.cookies = { wa_refresh: "r" };
    jar.path = "/admin/tenants?filter=paying";
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT /api/auth/continue?next=%2Fadmin%2Ftenants%3Ffilter%3Dpaying");
  });

  it("answers 404 to a visitor with no session", async () => {
    await expect(requireAdminPage()).rejects.toThrow("NOT_FOUND");
  });

  it("answers 404 to a signed-in non-admin instead of renewing", async () => {
    jar.cookies = { wa_access: signAccessToken({ sub: "u2", tid: "t1", role: "owner" }), wa_refresh: "r" };
    await expect(requireAdminPage()).rejects.toThrow("NOT_FOUND");
  });

  it("falls back to /admin when the path header is missing", async () => {
    jar.cookies = { wa_refresh: "r" };
    jar.path = null;
    await expect(requireAdminPage()).rejects.toThrow("REDIRECT /api/auth/continue?next=%2Fadmin");
  });

  it("lets a signed-in admin through", async () => {
    denied.value = false;
    await expect(requireAdminPage()).resolves.toMatchObject({ email: "boss@x.com" });
  });
});
