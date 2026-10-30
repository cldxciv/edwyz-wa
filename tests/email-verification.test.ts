import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "x".repeat(40);

const db = vi.hoisted(() => ({
  membership: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: vi.fn() }));
vi.mock("@/lib/integrations/apikeys", () => ({ authenticateApiKey: vi.fn() }));

const flows = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));
vi.mock("@/lib/email/flows", () => flows);

const limiter = vi.hoisted(() => ({ consumeShared: vi.fn() }));
vi.mock("@/lib/email/limits", () => ({ resendLimiter: limiter }));

import { POST as resendPost } from "@/app/api/auth/resend-verification/route";
import { getActor } from "@/lib/auth";
import { signAccessToken } from "@/lib/auth/tokens";
import { assertEmailVerifiedForWrite, emailVerificationRequired, UNVERIFIED_MESSAGE, unverifiedMayWrite } from "@/lib/auth/verification";
import { resendOutcomeText } from "@/components/account/verify-helpers";

const ORIGIN = "https://wa.edwyz.com";
const saved = { ...process.env };

function req(method: string, path: string, headers: Record<string, string> = {}) {
  const token = signAccessToken({ sub: "u1", tid: "t1", role: "admin" });
  return new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, ...headers } });
}
const member = (emailVerifiedAt: Date | null) => ({
  userId: "u1",
  tenantId: "t1",
  role: "admin",
  user: { disabledAt: null, emailVerifiedAt },
  tenant: { deletedAt: null },
});

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  delete process.env.EMAIL_VERIFICATION_REQUIRED;
  process.env.SMTP_USER = "smtp-user";
  db.membership.findUnique.mockReset();
  db.user.findUnique.mockReset();
  flows.sendVerificationEmail.mockReset();
  limiter.consumeShared.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
});

describe("the verification policy switch", () => {
  it("is on when mail can be delivered and off when it cannot, unless forced", () => {
    expect(emailVerificationRequired()).toBe(true);
    delete process.env.SMTP_USER;
    expect(emailVerificationRequired()).toBe(false);
    process.env.EMAIL_VERIFICATION_REQUIRED = "true";
    expect(emailVerificationRequired()).toBe(true);
    process.env.SMTP_USER = "x";
    process.env.EMAIL_VERIFICATION_REQUIRED = "off";
    expect(emailVerificationRequired()).toBe(false);
    process.env.EMAIL_VERIFICATION_REQUIRED = "";
    expect(emailVerificationRequired()).toBe(true);
  });
});

describe("which writes an unverified user may make", () => {
  it("allows account, billing and settings screens", () => {
    for (const p of ["/api/auth/logout", "/api/billing/subscribe", "/api/setup/checklist", "/api/workspace/profile", "/api/routing/config", "/api/teams", "/api/quick-replies", "/api/account/password"]) {
      expect(unverifiedMayWrite(p), p).toBe(true);
    }
    expect(unverifiedMayWrite("/api/inbox/conversations/c1/read")).toBe(true);
  });

  it("blocks sending, campaigns, imports, API keys and connecting Meta", () => {
    for (const p of [
      "/api/inbox/conversations/c1/messages",
      "/api/inbox/conversations/c1/send",
      "/api/broadcasts",
      "/api/broadcasts/b1/start",
      "/api/contacts/import",
      "/api/integrations/api-keys",
      "/api/meta-connect/start",
      "/api/onboarding/complete",
      "/api/onboarding/start",
      "/api/templates",
      "/api/chatbots",
      "/api/leads/l1/status",
    ]) {
      expect(unverifiedMayWrite(p), p).toBe(false);
    }
  });
});

describe("assertEmailVerifiedForWrite", () => {
  it("lets verified and unknown (not loaded) users through and blocks only an explicit null", () => {
    expect(() => assertEmailVerifiedForWrite(new Date(), "/api/broadcasts")).not.toThrow();
    expect(() => assertEmailVerifiedForWrite(undefined, "/api/broadcasts")).not.toThrow();
    expect(() => assertEmailVerifiedForWrite(null, "/api/broadcasts")).toThrowError(UNVERIFIED_MESSAGE);
    expect(() => assertEmailVerifiedForWrite(null, "/api/billing/subscribe")).not.toThrow();
  });

  it("does nothing when the gate is switched off", () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = "false";
    expect(() => assertEmailVerifiedForWrite(null, "/api/broadcasts")).not.toThrow();
  });

  it("the error is a plain-language 403", () => {
    try {
      assertEmailVerifiedForWrite(null, "/api/inbox/conversations/c1/messages");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({ status: 403 });
      expect(String((e as Error).message)).toMatch(/Confirm your email/);
    }
  });
});

