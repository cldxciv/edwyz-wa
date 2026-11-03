import { beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));

import { resetEmailTransport, sendEmail } from "@/lib/email";

const message = { to: "asha@acme.test", subject: "Hello", text: "Hi" };
const options = () => smtp.createTransport.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  resetEmailTransport();
  smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
  smtp.sendMail.mockResolvedValue({});
  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_TLS_SERVERNAME"]) delete process.env[k];
});

describe("SMTP transport", () => {
  it("logs in when a password is set", async () => {
    Object.assign(process.env, { SMTP_HOST: "mail.edwyz.com", SMTP_USER: "mailer@edwyz.com", SMTP_PASS: "pw" });
    await sendEmail(message);
    expect(options()).toMatchObject({ host: "mail.edwyz.com", port: 587, requireTLS: true, auth: { user: "mailer@edwyz.com", pass: "pw" } });
    expect(options().tls).toBeUndefined();
  });

  it("sends through a local relay without a login and checks the certificate against the real name", async () => {
    Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "25", SMTP_USER: "noreply@edwyz.com", SMTP_TLS_SERVERNAME: "mail.edwyz.com" });
    await sendEmail(message);
    expect(options()).toMatchObject({ host: "127.0.0.1", port: 25, requireTLS: true, tls: { servername: "mail.edwyz.com" } });
    expect(options().auth).toBeUndefined();
    expect(smtp.sendMail).toHaveBeenCalledOnce();
  });

  it("uses implicit TLS on port 465 and STARTTLS on every other port", async () => {
    Object.assign(process.env, { SMTP_HOST: "smtp.example.net", SMTP_PORT: "465", SMTP_USER: "mailer@edwyz.com", SMTP_PASS: "pw" });
    await sendEmail(message);
    expect(options()).toMatchObject({ host: "smtp.example.net", port: 465, secure: true, requireTLS: false, auth: { user: "mailer@edwyz.com", pass: "pw" } });
    for (const port of ["587", "25", "2525", ""]) {
      vi.clearAllMocks();
      resetEmailTransport();
      process.env.SMTP_PORT = port;
      await sendEmail(message);
      expect(options(), port).toMatchObject({ port: Number(port) || 587, secure: false, requireTLS: true });
    }
  });

  it("sends nothing while SMTP_USER is unset", async () => {
    await sendEmail(message);
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });
});
