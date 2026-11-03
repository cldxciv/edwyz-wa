import { HttpError } from "@/lib/tenancy";
import { readPlaceholders } from "@/lib/templates/validate";

/*
 * Per-recipient template values. Each fillable spot in a template (a body placeholder, a header placeholder, a header
 * image/video/document, a button link placeholder, a coupon code button) is a "slot" with a key: "1", "2" ... for numbered body
 * placeholders, the name for named ones ({{first_name}} is "first_name"), "header", and "button:<index>" for buttons.
 * Broadcast.variableMap says where each slot's value comes from. Named placeholders (Meta's parameter_format NAMED) are sent with
 * their parameter_name; the format is read from the text itself, because Meta only allows names in a NAMED template.
 */

export type Slot =
  | { key: string; kind: "body"; label: string; name?: string }
  | { key: "header"; kind: "header_text"; label: string; name?: string }
  | { key: "header"; kind: "header_media"; label: string; mediaType: "image" | "video" | "document" }
  | { key: string; kind: "button_url"; label: string; buttonIndex: number }
  | { key: string; kind: "button_copy_code"; label: string; buttonIndex: number };

/** "upload" is a file uploaded to WhatsApp for the broadcast's number (header media only): value is Meta's media id. */
export type SourceKind = "field" | "attribute" | "static" | "upload";
export type VariableSource = { source: SourceKind; key?: string; value?: string; fallback?: string; filename?: string; uploadedAt?: string; phoneNumberId?: string };
export type VariableMap = Record<string, VariableSource>;
export type MissingValuePolicy = "skip" | "fallback" | "fail";
export const POLICIES: MissingValuePolicy[] = ["skip", "fallback", "fail"];

export const CONTACT_FIELDS = ["name", "first_name", "phone"] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export const FIELD_LABELS: Record<ContactField, string> = { name: "Full name", first_name: "First name", phone: "Phone number" };

export const MAX_TEXT = 1024;
export const MAX_URL = 2000;
/** Meta's limit for the code a coupon (copy code) button copies. */
export const MAX_COUPON = 15;
const ATTR_KEY = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,59}$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Meta keeps a file uploaded to a number for 30 days. A day of margin, so a message is never sent with an id about to expire. */
export const UPLOAD_TTL_MS = 30 * DAY_MS;
const UPLOAD_USABLE_MS = UPLOAD_TTL_MS - DAY_MS;
/** An uploaded file older than this is uploaded again (see media.ts), so long and scheduled broadcasts keep a live id. */
export const UPLOAD_REFRESH_MS = 20 * DAY_MS;

type Component = Record<string, unknown>;
const list = (components: unknown): Component[] => (Array.isArray(components) ? (components as Component[]).filter((c) => c && typeof c === "object") : []);
const isVar = (text: unknown) => typeof text === "string" && /\{\{\s*\d+\s*\}\}/.test(text);
/** A named body placeholder keeps its name as key; "header" is taken by the header slot. */
const bodyKey = (name: string) => (name === "header" ? "body:header" : name);

export const isCouponCode = (value: string) => value.length > 0 && value.length <= MAX_COUPON && /^[A-Za-z0-9]+$/.test(value);
const isFixed = (src: VariableSource) => src.source === "static" || src.source === "upload";

/** Every spot in the template that needs a value for each recipient. */
export function templateSlots(components: unknown): Slot[] {
  const all = list(components);
  const slots: Slot[] = [];
  const header = all.find((c) => c.type === "HEADER");
  if (header) {
    const format = typeof header.format === "string" ? header.format.toUpperCase() : "TEXT";
    if (format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
      slots.push({ key: "header", kind: "header_media", mediaType: format.toLowerCase() as "image" | "video" | "document", label: `Header ${format.toLowerCase()}` });
    } else {
      const p = readPlaceholders(header.text);
      if (p.names.length) slots.push({ key: "header", kind: "header_text", name: p.names[0], label: `Header placeholder {{${p.names[0]}}}` });
      else if (p.numbers.length) slots.push({ key: "header", kind: "header_text", label: "Header placeholder {{1}}" });
    }
  }
  const body = all.find((c) => c.type === "BODY");
  if (body && typeof body.text === "string") {
    const p = readPlaceholders(body.text);
    for (const n of p.numbers) slots.push({ key: String(n), kind: "body", label: `Message placeholder {{${n}}}` });
    for (const name of p.names) slots.push({ key: bodyKey(name), kind: "body", name, label: `Message placeholder {{${name}}}` });
  }
  const buttons = (all.find((c) => c.type === "BUTTONS")?.buttons as { type?: unknown; url?: unknown; text?: unknown }[] | undefined) ?? [];
  buttons.forEach((b, i) => {
    const text = typeof b?.text === "string" ? b.text : "button";
    if (b?.type === "COPY_CODE") return void slots.push({ key: `button:${i}`, kind: "button_copy_code", buttonIndex: i, label: `Coupon code for the "${text}" button` });
    if (b && b.type !== undefined && b.type !== "URL") return;
    if (isVar(b?.url)) slots.push({ key: `button:${i}`, kind: "button_url", buttonIndex: i, label: `Link placeholder for the "${text}" button` });
  });
  return slots;
}

