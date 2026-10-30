import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.SITE_URL = "https://wa.edwyz.com";

// The accept-invite tests run the real password hash (deliberately slow, like tests/auth.test.ts). Under full-suite load
// one of them passed the 5 s default (seen after the spend-controls and action-layer wave added ~250 tests), so give
// this file a realistic budget. It is a timing budget only; no assertion changed.
vi.setConfig({ testTimeout: 30_000 });

const db = vi.hoisted(() => {
  const prisma = {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    membership: { findUnique: vi.fn(), create: vi.fn() },
    invite: { deleteMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    session: { create: vi.fn() },
    $transaction: undefined as unknown,
  };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma;
});
const mail = vi.hoisted(() => ({ queueEmail: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: mail.queueEmail }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/auth/ratelimit", () => ({ checkLoginLimits: vi.fn(), clientIp: () => "1.1.1.1" }));
vi.mock("@/lib/auth/tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/tokens")>()),
  createSession: vi.fn().mockResolvedValue("refresh-token"),
}));

import { POST as acceptPost } from "@/app/api/auth/accept-invite/route";
import { POST as invitePost } from "@/app/api/workspace/invites/route";
import { createSession, hashToken } from "@/lib/auth/tokens";
import { unverifiedMayWrite } from "@/lib/auth/verification";

const ORIGIN = "https://wa.edwyz.com";
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.SMTP_USER;
  vi.mocked(createSession).mockResolvedValue("refresh-token");
  auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
  db.user.findUnique.mockResolvedValue(null);
  db.tenant.findUnique.mockResolvedValue({ name: "Acme" });
  db.invite.create.mockResolvedValue({ id: "inv1", email: "new@acme.test", role: "agent", expiresAt: new Date(Date.now() + 86_400_000) });
});

describe("an unverified account cannot use the platform to mail other people", () => {
  it("blocks invites, member changes and ownership transfers, and still allows workspace settings", () => {
    for (const p of ["/api/workspace/invites", "/api/workspace/invites/i1", "/api/workspace/members/u2", "/api/workspace/members", "/api/workspace/ownership"]) {
      expect(unverifiedMayWrite(p), p).toBe(false);
    }
    for (const p of ["/api/workspace/messaging-limits", "/api/workspace/profile", "/api/workspace/invitesettings"]) {
      expect(unverifiedMayWrite(p), p).toBe(true);
    }
    expect(unverifiedMayWrite("/api/billing/subscribe")).toBe(true);
  });
});

describe("the invite link goes to the invited mailbox", () => {
  it("queues the invite sealed, and hands the inviter no link when mail can be delivered", async () => {
    process.env.SMTP_USER = "mailer";
    const res = await invitePost(post("/api/workspace/invites", { email: "new@acme.test", role: "agent" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "inv1", email: "new@acme.test", emailed: true });
    expect(body.acceptUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("token=");
    expect(mail.queueEmail).toHaveBeenCalledTimes(1);
    expect(mail.queueEmail.mock.calls[0][0].text).toContain("accept-invite?token=");
    expect(mail.queueEmail.mock.calls[0][1]).toEqual({ seal: true });
  });

  it("returns the link only when this server cannot send mail at all", async () => {
    const res = await invitePost(post("/api/workspace/invites", { email: "new@acme.test", role: "agent" }));
    const body = await res.json();
    expect(body.emailed).toBe(false);
    expect(new URL(body.acceptUrl).searchParams.get("token")).toBeTruthy();
    expect(db.invite.create.mock.calls[0][0].data.tokenHash).toBe(hashToken(new URL(body.acceptUrl).searchParams.get("token")!));
  });
});

// Accepting an invite hashes or verifies a password with scrypt (N=131072). Under the full suite's parallel load a test here
// reaches about 4.8 s, right at vitest's 5 s default, so the block gets a realistic budget. The checks are unchanged.
describe("following the invite link proves the mailbox", { timeout: 30_000 }, () => {
  const invite = { id: "inv1", tenantId: "t1", email: "new@acme.test", role: "agent", acceptedAt: null, expiresAt: new Date(Date.now() + 86_400_000), tenant: { id: "t1", name: "Acme" } };
  const accept = () => acceptPost(post("/api/auth/accept-invite", { token: "tok", name: "Neel", password: "correct horse battery staple" }));

  beforeEach(() => {
    db.invite.findUnique.mockResolvedValue(invite);
    db.invite.updateMany.mockResolvedValue({ count: 1 });
    db.membership.findUnique.mockResolvedValue(null);
    db.membership.create.mockResolvedValue({ role: "agent" });
    db.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "u9", email: data.email, name: data.name }));
  });

  it("a new account created from an emailed invite starts with its address confirmed", async () => {
    process.env.SMTP_USER = "mailer";
    expect((await accept()).status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("an existing unverified account is confirmed too", async () => {
    process.env.SMTP_USER = "mailer";
    const { hashPassword } = await import("@/lib/auth/password");
    db.user.findUnique.mockResolvedValue({ id: "u5", email: "new@acme.test", name: "Neel", passwordHash: await hashPassword("correct horse battery staple"), emailVerifiedAt: null });
    expect((await accept()).status).toBe(200);
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u5" }, data: { emailVerifiedAt: expect.any(Date) } });
  });

  it("is not trusted when the server hands the link to the inviter (no mail server), so the inviter cannot confirm someone else's address", async () => {
    expect((await accept()).status).toBe(200);
    expect(db.user.create.mock.calls[0][0].data).not.toHaveProperty("emailVerifiedAt");
  });
});
