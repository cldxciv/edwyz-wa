/*
 * Message placeholders for rule replies and reply materials. Pure.
 *   {{name}}  {{first_name}}  {{phone}}  {{attribute.city}}   and a fallback after a bar: {{attribute.city|your area}}
 * A placeholder with no value and no fallback becomes empty text, so the customer never sees braces.
 */

export type VariableValues = { name: string | null; phone: string; attributes: Record<string, unknown> };

export const PLACEHOLDER_HELP = [
  { token: "{{name}}", meaning: "The contact's name" },
  { token: "{{first_name}}", meaning: "The contact's first name" },
  { token: "{{phone}}", meaning: "The contact's phone number" },
  { token: "{{attribute.city}}", meaning: "A detail saved on the contact, here city" },
] as const;

const TOKEN = /\{\{\s*([A-Za-z_][\w. -]{0,60}?)\s*(?:\|([^{}]{0,80}))?\}\}/g;

function attributeValue(attributes: Record<string, unknown>, name: string): string {
  const key = Object.keys(attributes).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : attributes[key];
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

export function renderText(template: string, values: VariableValues): string {
  const first = values.name?.trim().split(/\s+/)[0] ?? "";
  return template.replace(TOKEN, (_all, rawName: string, fallback: string | undefined) => {
    const name = rawName.trim();
    const lower = name.toLowerCase();
    let value = "";
    if (lower === "name") value = values.name?.trim() ?? "";
    else if (lower === "first_name") value = first;
    else if (lower === "phone") value = values.phone;
    else if (lower.startsWith("attribute.") || lower.startsWith("attr.")) value = attributeValue(values.attributes, name.slice(name.indexOf(".") + 1));
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    return lower === "name" || lower === "first_name" ? "there" : "";
  });
}

/** Names of the placeholders used in a text that this module does not know, so the builder can warn. */
export function unknownPlaceholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    const lower = m[1].trim().toLowerCase();
    if (!["name", "first_name", "phone"].includes(lower) && !lower.startsWith("attribute.") && !lower.startsWith("attr.")) out.add(m[1].trim());
  }
  return [...out];
}