/** True when sending needs more than the old body-only filling (so the mapping UI and validation apply). */
export const needsMapping = (components: unknown) => templateSlots(components).some((s) => s.kind !== "body");

/* ---------- uploaded header files ---------- */

/** True while an uploaded file's media id can still be sent (Meta drops it after 30 days). */
export function uploadUsable(src: VariableSource | undefined, now: Date = new Date()): boolean {
  if (!src || src.source !== "upload" || !src.value || !MEDIA_ID.test(src.value)) return false;
  const at = Date.parse(src.uploadedAt ?? "");
  return Number.isFinite(at) && now.getTime() - at < UPLOAD_USABLE_MS;
}

/** The keys of the slots filled from an uploaded file. */
export const uploadedKeys = (map: VariableMap | null | undefined): string[] => Object.entries(map ?? {}).filter(([, s]) => s?.source === "upload").map(([k]) => k);

/** When the oldest uploaded file of the map should be uploaded again, or null when the map has none. */
export function nextUploadRefresh(map: VariableMap | null | undefined): Date | null {
  const times = uploadedKeys(map)
    .map((k) => Date.parse(map?.[k]?.uploadedAt ?? ""))
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times) + UPLOAD_REFRESH_MS) : null;
}

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

function parseUpload(slot: Slot, raw: Record<string, unknown>, out: VariableSource): void {
  const { value, uploadedAt, phoneNumberId, filename } = raw;
  if (slot.kind !== "header_media") return fail(`${slot.label}: only a header picture, video or document can be a file you upload.`);
  const at = typeof uploadedAt === "string" ? Date.parse(uploadedAt) : NaN;
  if (typeof value !== "string" || !MEDIA_ID.test(value) || !Number.isFinite(at)) return fail(`${slot.label}: upload the file again.`);
  if (typeof phoneNumberId !== "string" || !phoneNumberId || phoneNumberId.length > 64) return fail(`${slot.label}: upload the file again.`);
  out.value = value;
  out.uploadedAt = new Date(at).toISOString();
  out.phoneNumberId = phoneNumberId;
  if (typeof filename === "string" && filename.trim()) out.filename = filename.trim().slice(0, 100);
}

function parseSource(slot: Slot, raw: unknown): VariableSource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(`${slot.label}: choose where the value comes from.`);
  const { source, key, value, fallback } = raw as Record<string, unknown>;
  if (source !== "field" && source !== "attribute" && source !== "static" && source !== "upload") return fail(`${slot.label}: choose where the value comes from.`);
  const media = slot.kind === "header_media";
  const coupon = slot.kind === "button_copy_code";
  const max = slot.kind === "body" || slot.kind === "header_text" ? MAX_TEXT : coupon ? MAX_COUPON : MAX_URL;
  const out: VariableSource = { source };
  if (source === "field") {
    if (typeof key !== "string" || !CONTACT_FIELDS.includes(key as ContactField)) return fail(`${slot.label}: pick a contact detail.`);
    if (media) return fail(`${slot.label}: upload a file, or use a contact attribute that holds a link, or a fixed link.`);
    if (coupon) return fail(`${slot.label}: use a code saved on each contact, or the same code for everyone.`);
    out.key = key;
  } else if (source === "attribute") {
    if (typeof key !== "string" || !ATTR_KEY.test(key)) return fail(`${slot.label}: pick a contact attribute.`);
    out.key = key;
  } else if (source === "upload") {
    parseUpload(slot, raw as Record<string, unknown>, out);
  } else {
    if (typeof value !== "string" || !value.trim()) return fail(`${slot.label}: enter the fixed value.`);
    if (value.length > max) return fail(`${slot.label}: the value is too long.`);
    if (media && !isHttpsUrl(value.trim())) return fail(`${slot.label}: a fixed link must start with https:// and be a public address.`);
    if (coupon && !isCouponCode(value.trim())) return fail(`${slot.label}: a coupon code is up to ${MAX_COUPON} letters and numbers, without spaces.`);
    out.value = value.trim();
  }
  if (fallback !== undefined && fallback !== null && fallback !== "") {
    if (typeof fallback !== "string" || fallback.length > max) return fail(`${slot.label}: the fallback is not valid.`);
    if (media && !isHttpsUrl(fallback.trim())) return fail(`${slot.label}: a fallback link must start with https://.`);
    if (coupon && !isCouponCode(fallback.trim())) return fail(`${slot.label}: a fallback code is up to ${MAX_COUPON} letters and numbers, without spaces.`);
    out.fallback = fallback.trim();
  }
  return out;
}

