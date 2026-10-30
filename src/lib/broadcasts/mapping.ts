import { HttpError } from "@/lib/tenancy";

/*
 * Per-recipient template values. Each fillable spot in a template (a body {{n}}, a header placeholder, a header
 * image/video/document, a button link placeholder) is a "slot" with a key: "1", "2" ... for the body, "header",
 * and "button:<index>" for URL buttons. Broadcast.variableMap says where each slot's value comes from.
 */

export type Slot =
  | { key: string; kind: "body"; label: string }
  | { key: "header"; kind: "header_text"; label: string }
  | { key: "header"; kind: "header_media"; label: string; mediaType: "image" | "video" | "document" }
  | { key: string; kind: "button_url"; label: string; buttonIndex: number };

export type SourceKind = "field" | "attribute" | "static";
export type VariableSource = { source: SourceKind; key?: string; value?: string; fallback?: string };
export type VariableMap = Record<string, VariableSource>;
export type MissingValuePolicy = "skip" | "fallback" | "fail";
export const POLICIES: MissingValuePolicy[] = ["skip", "fallback", "fail"];

export const CONTACT_FIELDS = ["name", "first_name", "phone"] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export const FIELD_LABELS: Record<ContactField, string> = { name: "Full name", first_name: "First name", phone: "Phone number" };

export const MAX_TEXT = 1024;
export const MAX_URL = 2000;
const ATTR_KEY = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,59}$/;

type Component = Record<string, unknown>;
const list = (components: unknown): Component[] => (Array.isArray(components) ? (components as Component[]).filter((c) => c && typeof c === "object") : []);
const isVar = (text: unknown) => typeof text === "string" && /\{\{\s*\d+\s*\}\}/.test(text);

function bodyNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** Every spot in the template that needs a value for each recipient. */
export function templateSlots(components: unknown): Slot[] {
  const all = list(components);
  const slots: Slot[] = [];
  const header = all.find((c) => c.type === "HEADER");
  if (header) {
    const format = typeof header.format === "string" ? header.format.toUpperCase() : "TEXT";
    if (format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
      slots.push({ key: "header", kind: "header_media", mediaType: format.toLowerCase() as "image" | "video" | "document", label: `Header ${format.toLowerCase()} link` });
    } else if (isVar(header.text)) {
      slots.push({ key: "header", kind: "header_text", label: "Header placeholder {{1}}" });
    }
  }
  const body = all.find((c) => c.type === "BODY");
  if (body && typeof body.text === "string") for (const n of bodyNumbers(body.text)) slots.push({ key: String(n), kind: "body", label: `Message placeholder {{${n}}}` });
  const buttons = (all.find((c) => c.type === "BUTTONS")?.buttons as { type?: unknown; url?: unknown; text?: unknown }[] | undefined) ?? [];
  buttons.forEach((b, i) => {
    if (b && b.type !== undefined && b.type !== "URL") return;
    if (isVar(b?.url)) slots.push({ key: `button:${i}`, kind: "button_url", buttonIndex: i, label: `Link placeholder for the "${typeof b.text === "string" ? b.text : "button"}" button` });
  });
  return slots;
}

/** True when sending needs more than the old body-only filling (so the mapping UI and validation apply). */
export const needsMapping = (components: unknown) => templateSlots(components).some((s) => s.kind !== "body");

/* ---------- validation of a stored/received map ---------- */

const fail = (message: string): never => {
  throw new HttpError(400, message);
};

export function parsePolicy(raw: unknown): MissingValuePolicy {
  if (raw === undefined || raw === null) return "skip";
  if (typeof raw !== "string" || !POLICIES.includes(raw as MissingValuePolicy)) return fail("Choose what to do when a value is missing: skip the contact, use a fallback, or stop the broadcast.");
  return raw as MissingValuePolicy;
}

export const isHttpsUrl = (value: string): boolean => {
  if (value.length > MAX_URL || /\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
};

function parseSource(slot: Slot, raw: unknown): VariableSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(`${slot.label}: choose where the value comes from.`);
  const { source, key, value, fallback } = raw as Record<string, unknown>;
  if (source !== "field" && source !== "attribute" && source !== "static") return fail(`${slot.label}: choose where the value comes from.`);
  const max = slot.kind === "body" || slot.kind === "header_text" ? MAX_TEXT : MAX_URL;
  const out: VariableSource = { source };
  if (source === "field") {
    if (typeof key !== "string" || !CONTACT_FIELDS.includes(key as ContactField)) return fail(`${slot.label}: pick a contact detail.`);
    if (slot.kind === "header_media") return fail(`${slot.label}: use a contact attribute that holds a link, or a fixed link.`);
    out.key = key;
  } else if (source === "attribute") {
    if (typeof key !== "string" || !ATTR_KEY.test(key)) return fail(`${slot.label}: pick a contact attribute.`);
    out.key = key;
  } else {
    if (typeof value !== "string" || !value.trim()) return fail(`${slot.label}: enter the fixed value.`);
    if (value.length > max) return fail(`${slot.label}: the value is too long.`);
    if (slot.kind === "header_media" && !isHttpsUrl(value.trim())) return fail(`${slot.label}: a fixed link must start with https:// and be a public address.`);
    out.value = value.trim();
  }
  if (fallback !== undefined && fallback !== null && fallback !== "") {
    if (typeof fallback !== "string" || fallback.length > max) return fail(`${slot.label}: the fallback is not valid.`);
    if (slot.kind === "header_media" && !isHttpsUrl(fallback.trim())) return fail(`${slot.label}: a fallback link must start with https://.`);
    out.fallback = fallback.trim();
  }
  return out;
}

