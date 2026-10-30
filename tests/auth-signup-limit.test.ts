import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SITE_URL = "https://wa.edwyz.com";

const db = vi.hoisted(() => {
  const prisma: Record<string, unknown> = {
    user: { findUnique: vi.fn(), create: vi.fn() },
    tenant: { findUnique: vi.fn(), create: vi.fn() },
    membership: { create: vi.fn() },
    session: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma as never;
});
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ startTrial: vi.fn(async () => undefined), assertTenantCanWrite: async () => undefined }));
vi.mock("@/lib/email/flows", () => ({ sendVerificationEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "hash", verifyPassword: async () => true }));
vi.mock("@/lib/auth/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/tokens")>()),
  createSession: vi.fn(async () => "refresh-token"),
}));

import { POST as signupPost } from "@/app/api/auth/signup/route";
import { checkSignupLimit, resetLoginLimits } from "@/lib/auth/ratelimit";

const signup = (ip: string, email = "a@b.co") =>
  new Request("https://wa.edwyz.com/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://wa.edwyz.com", "x-real-ip": ip },
    body: JSON.stringify({ name: "Asha", email, workspaceName: "Acme", password: "a-long-enough-password" }),
  });

type Fn = ReturnType<typeof vi.fn>;
const users = db as unknown as { user: { findUnique: Fn; create: Fn }; tenant: { findUnique: Fn; create: Fn }; membership: { create: Fn } };

beforeEach(async () => {
  await resetLoginLimits();
  users.user.findUnique.mockResolvedValue(null);
  users.user.create.mockResolvedValue({ id: "u1", email: "a@b.co", name: "Asha" });
  users.tenant.findUnique.mockResolvedValue(null);
  users.tenant.create.mockResolvedValue({ id: "t1", name: "Acme", slug: "acme" });
  users.membership.create.mockResolvedValue({});
});

describe("signup abuse protection", () => {
  it("allows a handful of sign-ups from one address in an hour, then answers 429", async () => {
    for (let i = 0; i < 8; i++) await expect(checkSignupLimit("203.0.113.5")).resolves.toBeUndefined();
    await expect(checkSignupLimit("203.0.113.5")).rejects.toMatchObject({ status: 429 });
  });

  it("counts each address on its own", async () => {
    for (let i = 0; i < 8; i++) await checkSignupLimit("203.0.113.5");
    await expect(checkSignupLimit("203.0.113.6")).resolves.toBeUndefined();
  });

  it("the signup route stops before hashing a password or touching the database once the limit is hit", async () => {
    for (let i = 0; i < 8; i++) expect((await signupPost(signup("198.51.100.9"))).status).toBe(201);
    users.user.findUnique.mockClear();
    users.user.create.mockClear();
    const res = await signupPost(signup("198.51.100.9"));
    expect(res.status).toBe(429);
    expect(users.user.findUnique).not.toHaveBeenCalled();
    expect(users.user.create).not.toHaveBeenCalled();
    expect((await signupPost(signup("198.51.100.10"))).status).toBe(201);
  });

  it("a request from another origin is refused before it is counted", async () => {
    const bad = new Request("https://wa.edwyz.com/api/auth/signup", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", "x-real-ip": "192.0.2.1" }, body: "{}" });
    expect((await signupPost(bad)).status).toBe(403);
    for (let i = 0; i < 8; i++) await expect(checkSignupLimit("192.0.2.1")).resolves.toBeUndefined();
  });
});
