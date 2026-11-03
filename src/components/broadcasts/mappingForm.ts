import { type MissingValuePolicy, type Slot, type VariableMap, type VariableSource, MAX_COUPON, isCouponCode, isHttpsUrl, templateSlots, uploadUsable } from "@/lib/broadcasts/mapping";

export { templateSlots };
export type { MissingValuePolicy, Slot, VariableMap, VariableSource };

/** The values the person picks in the form. A source is "field:name", "field:first_name", "field:phone", "attribute", "static" or "upload". */
export type SourceChoice = "field:name" | "field:first_name" | "field:phone" | "attribute" | "static" | "upload";

export const CHOICE_LABELS: Record<SourceChoice, string> = {
  "field:name": "Their full name",
  "field:first_name": "Their first name",
  "field:phone": "Their phone number",
  attribute: "A detail saved on the contact",
  static: "The same text for everyone",
  upload: "A file I upload",
};

export const MEDIA_CHOICE_LABELS: Partial<Record<SourceChoice, string>> = {
  upload: "A file I upload",
  attribute: "A link saved on each contact",
  static: "The same link for everyone",
};

export const COUPON_CHOICE_LABELS: Partial<Record<SourceChoice, string>> = {
  static: "The same code for everyone",
  attribute: "A code saved on each contact",
};

/** The label of a choice for this kind of slot. */
export function choiceLabel(slot: Slot, choice: SourceChoice): string {
  const labels = slot.kind === "header_media" ? MEDIA_CHOICE_LABELS : slot.kind === "button_copy_code" ? COUPON_CHOICE_LABELS : CHOICE_LABELS;
  return labels[choice] ?? CHOICE_LABELS[choice];
}

export function choicesFor(slot: Slot): SourceChoice[] {
  if (slot.kind === "header_media") return ["upload", "static", "attribute"];
  if (slot.kind === "button_copy_code") return ["static", "attribute"];
  return ["field:name", "field:first_name", "field:phone", "attribute", "static"];
}

export function choiceOf(src: VariableSource | undefined): SourceChoice {
  if (!src) return "attribute";
  if (src.source === "field") return `field:${src.key ?? "name"}` as SourceChoice;
  return src.source;
}

export function fromChoice(choice: SourceChoice, prev: VariableSource | undefined): VariableSource {
  const fallback = prev?.fallback ? { fallback: prev.fallback } : {};
  if (choice === "attribute") return { source: "attribute", key: prev?.source === "attribute" ? prev.key : "", ...fallback };
  if (choice === "static") return { source: "static", value: prev?.source === "static" ? prev.value : "", ...fallback };
  if (choice === "upload") return prev?.source === "upload" ? { ...prev } : { source: "upload", value: "", ...fallback };
  return { source: "field", key: choice.slice("field:".length), ...fallback };
}

const FIELD_NAMES = new Set(["name", "first_name", "phone"]);

/**
 * Sensible starting values: {{1}} is the contact's name, a named placeholder like {{first_name}} or {{order_id}} starts from the
 * contact detail of that name, a header file is uploaded, and everything else must be chosen.
 */
export function defaultMap(slots: Slot[]): VariableMap {
  const map: VariableMap = {};
  for (const slot of slots) {
    if (slot.kind === "header_media") map[slot.key] = { source: "upload", value: "" };
    else if (slot.kind === "button_copy_code") map[slot.key] = { source: "static", value: "" };
    else if ((slot.kind === "body" || slot.kind === "header_text") && slot.name) {
      map[slot.key] = FIELD_NAMES.has(slot.name) ? { source: "field", key: slot.name } : { source: "attribute", key: slot.name };
    } else if (slot.kind === "body" && slot.key === "1") map[slot.key] = { source: "field", key: "name" };
    else if (slot.kind === "header_text") map[slot.key] = { source: "field", key: "name" };
    else map[slot.key] = { source: "attribute", key: "" };
  }
  return map;
}

/** What the form knows beyond the map: the number the broadcast is sent from (an uploaded file belongs to one number). */
export type MappingContext = { phoneNumberId?: string; now?: Date };

const COUPON_RULE = `A coupon code is up to ${MAX_COUPON} letters and numbers, without spaces.`;

