import { type MissingValuePolicy, type Slot, type VariableMap, type VariableSource, isHttpsUrl, templateSlots } from "@/lib/broadcasts/mapping";

export { templateSlots };
export type { MissingValuePolicy, Slot, VariableMap, VariableSource };

/** The values the person picks in the form. A source is "field:name", "field:first_name", "field:phone", "attribute" or "static". */
export type SourceChoice = "field:name" | "field:first_name" | "field:phone" | "attribute" | "static";

export const CHOICE_LABELS: Record<SourceChoice, string> = {
  "field:name": "Their full name",
  "field:first_name": "Their first name",
  "field:phone": "Their phone number",
  attribute: "A detail saved on the contact",
  static: "The same text for everyone",
};

export const MEDIA_CHOICE_LABELS: Partial<Record<SourceChoice, string>> = {
  attribute: "A link saved on each contact",
  static: "The same link for everyone",
};

export function choicesFor(slot: Slot): SourceChoice[] {
  return slot.kind === "header_media" ? ["attribute", "static"] : ["field:name", "field:first_name", "field:phone", "attribute", "static"];
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
  return { source: "field", key: choice.slice("field:".length), ...fallback };
}

/** Sensible starting values: {{1}} is the contact's name; everything else must be chosen. */
export function defaultMap(slots: Slot[]): VariableMap {
  const map: VariableMap = {};
  for (const slot of slots) {
    if (slot.kind === "header_media") map[slot.key] = { source: "static", value: "" };
    else if (slot.kind === "body" && slot.key === "1") map[slot.key] = { source: "field", key: "name" };
    else if (slot.kind === "header_text") map[slot.key] = { source: "field", key: "name" };
    else map[slot.key] = { source: "attribute", key: "" };
  }
  return map;
}

export function mappingProblems(slots: Slot[], map: VariableMap, policy: MissingValuePolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of slots) {
    const src = map[slot.key];
    if (!src) out[slot.key] = "Choose where this value comes from.";
    else if (src.source === "attribute" && !(src.key ?? "").trim()) out[slot.key] = "Choose or type the name of the saved detail.";
    else if (src.source === "static" && !(src.value ?? "").trim()) out[slot.key] = slot.kind === "header_media" ? "Paste the link to the file." : "Enter the text to send.";
    else if (src.source === "static" && slot.kind === "header_media" && !isHttpsUrl((src.value ?? "").trim())) out[slot.key] = "The link must start with https:// and be a public address.";
    else if (policy === "fallback" && src.source !== "static" && !(src.fallback ?? "").trim()) out[slot.key] = "Add a fallback to use when the value is missing.";
    else if (policy === "fallback" && slot.kind === "header_media" && src.fallback && !isHttpsUrl(src.fallback.trim())) out[slot.key] = "The fallback link must start with https://";
  }
  return out;
}

/** The first problem as one sentence, for the hint under the Next button. Null when the mapping is complete. */
export function firstMappingProblem(slots: Slot[], map: VariableMap, policy: MissingValuePolicy): string | null {
  const problems = mappingProblems(slots, map, policy);
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
