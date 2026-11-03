import { scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  });
  const names = [
    "user", "tenant", "membership", "session", "auditLog", "emailToken", "job", "platformSetting", "subscription",
    "phoneNumber", "webhookEvent", "automationRun", "contact", "conversation", "message", "note", "broadcastRecipient", "apiKey", "ruleExecution",
  ];
  const prisma: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, model()]));
  // promote/forget.ts forgetContact (PRM-11) first looks for the workspace's customer-list audiences on Meta: none here.
  prisma.adAudience = { findMany: vi.fn(async () => []) };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  return prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>> & { $transaction: unknown };
});
const mail = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
const sync = vi.hoisted(() => ({ syncTemplates: vi.fn() }));
// Eddy's erasure hooks (EDDY-16) run inside the erasure transactions; their own behaviour is covered by
// tests/lifecycle-eddy-erasure.test.ts and tests/eddy-notices.test.ts, so here they are spies on the transaction client.
const eddy = vi.hoisted(() => ({
  eraseContactFromEddy: vi.fn(async () => ({ conversations: 0, messages: 0, actionRecords: 0, notices: 0 })),
  eddyForgetUserEverywhere: vi.fn(async () => 0),
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/eddy/erasure-sweep", () => ({ eraseContactFromEddy: eddy.eraseContactFromEddy }));
vi.mock("@/lib/eddy/forget-user", () => ({ eddyForgetUserEverywhere: eddy.eddyForgetUserEverywhere }));
vi.mock("@/lib/billing", () => ({ assertTenantCanWrite: async () => undefined, assertWithinLimit: async () => undefined, startTrial: async () => undefined }));
vi.mock("nodemailer", () => ({ default: { createTransport: mail.createTransport } }));
vi.mock("@/lib/templates/service", () => ({ syncTemplates: sync.syncTemplates }));
vi.mock("@/lib/platform-settings", () => ({ getSettings: async () => ({ graceDays: 3 }) }));

import { POST as forgotPost } from "@/app/api/auth/forgot-password/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as resendPost } from "@/app/api/auth/resend-verification/route";
import { POST as resetPost } from "@/app/api/auth/reset-password/route";
import { POST as verifyPost } from "@/app/api/auth/verify-email/route";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { resetLoginLimits } from "@/lib/auth/ratelimit";
import { hashToken, signAccessToken } from "@/lib/auth/tokens";
import { emailJobHandler, queueEmail, resetEmailTransport, sendEmail } from "@/lib/email";
import { resetEmailLimits } from "@/lib/email/limits";
import * as T from "@/lib/email/templates";
import { createEmailToken, consumeEmailToken } from "@/lib/email/tokens";
import { anonymiseUser, deleteContactData } from "@/lib/lifecycle/erasure";
import { runPaymentFailedNotices, runQualityAlerts, runTrialReminders, trialKind } from "@/lib/lifecycle/notices";
import { RETENTION_DAYS, runRetention } from "@/lib/lifecycle/retention";
import { runTemplateSync } from "@/lib/lifecycle/sync";
import { worker } from "@/lib/lifecycle/worker";

vi.setConfig({ testTimeout: 60_000 });
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.SITE_URL = "https://wa.edwyz.com";

const DAY = 86_400_000;
const ORIGIN = "https://wa.edwyz.com";

function req(body: unknown, opts: { cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": opts.ip ?? "2.2.2.2" };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request("https://wa.edwyz.com/api/x", { method: "POST", headers, body: JSON.stringify(body) });
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const queuedEmails = () => db.job.create.mock.calls.map((c) => c[0].data.payload as { to: string; subject: string; text: string });

let claimed: Set<string>;

beforeEach(() => {
  for (const m of Object.values(db)) if (m && typeof m === "object") for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset();
  eddy.eraseContactFromEddy.mockClear();
  eddy.eddyForgetUserEverywhere.mockClear();
  mail.sendMail.mockReset();
  mail.createTransport.mockReset().mockReturnValue({ sendMail: mail.sendMail });
  sync.syncTemplates.mockReset();
  resetEmailTransport();
  resetEmailLimits();
  resetLoginLimits();
  delete process.env.SMTP_USER;
  claimed = new Set();
  db.auditLog.create.mockResolvedValue({});
  db.job.create.mockResolvedValue({});
  db.platformSetting.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
    if (claimed.has(data.key)) throw new Error("unique");
    claimed.add(data.key);
    return {};
  });
});

describe("email tokens", () => {
  it("stores only the hash and sets the right expiry", async () => {
    const reset = await createEmailToken("u1", "reset");
    const verify = await createEmailToken("u1", "verify");
    const [a, b] = db.emailToken.create.mock.calls.map((c) => c[0].data);
    expect(a.tokenHash).toBe(hashToken(reset));
    expect(JSON.stringify(a)).not.toContain(reset);
    expect(a.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(b.tokenHash).toBe(hashToken(verify));
    expect(b.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
  });

  it("is single use, kind specific and expires", async () => {
    const row = { id: "e1", userId: "u1", kind: "reset", usedAt: null, expiresAt: new Date(Date.now() + 1000) };
    db.emailToken.findUnique.mockResolvedValue(row);
    db.emailToken.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await consumeEmailToken("tok", "reset")).toBe("u1");
    expect(await consumeEmailToken("tok", "reset")).toBeNull();
    expect(await consumeEmailToken("tok", "verify")).toBeNull();
    db.emailToken.findUnique.mockResolvedValue({ ...row, expiresAt: new Date(Date.now() - 1) });
    expect(await consumeEmailToken("tok", "reset")).toBeNull();
    db.emailToken.findUnique.mockResolvedValue({ ...row, usedAt: new Date() });
    expect(await consumeEmailToken("tok", "reset")).toBeNull();
  });
});

describe("forgot password", () => {
  // The route only accepts a request when mail can be delivered; these tests exercise the flow with SMTP configured.
  beforeEach(() => {
    process.env.SMTP_USER = "u";
  });

  it("refuses plainly, and creates no token or mail, while SMTP is not configured", async () => {
    delete process.env.SMTP_USER;
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "a@b.co", name: "A", disabledAt: null });
    const res = await forgotPost(req({ email: "a@b.co" }));
    await tick();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not available yet/);
    expect(body.error).toContain("hello@edwyz.com");
    expect(body.error).not.toMatch(/sent|check your email/i);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.emailToken.create).not.toHaveBeenCalled();
    expect(queuedEmails()).toHaveLength(0);
  });

  it("answers identically and does the same lookup for known and unknown emails", async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", email: "a@b.co", name: "A", disabledAt: null });
    const known = await forgotPost(req({ email: "a@b.co" }));
    await tick();
    const emailsKnown = queuedEmails().length;
    db.user.findUnique.mockResolvedValueOnce(null);
    const unknown = await forgotPost(req({ email: "nobody@b.co" }, { ip: "3.3.3.3" }));
    await tick();
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(db.user.findUnique).toHaveBeenCalledTimes(2);
    expect(emailsKnown).toBe(1);
    expect(queuedEmails()).toHaveLength(1);
    expect(queuedEmails()[0].text).toContain("/reset-password?token=");
  });

  it("rate limits per email and per IP", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await forgotPost(req({ email: "x@b.co" }, { ip: `5.5.5.${i}` }))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    resetEmailLimits();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await forgotPost(req({ email: `u${i}@b.co` }, { ip: "6.6.6.6" }))).status;
    expect(last).toBe(429);
  });
});