/**
 * Checks a variable map against the template. Returns null when nothing is mapped (old behaviour: body {{n}} from the
 * attribute named n, {{1}} falling back to the name). Header and button slots must always be mapped; with the "fallback"
 * policy every slot must be mapped and every value that is not the same for everyone needs a fallback.
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
    if (policy === "fallback" && !isFixed(map[slot.key]) && !map[slot.key].fallback) return fail(`${slot.label}: add a fallback to use when the value is missing.`);
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
  if (src.source === "upload") return null;
  if (src.source === "field") {
    if (src.key === "name") return contact.name;
    if (src.key === "first_name") return contact.name?.trim().split(/\s+/)[0] ?? null;
    return contact.phone ?? null;
  }
  const attrs = contact.attributes && typeof contact.attributes === "object" && !Array.isArray(contact.attributes) ? (contact.attributes as Record<string, unknown>) : {};
  return scalar(attrs[src.key ?? ""]);
}

export type Resolved = { ok: true; value: string; usedFallback: boolean; mediaId?: boolean; filename?: string } | { ok: false };

function valueFor(slot: Slot, src: VariableSource | undefined, contact: MappableContact, policy: MissingValuePolicy, now: Date): Resolved {
  const effective: VariableSource | undefined = src ?? (slot.kind === "body" ? { source: "attribute", key: slot.name ?? slot.key } : undefined);
  if (!effective) return { ok: false };
  const check = (text: string | null): string | null => {
    if (text === null) return null;
    const clean = slot.kind === "header_media" ? text.trim() : cleanParam(text);
    if (!clean) return null;
    if (slot.kind === "header_media") return isHttpsUrl(clean) ? clean : null;
    if (slot.kind === "button_copy_code") return isCouponCode(clean) ? clean : null;
    return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
  };
  if (effective.source === "upload" && slot.kind === "header_media" && uploadUsable(effective, now)) {
    return { ok: true, value: effective.value as string, usedFallback: false, mediaId: true, ...(effective.filename ? { filename: effective.filename } : {}) };
  }
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

const textParam = (slot: { name?: string }, text: string) => ({ type: "text", ...(slot.name ? { parameter_name: slot.name } : {}), text });

function mediaParam(slot: Extract<Slot, { kind: "header_media" }>, got: Extract<Resolved, { ok: true }>) {
  const document = slot.mediaType === "document" && got.filename ? { filename: got.filename } : {};
  return { type: slot.mediaType, [slot.mediaType]: got.mediaId ? { id: got.value, ...document } : { link: got.value } };
}

/** The send components for one contact, or the labels of the slots that have no value under the broadcast's policy. */
export function buildRecipientComponents(templateComponents: unknown, contact: MappableContact, map: VariableMap | null, policy: MissingValuePolicy, now: Date = new Date()): BuildResult {
  const slots = templateSlots(templateComponents);
  const header: BuiltComponent[] = [];
  const body: BuiltComponent[] = [];
  const buttons: BuiltComponent[] = [];
  const missing: string[] = [];
  for (const slot of slots) {
    const got = valueFor(slot, map?.[slot.key], contact, policy, now);
    if (!got.ok) {
      missing.push(slot.label);
      continue;
    }
    if (slot.kind === "body") body.push(textParam(slot, got.value));
    else if (slot.kind === "header_text") header.push({ type: "header", parameters: [textParam(slot, got.value)] });
    else if (slot.kind === "header_media") header.push({ type: "header", parameters: [mediaParam(slot, got)] });
    else if (slot.kind === "button_copy_code") buttons.push({ type: "button", sub_type: "COPY_CODE", index: String(slot.buttonIndex), parameters: [{ type: "coupon_code", coupon_code: got.value }] });
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