describe("getActor with an unverified user", () => {
  it("keeps every read working", async () => {
    db.membership.findUnique.mockResolvedValue(member(null));
    await expect(getActor(req("GET", "/api/inbox/conversations"))).resolves.toMatchObject({ userId: "u1" });
    await expect(getActor(req("GET", "/api/export/contacts.csv"))).resolves.toBeTruthy();
  });

  it("refuses sending and connecting Meta with 403, but not settings or billing", async () => {
    db.membership.findUnique.mockResolvedValue(member(null));
    await expect(getActor(req("POST", "/api/inbox/conversations/c1/messages"))).rejects.toMatchObject({ status: 403 });
    await expect(getActor(req("POST", "/api/meta-connect/start"))).rejects.toMatchObject({ status: 403 });
    await expect(getActor(req("POST", "/api/onboarding/complete"))).rejects.toMatchObject({ status: 403 });
    await expect(getActor(req("POST", "/api/billing/subscribe"))).resolves.toBeTruthy();
    await expect(getActor(req("POST", "/api/quick-replies"))).resolves.toBeTruthy();
  });

  it("allows everything once the address is confirmed", async () => {
    db.membership.findUnique.mockResolvedValue(member(new Date()));
    await expect(getActor(req("POST", "/api/inbox/conversations/c1/messages"))).resolves.toBeTruthy();
  });
});

describe("resend verification", () => {
  it("sends a new link and is rate limited per user", async () => {
    db.membership.findUnique.mockResolvedValue(member(null));
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", emailVerifiedAt: null });
    limiter.consumeShared.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const ok = await resendPost(req("POST", "/api/auth/resend-verification"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, alreadyVerified: false });
    expect(flows.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(limiter.consumeShared).toHaveBeenCalledWith("u1");

    const limited = await resendPost(req("POST", "/api/auth/resend-verification"));
    expect(limited.status).toBe(429);
    expect(flows.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("says plainly that no mail can be sent while SMTP is not configured, instead of reporting success", async () => {
    delete process.env.SMTP_USER;
    process.env.EMAIL_VERIFICATION_REQUIRED = "true"; // the gate forced on without mail: the banner shows and must not lie
    db.membership.findUnique.mockResolvedValue(member(null));
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", emailVerifiedAt: null });
    limiter.consumeShared.mockResolvedValue(true);

    const res = await resendPost(req("POST", "/api/auth/resend-verification"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; ok?: boolean };
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/not set up on this server yet/);
    expect(body.error).toContain("hello@edwyz.com");
    expect(flows.sendVerificationEmail).not.toHaveBeenCalled();
    expect(limiter.consumeShared).not.toHaveBeenCalled();
    // The banner turns that into a plain sentence, not "Link sent".
    expect(resendOutcomeText("error", "a@b.co", body.error)).toMatch(/^We could not send the email\. Email is not set up on this server yet/);
  });

  it("does not send again to a verified user and does not spend the limit", async () => {
    db.membership.findUnique.mockResolvedValue(member(new Date()));
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", emailVerifiedAt: new Date() });
    const res = await resendPost(req("POST", "/api/auth/resend-verification"));
    expect(await res.json()).toEqual({ ok: true, alreadyVerified: true });
    expect(flows.sendVerificationEmail).not.toHaveBeenCalled();
    expect(limiter.consumeShared).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const res = await resendPost(req("POST", "/api/auth/resend-verification", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(flows.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe("banner copy", () => {
  it("says what happened in plain words", () => {
    expect(resendOutcomeText("sent", "a@b.co")).toContain("a@b.co");
    expect(resendOutcomeText("error", "a@b.co", "A confirmation email was sent recently.")).toContain("sent recently");
    expect(resendOutcomeText("error", "a@b.co")).toContain("Try again");
  });
});