describe("reset password", () => {
  const valid = () => {
    db.emailToken.findUnique.mockResolvedValue({ id: "e1", userId: "u1", kind: "reset", usedAt: null, expiresAt: new Date(Date.now() + 1e6) });
    db.emailToken.updateMany.mockResolvedValue({ count: 1 });
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", disabledAt: null, emailVerifiedAt: null });
    db.user.update.mockResolvedValue({});
    db.session.updateMany.mockResolvedValue({ count: 2 });
  };

  it("sets the password, revokes all sessions, audits and queues a notice", async () => {
    valid();
    const res = await resetPost(req({ token: "tok", password: "a-brand-new-password" }));
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data.passwordHash.startsWith("scrypt$131072$")).toBe(true);
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("auth.password_reset");
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain("a-brand-new-password");
    expect(queuedEmails()[0].subject).toMatch(/password was changed/);
  });

  it("does not consume the token for a weak password, and rejects bad tokens", async () => {
    valid();
    expect((await resetPost(req({ token: "tok", password: "short" }))).status).toBe(400);
    expect(db.emailToken.findUnique).not.toHaveBeenCalled();
    db.emailToken.findUnique.mockResolvedValue(null);
    expect((await resetPost(req({ token: "bad", password: "a-brand-new-password" }))).status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("verify email and resend", () => {
  it("marks the email verified with a valid token", async () => {
    db.emailToken.findUnique.mockResolvedValue({ id: "e1", userId: "u1", kind: "verify", usedAt: null, expiresAt: new Date(Date.now() + 1e6) });
    db.emailToken.updateMany.mockResolvedValue({ count: 1 });
    db.user.updateMany.mockResolvedValue({ count: 1 });
    expect((await verifyPost(req({ token: "tok" }))).status).toBe(200);
    expect(db.user.updateMany.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects an unknown token", async () => {
    db.emailToken.findUnique.mockResolvedValue(null);
    expect((await verifyPost(req({ token: "nope" }))).status).toBe(400);
  });

  it("rate limits resend to 3 per hour", async () => {
    process.env.SMTP_USER = "u"; // resend only runs when mail can be delivered (tests/email-verification.test.ts covers the refusal)
    const cookie = `wa_access=${signAccessToken({ sub: "u1", tid: "t1", role: "owner" })}`;
    db.membership.findUnique.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", emailVerifiedAt: null });
    const s = [];
    for (let i = 0; i < 4; i++) s.push((await resendPost(req({}, { cookie }))).status);
    expect(s).toEqual([200, 200, 200, 429]);
  });
});

// Each test runs several scrypt hashes (the new cost is N=131072). Under the full suite's parallel load they reach about 4.9 s,
// right at vitest's 5 s default, so the block gets a realistic budget, as tests/auth.test.ts does. The checks are unchanged.
describe("password hashing upgrade", { timeout: 30_000 }, () => {
  const oldHash = () => {
    const salt = Buffer.from("0123456789abcdef");
    const key = scryptSync("old-password-123", salt, 64, { N: 16384, r: 8, p: 1 });
    return ["scrypt", 16384, 8, 1, salt.toString("base64"), key.toString("base64")].join("$");
  };

  it("verifies old hashes, flags them, and issues stronger new ones", async () => {
    expect(await verifyPassword("old-password-123", oldHash())).toBe(true);
    expect(needsRehash(oldHash())).toBe(true);
    const fresh = await hashPassword("new-password-123");
    expect(fresh.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(needsRehash(fresh)).toBe(false);
    expect(await verifyPassword("new-password-123", fresh)).toBe(true);
  });

  it("rehashes on successful login", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", passwordHash: oldHash() });
    db.membership.findFirst.mockResolvedValue({ tenantId: "t1", role: "owner" });
    db.session.create.mockResolvedValue({});
    db.user.update.mockResolvedValue({});
    const res = await loginPost(req({ email: "a@b.co", password: "old-password-123" }));
    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data.passwordHash.startsWith("scrypt$131072$")).toBe(true);
  });

  it("requires a 32 character session secret", () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "too-short-secret";
    expect(() => signAccessToken({ sub: "u", tid: "t", role: "agent" })).toThrow(/32/);
    process.env.SESSION_SECRET = saved;
  });
});

describe("email sending", () => {
  const msg = { to: "person@example.com", subject: "Hi", text: "Body text" };

  it("sends nothing and logs no address when SMTP is unset", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await sendEmail(msg);
    expect(mail.createTransport).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("person@example.com");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Body text");
    log.mockRestore();
  });

  it("sends through SMTP when configured, with defaults", async () => {
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    mail.sendMail.mockResolvedValue({});
    await sendEmail(msg);
    expect(mail.createTransport.mock.calls[0][0]).toMatchObject({ host: "mail.edwyz.com", port: 587, requireTLS: true });
    expect(mail.sendMail.mock.calls[0][0]).toMatchObject({ to: msg.to, from: "Edwyz WA <noreply@edwyz.com>" });
  });

  it("queues on the email queue and never throws", async () => {
    await queueEmail(msg);
    expect(db.job.create.mock.calls[0][0].data).toMatchObject({ queue: "email" });
    db.job.create.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(queueEmail(msg)).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("job errors never contain the recipient or body", async () => {
    process.env.SMTP_USER = "u";
    mail.sendMail.mockRejectedValue(Object.assign(new Error("550 rejected person@example.com Body text"), { code: "EENVELOPE" }));
    const err = await emailJobHandler(msg, { attempt: 5, maxAttempts: 5, isLastAttempt: true }).catch((e: Error) => e);
    expect((err as Error).message).toBe("email delivery failed (EENVELOPE)");
  });

  it("registers the email queue and periodic tasks with the worker", () => {
    expect(Object.keys(worker.queues)).toEqual(["email"]);
    expect(worker.periodic.map((p) => p.name)).toContain("lifecycle.retention");
  });
});

describe("templates", () => {
  const evil = `<script>alert("x")</script>&'`;
  it("escape user supplied values in HTML", () => {
    const all = [
      T.verifyEmailTemplate({ name: evil, link: "https://wa.edwyz.com/x" }),
      T.passwordResetTemplate({ name: evil, link: "https://wa.edwyz.com/x" }),
      T.inviteTemplate({ workspaceName: evil, inviterName: evil, role: evil, link: "https://wa.edwyz.com/x" }),
      T.trialEndingTemplate({ workspaceName: evil, daysLeft: 3 }),
      T.trialEndingTemplate({ workspaceName: evil, daysLeft: 1 }),
      T.trialEndedTemplate({ workspaceName: evil }),
      T.paymentFailedTemplate({ workspaceName: evil, graceDaysLeft: 2 }),
      T.paymentReceivedTemplate({ workspaceName: evil, amountPaise: 123456, invoiceUrl: "javascript:alert(1)" }),
      T.workspaceSuspendedTemplate({ workspaceName: evil, reason: evil }),
      T.numberQualityDroppedTemplate({ workspaceName: evil, displayPhone: evil, from: "GREEN", to: "RED" }),
      T.passwordChangedTemplate({ name: evil }),
    ];
    for (const t of all) {
      expect(t.html).not.toContain("<script>");
      expect(t.text).toContain("Edwyz Technologies Private Limited");
      expect(t.text).toContain("hello@edwyz.com");
      expect(t.html).not.toContain("javascript:");
    }
    expect(all[7].text).toContain("INR 1234.56");
  });
});

describe("trial reminders", () => {
  const now = Date.now();
  const owners = () => db.membership.findMany.mockResolvedValue([{ user: { email: "o@b.co", name: "O" } }]);

  it("classifies the trial window", () => {
    expect(trialKind(new Date(now + 2.5 * DAY), now)).toBe("trial3");
    expect(trialKind(new Date(now + 0.5 * DAY), now)).toBe("trial1");
    expect(trialKind(new Date(now - DAY), now)).toBe("trialEnded");
    expect(trialKind(new Date(now - 30 * DAY), now)).toBeNull();
    expect(trialKind(new Date(now + 10 * DAY), now)).toBeNull();
  });

  it("sends each reminder once and is bounded", async () => {
    owners();
    db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme", trialEndsAt: new Date(now + 2 * DAY) }]);
    expect(await runTrialReminders(now)).toBe(1);
    expect(await runTrialReminders(now)).toBe(0);
    expect(queuedEmails()).toHaveLength(1);
    expect(queuedEmails()[0].subject).toMatch(/3 days/);
    expect(db.tenant.findMany.mock.calls[0][0].take).toBe(100);
    db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme", trialEndsAt: new Date(now + 0.5 * DAY) }]);
    expect(await runTrialReminders(now)).toBe(1);
  });
});

describe("payment failed notices", () => {
  it("notifies once per failure with the grace days left", async () => {
    const since = new Date(Date.now() - DAY);
    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: since, tenant: { name: "Acme" } }]);
    db.membership.findMany.mockResolvedValue([{ user: { email: "o@b.co", name: "O" } }]);
    expect(await runPaymentFailedNotices()).toBe(1);
    expect(await runPaymentFailedNotices()).toBe(0);
    expect(queuedEmails()[0].text).toContain("2 more days");
    db.subscription.findMany.mockResolvedValue([{ tenantId: "t1", pastDueSince: new Date(since.getTime() + 1000), tenant: { name: "Acme" } }]);
    expect(await runPaymentFailedNotices()).toBe(1);
  });
});

describe("quality alerts", () => {
  const num = (rating: string) => ({ id: "p1", tenantId: "t1", displayPhone: "+91 98765", qualityRating: rating });
  let stored: Record<string, unknown>;
  beforeEach(() => {
    stored = {};
    db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (stored[where.key] ? { value: stored[where.key] } : null));
    db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
      stored[where.key] = create.value;
    });
    db.tenant.findMany.mockResolvedValue([{ id: "t1", name: "Acme" }]);
    db.membership.findMany.mockResolvedValue([{ user: { email: "o@b.co", name: "O" } }]);
  });

  it("alerts only when the rating gets worse", async () => {
    db.phoneNumber.findMany.mockResolvedValue([num("GREEN")]);
    expect(await runQualityAlerts()).toBe(0);
    db.phoneNumber.findMany.mockResolvedValue([num("YELLOW")]);
    expect(await runQualityAlerts()).toBe(1);
    expect(await runQualityAlerts()).toBe(0);
    db.phoneNumber.findMany.mockResolvedValue([num("GREEN")]);
    expect(await runQualityAlerts()).toBe(0);
    expect(queuedEmails()).toHaveLength(1);
  });
});

