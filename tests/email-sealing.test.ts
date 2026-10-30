import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SITE_URL = "https://wa.edwyz.com";

const db = vi.hoisted(() => ({
  job: { create: vi.fn() },
  user: { findUnique: vi.fn() },
  emailToken: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
}));
const smtp = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: smtp.sendMail }) } }));

import { emailJobHandler, openJobPayload, queueEmail, resetEmailTransport } from "@/lib/email";
import { processPasswordResetRequest, sendVerificationEmail } from "@/lib/email/flows";

const link = "https://wa.edwyz.com/reset-password?token=SECRETTOKEN123456789012345";
const message = { to: "asha@acme.test", subject: "Reset your password", text: `Open ${link}`, html: `<a href="${link}">reset</a>` };
const queued = () => db.job.create.mock.calls[0][0].data as { queue: string; payload: Record<string, unknown> };
const ctx = { attempt: 1, maxAttempts: 5, isLastAttempt: false };

beforeEach(() => {
  vi.resetAllMocks();
  resetEmailTransport();
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SMTP_USER = "mailer";
  db.job.create.mockResolvedValue({ id: "j1" });
  db.emailToken.updateMany.mockResolvedValue({ count: 0 });
  db.emailToken.create.mockResolvedValue({});
  smtp.sendMail.mockResolvedValue({});
});

describe("one-time links never sit in the job table in the clear", () => {
  it("a sealed message keeps the recipient and subject readable and the body encrypted", async () => {
    await queueEmail(message, { seal: true });
    const { payload } = queued();
    expect(payload.to).toBe("asha@acme.test");
    expect(payload.subject).toBe("Reset your password");
    expect(JSON.stringify(payload)).not.toContain("SECRETTOKEN");
    expect(payload.text).toBeUndefined();
    expect(payload.html).toBeUndefined();
    expect(payload.sealed).toMatchObject({ keyVersion: 2 });
  });

  it("the worker opens a sealed job and sends the original text", async () => {
    await queueEmail(message, { seal: true });
    await emailJobHandler(queued().payload, ctx);
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "asha@acme.test", text: message.text, html: message.html }));
  });

  it("a sealed job cannot be opened with another key, and the failure carries no secret", async () => {
    await queueEmail(message, { seal: true });
    const payload = queued().payload;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await expect(emailJobHandler(payload, ctx)).rejects.toThrow("email payload could not be opened");
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("a sealed body is bound to its recipient: changing the address on the job makes it unreadable", async () => {
    await queueEmail(message, { seal: true });
    const edited = { ...queued().payload, to: "attacker@evil.test" };
    expect(() => openJobPayload(edited)).toThrow();
    await expect(emailJobHandler(edited, ctx)).rejects.toThrow("email payload could not be opened");
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("ordinary mail is left as it was, and old unsealed jobs still send", async () => {
    await queueEmail({ to: "a@b.test", subject: "Hello there", text: "plain" });
    expect(queued().payload).toEqual({ to: "a@b.test", subject: "Hello there", text: "plain" });
    await emailJobHandler(queued().payload, ctx);
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: "plain" }));
  });

  it("without an encryption key, development still works and production refuses to queue the link", async () => {
    delete process.env.ENCRYPTION_KEY;
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    try {
      env.NODE_ENV = "development";
      await queueEmail(message, { seal: true });
      expect(queued().payload.text).toBe(message.text);
      db.job.create.mockClear();
      env.NODE_ENV = "production";
      await queueEmail(message, { seal: true });
      expect(db.job.create).not.toHaveBeenCalled();
      await expect(queueEmail(message, { seal: true, strict: true })).rejects.toThrow();
    } finally {
      env.NODE_ENV = before;
    }
  });

  it("strict mode throws when the queue write fails; the default only logs", async () => {
    db.job.create.mockRejectedValue(new Error("db down"));
    await expect(queueEmail(message)).resolves.toBeUndefined();
    await expect(queueEmail(message, { strict: true })).rejects.toThrow("could not queue the email");
  });
});

describe("the verify and reset flows seal their links", () => {
  it("the confirmation mail's job payload holds no token, only its encrypted body", async () => {
    await sendVerificationEmail({ id: "u1", email: "asha@acme.test", name: "Asha" });
    const { payload } = queued();
    const stored = db.emailToken.create.mock.calls[0][0].data.tokenHash as string;
    expect(JSON.stringify(payload)).not.toMatch(/token=/);
    expect(JSON.stringify(payload)).not.toContain(stored);
    const opened = openJobPayload(payload);
    expect(opened?.text).toMatch(/verify-email\?token=[A-Za-z0-9_-]{20,}/);
  });

  it("the password reset mail's job payload holds no token either", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", email: "asha@acme.test", name: "Asha", disabledAt: null });
    await processPasswordResetRequest("asha@acme.test");
    const { payload } = queued();
    expect(JSON.stringify(payload)).not.toMatch(/token=/);
    expect(openJobPayload(payload)?.text).toMatch(/reset-password\?token=/);
  });
});