/**
 * Checks a variable map against the template. Returns null when nothing is mapped (old behaviour: body {{n}} from the
 * attribute named n, {{1}} falling back to the name). Header and button slots must always be mapped; with the "fallback"
 * policy every slot must be mapped and every non-fixed value needs a fallback.
 */
export function parseVariableMap(raw: unknown, components: unknown, policy: MissingValuePolicy): VariableMap | null {
  const slots = templateSlots(components);
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return fail("The value mapping is not valid.");
  const input = (raw ?? {}) as Record<string, unknown>;
  const known = new Set(slots.map((s) => s.key));
  for (const key of Object.keys(input)) if (!known.has(key)) return fail("The mapping mentions a placeholder this template does not have.");
  const map: VariableMap = {};
  for (const slot of slots) {
    const entry = input[slot.key];
    if (entry === undefined || entry === null) {
      if (slot.kind !== "body") return fail(`${slot.label}: choose where the value comes from.`);
      if (policy === "fallback") return fail(`${slot.label}: choose a value and a fallback.`);
      continue;
    }
    map[slot.key] = parseSource(slot, entry);
    if (policy === "fallback" && map[slot.key].source !== "static" && !map[slot.key].fallback) return fail(`${slot.label}: add a fallback to use when the value is missing.`);
  }
  return Object.keys(map).length ? map : null;
}

/* ---------- resolving values for one contact ---------- */

export type MappableContact = { name: string | null; phone?: string | null; attributes: unknown };

/** WhatsApp rejects newlines, tabs and runs of four spaces inside a parameter. */
export const cleanParam = (value: string): string => value.replace(/\s+/g, " ").trim();

function scalar(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function rawValue(src: VariableSource, contact: MappableContact): string | null {
  if (src.source === "static") return src.value ?? null;
  if (src.source === "field") {
    if (src.key === "name") return contact.name;
    if (src.key === "first_name") return contact.name?.trim().split(/\s+/)[0] ?? null;
    return contact.phone ?? null;
  }
  const attrs = contact.attributes && typeof contact.attributes === "object" && !Array.isArray(contact.attributes) ? (contact.attributes as Record<string, unknown>) : {};
  return scalar(attrs[src.key ?? ""]);
}

export type Resolved = { ok: true; value: string; usedFallback: boolean } | { ok: false };

function valueFor(slot: Slot, src: VariableSource | undefined, contact: MappableContact, policy: MissingValuePolicy): Resolved {
  const effective: VariableSource | undefined = src ?? (slot.kind === "body" ? { source: "attribute", key: slot.key } : undefined);
  if (!effective) return { ok: false };
  const check = (text: string | null): string | null => {
    if (text === null) return null;
    const clean = slot.kind === "header_media" ? text.trim() : cleanParam(text);
    if (!clean) return null;
    if (slot.kind === "header_media") return isHttpsUrl(clean) ? clean : null;
    return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
  };
  let value = check(rawValue(effective, contact));
  if (value === null && !src && slot.kind === "body" && slot.key === "1") value = check(contact.name);
  if (value !== null) return { ok: true, value, usedFallback: false };
  if (policy === "fallback" && effective.fallback) {
    const fb = check(effective.fallback);
    if (fb !== null) return { ok: true, value: fb, usedFallback: true };
  }
  return { ok: false };
}

export type BuiltComponent = Record<string, unknown>;
export type BuildResult = { ok: true; components: BuiltComponent[] } | { ok: false; missing: string[] };

/** The send components for one contact, or the labels of the slots that have no value under the broadcast's policy. */
export function buildRecipientComponents(templateComponents: unknown, contact: MappableContact, map: VariableMap | null, policy: MissingValuePolicy): BuildResult {
  const slots = templateSlots(templateComponents);
  const header: BuiltComponent[] = [];
  const body: { type: "text"; text: string }[] = [];
  const buttons: BuiltComponent[] = [];
  const missing: string[] = [];
  for (const slot of slots) {
    const got = valueFor(slot, map?.[slot.key], contact, policy);
    if (!got.ok) {
      missing.push(slot.label);
      continue;
    }
    if (slot.kind === "body") body.push({ type: "text", text: got.value });
    else if (slot.kind === "header_text") header.push({ type: "header", parameters: [{ type: "text", text: got.value }] });
    else if (slot.kind === "header_media") header.push({ type: "header", parameters: [{ type: slot.mediaType, [slot.mediaType]: { link: got.value } }] });
    else buttons.push({ type: "button", sub_type: "url", index: String(slot.buttonIndex), parameters: [{ type: "text", text: got.value.replace(/\s/g, "%20") }] });
  }
  if (missing.length) return { ok: false, missing };
  return { ok: true, components: [...header, ...(body.length ? [{ type: "body", parameters: body }] : []), ...buttons] };
}

/** How many of these contacts would have a missing value for at least one slot. Used for the coverage warning and "stop" policy. */
export function countMissing(templateComponents: unknown, contacts: readonly MappableContact[], map: VariableMap | null, policy: MissingValuePolicy) {
  const bySlot = new Map<string, number>();
  let contactsMissing = 0;
  for (const contact of contacts) {
    const built = buildRecipientComponents(templateComponents, contact, map, policy);
    if (built.ok) continue;
    contactsMissing++;
    for (const label of built.missing) bySlot.set(label, (bySlot.get(label) ?? 0) + 1);
  }
  return { contactsMissing, bySlot: [...bySlot.entries()].map(([label, count]) => ({ label, count })) };
}
