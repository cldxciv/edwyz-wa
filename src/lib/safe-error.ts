/** Removes personal data (emails, long digit runs such as phone numbers or ids) from a message and shortens it. */
export function sanitizeMessage(message: string, max = 200): string {
  return message
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\d{7,}/g, "[number]")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/** A log-safe description of an unknown error: class name and a code, never the message (Prisma messages echo query arguments). */
export function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  const name = (error as { constructor?: { name?: string } }).constructor?.name ?? "Error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${name} ${String(code).slice(0, 30)}` : name;
}
