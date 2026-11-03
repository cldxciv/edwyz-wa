import { HttpError } from "@/lib/tenancy";

export const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
export type TemplateCategory = (typeof CATEGORIES)[number];

export type TemplateComponent = Record<string, unknown> & { type: string };
export type TemplateInput = { name: string; language: string; category: TemplateCategory; components: TemplateComponent[] };

export const MAX_BUTTONS = 10;
export const MAX_URL_BUTTONS = 2;
export const MAX_PHONE_BUTTONS = 1;
/** Meta's limit for the "This code expires in N minutes" footer of an authentication template. */
export const MAX_CODE_EXPIRY_MINUTES = 90;
const NAME_RE = /^[a-z0-9_]+$/;
const LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MEDIA_FORMATS = new Set(["IMAGE", "VIDEO", "DOCUMENT"]);
const BUTTON_TYPES = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);

const fail = (message: string): never => {
  throw new HttpError(400, message);
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The placeholders in a template's text, without throwing. Templates synced from Meta can use named placeholders
 * ({{first_name}}, Meta's parameter_format NAMED) instead of numbered ones ({{1}}, POSITIONAL): a placeholder that is all digits
 * is numbered, anything else is a name. Meta never mixes the two in one template, so "mixed" marks text nothing can fill.
 */
export type Placeholders = { format: "none" | "positional" | "named" | "mixed"; numbers: number[]; names: string[] };

export function readPlaceholders(text: unknown): Placeholders {
  const tokens = typeof text === "string" ? [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]) : [];
  const numbers = [...new Set(tokens.filter((t) => /^\d+$/.test(t)).map(Number))].sort((a, b) => a - b);
  const names = [...new Set(tokens.filter((t) => !/^\d+$/.test(t)))];
  const format = numbers.length && names.length ? "mixed" : names.length ? "named" : numbers.length ? "positional" : "none";
  return { format, numbers, names };
}

/** The highest {{n}} in the text (0 when there is none), or null when it uses named placeholders and cannot be filled by position. */
export function positionalCount(text: unknown): number | null {
  const p = readPlaceholders(text);
  if (p.format === "named" || p.format === "mixed") return null;
  return p.numbers.length ? p.numbers[p.numbers.length - 1] : 0;
}

/** Returns the variable numbers used, e.g. "{{1}} and {{2}}" gives [1, 2]. Must be sequential from 1. */
export function templateVariables(text: string): number[] {
  const nums = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (nums.some((n) => !/^[1-9]\d*$/.test(n))) fail("Variables must be numbered like {{1}}.");
  const unique = [...new Set(nums.map(Number))].sort((a, b) => a - b);
  if (unique.some((n, i) => n !== i + 1)) fail("Variables must be sequential starting at {{1}}.");
  return unique;
}

function textOf(component: Record<string, unknown>, label: string, max: number): string {
  const text = component.text;
  if (typeof text !== "string" || !text.trim()) return fail(`${label} text is required.`);
  if (text.length > max) fail(`${label} text must be at most ${max} characters.`);
  return text;
}

function exampleStrings(value: unknown, count: number, label: string) {
  const ok = Array.isArray(value) && value.length === count && value.every((s) => typeof s === "string" && s.trim());
  if (!ok) fail(`${label} needs ${count} example value(s).`);
}

function validateHeader(c: Record<string, unknown>) {
  const format = c.format;
  if (format === "TEXT") {
    const vars = templateVariables(textOf(c, "Header", 60));
    if (vars.length > 1) fail("Header text can contain at most one variable.");
    if (vars.length === 1) {
      exampleStrings((isObject(c.example) ? c.example : {}).header_text, 1, "Header");
    }
  } else if (typeof format === "string" && MEDIA_FORMATS.has(format)) {
    const handle = isObject(c.example) ? c.example.header_handle : undefined;
    if (!Array.isArray(handle) || handle.length === 0 || typeof handle[0] !== "string" || !handle[0]) {
      fail("Media headers need a media handle in example.header_handle.");
    }
  } else fail("Header format must be TEXT, IMAGE, VIDEO or DOCUMENT.");
}

/** True when the text starts or ends with a {{n}} placeholder, which Meta refuses in a template body. */
export function variableAtEdge(text: string): boolean {
  return /^\s*\{\{\s*\w+\s*\}\}|\{\{\s*\w+\s*\}\}\s*$/.test(text);
}

function validateBody(c: Record<string, unknown>) {
  const text = textOf(c, "Body", 1024);
  const vars = templateVariables(text);
  if (vars.length === 0) return;
  const rows = (isObject(c.example) ? c.example : {}).body_text;
  if (!Array.isArray(rows) || rows.length === 0) fail("Body variables need example values in example.body_text.");
  exampleStrings((rows as unknown[])[0], vars.length, "Body");
  if (variableAtEdge(text)) fail("The body cannot start or end with a variable. Add words before or after it.");
}

function validateButton(b: unknown) {
  if (!isObject(b) || typeof b.type !== "string" || !BUTTON_TYPES.has(b.type)) {
    return fail("Button type must be QUICK_REPLY, URL or PHONE_NUMBER.");
  }
  textOf(b, "Button", 25);
  if (b.type === "URL") {
    if (typeof b.url !== "string" || !/^https:\/\//.test(b.url)) fail("URL buttons need an https url.");
    const vars = templateVariables(b.url as string);
    if (vars.length > 1) fail("URL buttons can contain at most one variable.");
    if (vars.length === 1) exampleStrings(b.example, 1, "URL button");
  }
  if (b.type === "PHONE_NUMBER" && (typeof b.phone_number !== "string" || !/^\+\d{7,15}$/.test(b.phone_number))) {
    fail("Phone buttons need a phone_number like +919876543210.");
  }
}

/** Meta's rules for the mix of button types, in the order they are checked; null when the mix is fine. Shared with the editor. */
export function buttonMixProblem(types: readonly string[]): string | null {
  if (types.filter((t) => t === "URL").length > MAX_URL_BUTTONS) return `A template can have at most ${MAX_URL_BUTTONS} website buttons.`;
  if (types.filter((t) => t === "PHONE_NUMBER").length > MAX_PHONE_BUTTONS) return `A template can have at most ${MAX_PHONE_BUTTONS} call button.`;
  const quick = types.map((t, i) => (t === "QUICK_REPLY" ? i : -1)).filter((i) => i >= 0);
  if (quick.length && quick[quick.length - 1] - quick[0] !== quick.length - 1) return "Quick reply buttons must sit together, before or after the website and call buttons.";
  return null;
}

function validateButtons(c: Record<string, unknown>) {
  const buttons = c.buttons;
  if (!Array.isArray(buttons) || buttons.length === 0) fail("BUTTONS needs at least one button.");
  if ((buttons as unknown[]).length > MAX_BUTTONS) fail(`A template can have at most ${MAX_BUTTONS} buttons.`);
  (buttons as unknown[]).forEach(validateButton);
  const problem = buttonMixProblem((buttons as { type: string }[]).map((b) => b.type));
  if (problem) fail(problem);
}

/*
 * Authentication templates use Meta's fixed one-time-code format: Meta writes the body ("{{1}} is your verification code."),
 * the footer only carries the expiry, and the one button copies the code. No header, no own text, no other buttons.
 */
function validateAuthComponent(c: Record<string, unknown>) {
  if (c.type === "HEADER") fail("Authentication templates cannot have a header.");
  else if (c.type === "BODY") {
    if (c.text !== undefined) fail("Authentication templates use Meta's fixed message, so the body cannot have its own text.");
    if (c.add_security_recommendation !== undefined && typeof c.add_security_recommendation !== "boolean") fail("add_security_recommendation must be true or false.");
  } else if (c.type === "FOOTER") {
    const minutes = c.code_expiration_minutes;
    if (c.text !== undefined || typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CODE_EXPIRY_MINUTES) {
      fail(`The footer of an authentication template only holds code_expiration_minutes, a whole number from 1 to ${MAX_CODE_EXPIRY_MINUTES}.`);
    }
  } else if (c.type === "BUTTONS") {
    const buttons = Array.isArray(c.buttons) ? (c.buttons as unknown[]) : [];
    const b = buttons[0];
    if (buttons.length !== 1 || !isObject(b) || b.type !== "OTP" || b.otp_type !== "COPY_CODE") fail("Authentication templates need exactly one copy-code button (type OTP, otp_type COPY_CODE).");
    else if (b.text !== undefined) textOf(b, "Button", 25);
  } else fail(`Unknown component type ${c.type}.`);
}

export function validateTemplateInput(input: unknown): TemplateInput {
  if (!isObject(input)) return fail("Template must be an object.");
  const { name, language, category, components } = input as { name: unknown; language: unknown; category: unknown; components: unknown };
  if (typeof name !== "string" || !name || name.length > 512 || !NAME_RE.test(name)) {
    fail("Name must be lowercase letters, digits and underscores, up to 512 characters.");
  }
  if (typeof language !== "string" || !LANG_RE.test(language)) fail("Language must be a code like en or en_US.");
  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
    fail("Category must be MARKETING, UTILITY or AUTHENTICATION.");
  }
  if (!Array.isArray(components) || components.length === 0) return fail("Components are required.");

  const seen = new Set<string>();
  for (const c of components as unknown[]) {
    if (!isObject(c) || typeof c.type !== "string") return fail("Each component needs a type.");
    if (seen.has(c.type)) fail(`Duplicate ${c.type} component.`);
    seen.add(c.type);
    if (category === "AUTHENTICATION") validateAuthComponent(c);
    else if (c.type === "HEADER") validateHeader(c);
    else if (c.type === "BODY") validateBody(c);
    else if (c.type === "FOOTER") {
      if (templateVariables(textOf(c, "Footer", 60)).length) fail("Footer cannot contain variables.");
    } else if (c.type === "BUTTONS") validateButtons(c);
    else fail(`Unknown component type ${c.type}.`);
  }
  if (!seen.has("BODY")) fail("A BODY component is required.");
  if (category === "AUTHENTICATION" && !seen.has("BUTTONS")) fail("Authentication templates need a copy-code button.");
  return { name: name as string, language: language as string, category: category as TemplateCategory, components: components as TemplateComponent[] };
}