describe("retention", () => {
  it("purges only what is past its retention period", async () => {
    const now = Date.now();
    db.webhookEvent.findMany.mockResolvedValueOnce([{ id: "w1" }]).mockResolvedValue([{ id: "w2" }]);
    db.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    db.webhookEvent.deleteMany.mockResolvedValue({ count: 1 });
    for (const m of ["job", "session", "emailToken", "automationRun"]) {
      db[m].findMany.mockResolvedValue([{ id: "x" }]);
      db[m].deleteMany.mockResolvedValue({ count: 1 });
    }
    const out = await runRetention(now);
    expect(out.webhookPayloadsCleared).toBe(1);

    const stale = db.webhookEvent.findMany.mock.calls[0][0].where;
    expect(stale.processedAt).toBeNull();
    expect(stale.receivedAt.lt.getTime()).toBe(now - RETENTION_DAYS.webhookEvents * DAY);
    expect(db.webhookEvent.updateMany.mock.calls[0][0].data).toMatchObject({ payload: {}, processedAt: expect.any(Date) });
    expect(db.webhookEvent.findMany.mock.calls[1][0].where.processedAt.not).toBeNull();

    expect(db.job.findMany.mock.calls[0][0].where).toMatchObject({ status: "done" });
    expect(db.job.findMany.mock.calls[0][0].where.createdAt.lt.getTime()).toBe(now - 7 * DAY);
    expect(db.automationRun.findMany.mock.calls[0][0].where.createdAt.lt.getTime()).toBe(now - 90 * DAY);
    expect(db.session.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
    expect(db.emailToken.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
    expect(db.job.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["x"] } } });
    expect(db.job.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(5000);
  });

  it("does nothing when there is nothing to purge", async () => {
    for (const m of ["webhookEvent", "job", "session", "emailToken", "automationRun"]) db[m].findMany.mockResolvedValue([]);
    await runRetention();
    expect(db.job.deleteMany).not.toHaveBeenCalled();
    expect(db.webhookEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe("template sync", () => {
  it("handles at most 20 tenants, survives failures and advances the cursor", async () => {
    const tenants = Array.from({ length: 20 }, (_, i) => ({ id: `t${String(i).padStart(2, "0")}` }));
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.tenant.findMany.mockResolvedValue(tenants);
    sync.syncTemplates.mockImplementation(async (a: { tenantId: string }) => {
      if (a.tenantId === "t03") throw new Error("meta down");
    });
    const out = await runTemplateSync();
    expect(db.tenant.findMany.mock.calls[0][0].take).toBe(20);
    expect(out).toEqual({ synced: 19, failed: 1 });
    expect(db.platformSetting.upsert.mock.calls[0][0].create.value).toEqual({ after: "t19" });

    db.platformSetting.findUnique.mockResolvedValue({ value: { after: "t19" } });
    db.tenant.findMany.mockResolvedValue([{ id: "t20" }]);
    await runTemplateSync();
    expect(db.tenant.findMany.mock.calls[1][0].where.id).toEqual({ gt: "t19" });
    expect(db.platformSetting.upsert.mock.calls[1][0].create.value).toEqual({ after: null });
  });
});

describe("erasure", () => {
  it("anonymises a user and keeps sole-owner memberships", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1" });
    db.membership.findMany.mockResolvedValue([
      { id: "m1", tenantId: "tA", role: "owner" },
      { id: "m2", tenantId: "tB", role: "owner" },
      { id: "m3", tenantId: "tC", role: "agent" },
    ]);
    db.membership.count.mockImplementation(async ({ where }: { where: { tenantId: string } }) => (where.tenantId === "tA" ? 0 : 1));
    db.apiKey.updateMany.mockResolvedValue({ count: 0 });
    const out = await anonymiseUser("u1");
    expect(out).toEqual({ found: true, retainedWorkspaceIds: ["tA"] });
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.email).toBe("deleted-u1@deleted.invalid");
    expect(data.name).toBe("Deleted user");
    expect(data.disabledAt).toBeInstanceOf(Date);
    expect(db.session.updateMany).toHaveBeenCalled();
    expect(db.membership.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["m2", "m3"] }, userId: "u1" } });
    expect(db.apiKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { createdByUserId: "u1", revokedAt: null } }));
    // Eddy forgets the user in every workspace, on the same transaction client (the fake hands `db` to the callback).
    expect(eddy.eddyForgetUserEverywhere).toHaveBeenCalledTimes(1);
    expect(eddy.eddyForgetUserEverywhere).toHaveBeenCalledWith("u1", { db });
  });

  it("reports an unknown user", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expect(await anonymiseUser("nope")).toEqual({ found: false, retainedWorkspaceIds: [] });
    expect(eddy.eddyForgetUserEverywhere).not.toHaveBeenCalled();
  });

  it("deletes one contact and its data inside the tenant only", async () => {
    db.contact.findUnique.mockResolvedValue({ id: "c1" });
    db.conversation.findMany.mockResolvedValue([{ id: "v1" }]);
    db.message.findMany.mockResolvedValue([]);
    expect(await deleteContactData("t1", "+911")).toEqual({ deleted: true });
    expect(db.contact.findUnique).toHaveBeenCalledWith({ where: { tenantId_phone: { tenantId: "t1", phone: "+911" } }, select: { id: true } });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", conversationId: { in: ["v1"] } } });
    expect(db.note.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", conversationId: { in: ["v1"] } } });
    expect(db.broadcastRecipient.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "c1" } });
    expect(db.contact.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
    // What Eddy holds about the contact goes in the same transaction, with the contact's chats for the notices about them.
    expect(eddy.eraseContactFromEddy).toHaveBeenCalledWith("t1", "c1", { db, conversationIds: ["v1"] });
    eddy.eraseContactFromEddy.mockClear();
    db.contact.findUnique.mockResolvedValue(null);
    expect(await deleteContactData("t1", "+912")).toEqual({ deleted: false });
    expect(eddy.eraseContactFromEddy).not.toHaveBeenCalled();
  });
});
