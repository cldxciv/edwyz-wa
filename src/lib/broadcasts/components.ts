import { templateVariables } from "@/lib/templates/validate";

export type SendComponent = { type: "body"; parameters: { type: "text"; text: string }[] };

function bodyText(components: unknown): string {
  const list = Array.isArray(components) ? components : [];
  const body = list.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "BODY") as { text?: string } | undefined;
  return body?.text ?? "";
}

/** Reasons a template cannot be broadcast with the current feature set, or null when it can. */
export function unsupportedReason(components: unknown): string | null {
  const list = (Array.isArray(components) ? components : []) as Record<string, unknown>[];
  const header = list.find((c) => c.type === "HEADER");
  if (header && header.format !== "TEXT") return "Templates with media headers are not supported in broadcasts yet.";
  if (header && typeof header.text === "string" && templateVariables(header.text).length) {
    return "Templates with header variables are not supported in broadcasts yet.";
  }
  const buttons = list.find((c) => c.type === "BUTTONS");
  const hasUrlVar = ((buttons?.buttons as { url?: string }[] | undefined) ?? []).some((b) => b.url && templateVariables(b.url).length);
  return hasUrlVar ? "Templates with URL button variables are not supported in broadcasts yet." : null;
}

/**
 * Body variable {{n}} is filled from the contact attribute named "n"; {{1}} falls back to the contact name.
 * Returns null when a value is missing so the recipient is failed instead of sending a broken message.
 */
export function buildSendComponents(
  templateComponents: unknown,
  contact: { name: string | null; attributes: unknown },
): SendComponent[] | null {
  const vars = templateVariables(bodyText(templateComponents));
  if (vars.length === 0) return [];
  const attrs = (contact.attributes && typeof contact.attributes === "object" ? contact.attributes : {}) as Record<string, unknown>;
  const parameters: { type: "text"; text: string }[] = [];
  for (const n of vars) {
    const raw = attrs[String(n)] ?? (n === 1 ? contact.name : undefined);
    if (typeof raw !== "string" || !raw.trim()) return null;
    parameters.push({ type: "text", text: raw.trim() });
  }
  return [{ type: "body", parameters }];
}

/** Why a template cannot be broadcast at all, or null. Media headers, header placeholders and link placeholders are supported through the value mapping. */
export function broadcastSupportReason(components: unknown): string | null {
  const list = (Array.isArray(components) ? components : []) as Record<string, unknown>[];
  const header = list.find((c) => c.type === "HEADER");
  const format = typeof header?.format === "string" ? header.format.toUpperCase() : "TEXT";
  if (header && !["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(format)) return "This template has a header type that broadcasts cannot send yet (for example a location).";
  if (list.some((c) => c.type === "CAROUSEL" || c.type === "LIMITED_TIME_OFFER")) return "Carousel and limited-time-offer templates cannot be broadcast yet.";
  return null;
}
