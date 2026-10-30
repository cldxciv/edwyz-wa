import { HttpError } from "@/lib/tenancy";

export type TestMessageMode = "text" | "template";
/** templateId is the workspace's Template row id; required in template mode. */
export type TestMessageInput = { phoneNumberRef: string; to: string; mode: TestMessageMode; text: string; templateId?: string };

export const DEFAULT_TEST_TEXT = "Test message from Edwyz WA.";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Digits only, 8 to 15 long (E.164 without the plus). Returns null when invalid. */
export function normalizeRecipient(value: string): string | null {
  const digits = value.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function maskRecipient(to: string): string {
  return `${"*".repeat(Math.max(to.length - 4, 0))}${to.slice(-4)}`;
}

export function parseTestMessageInput(body: Record<string, unknown>): TestMessageInput & { to: string } {
  const ref = body.phoneNumberRef;
  if (typeof ref !== "string" || !ID_PATTERN.test(ref)) throw new HttpError(400, "Choose a phone number.");
  const to = typeof body.to === "string" ? normalizeRecipient(body.to) : null;
  if (!to) throw new HttpError(400, "Enter the recipient number with country code, for example +919876543210.");
  const mode: TestMessageMode = body.mode === "template" ? "template" : "text";
  if (mode === "template") {
    const templateId = body.templateId;
    if (typeof templateId !== "string" || !ID_PATTERN.test(templateId)) throw new HttpError(400, "Choose a template.");
    return { phoneNumberRef: ref, to, mode, text: "", templateId };
  }
  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  if (rawText.length > 1000) throw new HttpError(400, "The message is too long (1000 characters maximum).");
  return { phoneNumberRef: ref, to, mode, text: rawText || DEFAULT_TEST_TEXT };
}
