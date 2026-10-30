import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { decrypt, encrypt, type EncryptedValue } from "@/lib/crypto/tokens";
import { enqueue, type JobHandler } from "@/lib/queue";

export type EmailMessage = { to: string; subject: string; text: string; html?: string };
/** What a sealed job holds: the recipient and subject stay readable for support, the body (which carries a one-time link) is encrypted. */
type SealedJob = { to: string; subject: string; sealed: EncryptedValue };

export const EMAIL_QUEUE = "email";
const DEFAULT_FROM = "Edwyz WA <noreply@edwyz.com>";

let transport: Transporter | null = null;

function getTransport(): Transporter {
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST || "mail.edwyz.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Test hook: forget the cached transport so env changes apply. */
export function resetEmailTransport() {
  transport = null;
}

/** Sends immediately. Throws on failure. With SMTP_USER unset nothing is sent and only the event is logged. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!process.env.SMTP_USER) {
    console.log("[email] not sent: SMTP is not configured");
    return;
  }
  await getTransport().sendMail({
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

const SEAL_AAD = "email-job";

/**
 * Encrypts the body of a message so a one-time link never sits in the Job table in the clear. Without ENCRYPTION_KEY it only falls back
 * to plain text outside production (local development); in production a missing key fails the queueing instead of leaking the link.
 */
function seal(message: EmailMessage): SealedJob | EmailMessage {
  try {
    const sealed = encrypt(JSON.stringify({ text: message.text, html: message.html }), undefined, `${SEAL_AAD}:${message.to}`);
    return { to: message.to, subject: message.subject, sealed };
  } catch (error) {
    if (process.env.NODE_ENV === "production") throw error;
    return message;
  }
}

/** Reads a queued payload back into a message. Returns null for anything that is not a message. */
export function openJobPayload(p: unknown): EmailMessage | null {
  const m = p as Partial<SealedJob & EmailMessage> | null;
  if (!m || typeof m.to !== "string" || typeof m.subject !== "string") return null;
  if (m.sealed) {
    const body = JSON.parse(decrypt(m.sealed, undefined, `${SEAL_AAD}:${m.to}`)) as { text?: unknown; html?: unknown };
    if (typeof body.text !== "string") return null;
    return { to: m.to, subject: m.subject, text: body.text, html: typeof body.html === "string" ? body.html : undefined };
  }
  return typeof m.text === "string" ? (m as EmailMessage) : null;
}

export type QueueOptions = {
  /** Encrypt the body in the queue. Use for any message that carries a one-time link (verify, reset, invite). */
  seal?: boolean;
  /** Throw when the message could not be queued, so the caller can keep a retry marker. By default a queue problem is only logged. */
  strict?: boolean;
};

/** Queues the message on the "email" queue with retries. Never throws for delivery problems unless `strict` is set. */
export async function queueEmail(message: EmailMessage, options: QueueOptions = {}): Promise<void> {
  try {
    await enqueue(EMAIL_QUEUE, options.seal ? seal(message) : message, { maxAttempts: 5 });
  } catch {
    console.error("[email] could not queue a message");
    if (options.strict) throw new Error("could not queue the email");
  }
}

/** Worker handler for the "email" queue. Errors carry only a short code so Job.lastError never holds addresses or bodies. */
export const emailJobHandler: JobHandler = async (payload) => {
  let message: EmailMessage | null;
  try {
    message = openJobPayload(payload);
  } catch {
    throw new Error("email payload could not be opened");
  }
  if (!message) return;
  try {
    await sendEmail(message);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    throw new Error(`email delivery failed${typeof code === "string" ? ` (${code.slice(0, 30)})` : ""}`);
  }
};