function uploadProblem(src: VariableSource, ctx: MappingContext): string | null {
  if (!src.value) return "Upload the file to send.";
  if (ctx.phoneNumberId && src.phoneNumberId && src.phoneNumberId !== ctx.phoneNumberId) return "This file was uploaded for another number. Upload it again.";
  if (!uploadUsable(src, ctx.now ?? new Date())) return "WhatsApp keeps an uploaded file for 30 days. Upload it again.";
  return null;
}

function slotProblem(slot: Slot, src: VariableSource | undefined, policy: MissingValuePolicy, ctx: MappingContext): string | null {
  if (!src) return "Choose where this value comes from.";
  if (src.source === "upload") return uploadProblem(src, ctx);
  if (src.source === "attribute" && !(src.key ?? "").trim()) return "Choose or type the name of the saved detail.";
  if (src.source === "static") {
    const value = (src.value ?? "").trim();
    if (!value) return slot.kind === "header_media" ? "Paste the link to the file." : slot.kind === "button_copy_code" ? "Enter the code to send." : "Enter the text to send.";
    if (slot.kind === "header_media" && !isHttpsUrl(value)) return "The link must start with https:// and be a public address.";
    if (slot.kind === "button_copy_code" && !isCouponCode(value)) return COUPON_RULE;
    return null;
  }
  if (policy !== "fallback") return null;
  const fallback = (src.fallback ?? "").trim();
  if (!fallback) return "Add a fallback to use when the value is missing.";
  if (slot.kind === "header_media" && !isHttpsUrl(fallback)) return "The fallback link must start with https://";
  if (slot.kind === "button_copy_code" && !isCouponCode(fallback)) return COUPON_RULE;
  return null;
}

export function mappingProblems(slots: Slot[], map: VariableMap, policy: MissingValuePolicy, ctx: MappingContext = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of slots) {
    const problem = slotProblem(slot, map[slot.key], policy, ctx);
    if (problem) out[slot.key] = problem;
  }
  return out;
}

/** The first problem as one sentence, for the hint under the Next button. Null when the mapping is complete. */
export function firstMappingProblem(slots: Slot[], map: VariableMap, policy: MissingValuePolicy, ctx: MappingContext = {}): string | null {
  const problems = mappingProblems(slots, map, policy, ctx);
  const slot = slots.find((s) => problems[s.key]);
  return slot ? `${slot.label}: ${problems[slot.key]}` : null;
}

/** What is sent to the server: only filled-in parts, trimmed. */
export function cleanMap(slots: Slot[], map: VariableMap): VariableMap {
  const out: VariableMap = {};
  for (const slot of slots) {
    const src = map[slot.key];
    if (!src) continue;
    const clean: VariableSource = { source: src.source };
    if (src.key) clean.key = src.key.trim();
    if (src.value) clean.value = src.value.trim();
    if (src.fallback?.trim()) clean.fallback = src.fallback.trim();
    if (src.source === "upload") {
      if (src.filename) clean.filename = src.filename;
      if (src.uploadedAt) clean.uploadedAt = src.uploadedAt;
      if (src.phoneNumberId) clean.phoneNumberId = src.phoneNumberId;
    }
    out[slot.key] = clean;
  }
  return out;
}

export const POLICY_CHOICES: { value: MissingValuePolicy; label: string; help: string }[] = [
  { value: "skip", label: "Skip that person", help: "They are not messaged. They show as Not sent in the report, so you can fix the detail and follow up." },
  { value: "fallback", label: "Use a fallback instead", help: "You enter a standard value for each placeholder, like Customer instead of a missing name." },
  { value: "fail", label: "Stop the whole broadcast", help: "Nothing is sent until every contact has the details. Good when a wrong message would be costly." },
];

export function policyNote(policy: MissingValuePolicy, missing: number): string {
  const people = `${missing.toLocaleString()} ${missing === 1 ? "person has" : "people have"}`;
  if (policy === "skip") return `${people} no value for a placeholder and will be skipped.`;
  if (policy === "fallback") return `${people} no value for a placeholder, even after your fallback, and will be skipped.`;
  return `${people} no value for a placeholder. The broadcast will not start until that is fixed.`;
}

/** The file types a header upload accepts, by the template's header kind (the same rules as the template's sample file). */
export const UPLOAD_ACCEPT: Record<"image" | "video" | "document", { accept: string; help: string }> = {
  image: { accept: "image/jpeg,image/png", help: "A JPG or PNG image up to 5 MB." },
  video: { accept: "video/mp4", help: "An MP4 video up to 16 MB." },
  document: { accept: "application/pdf", help: "A PDF up to 16 MB." },
};
