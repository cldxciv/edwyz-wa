export const MAX_VARIABLE_CHARS = 1024;
export const MAX_VARIABLES = 20;

type Component = { type?: unknown; format?: unknown; text?: unknown; buttons?: unknown };

const asComponents = (value: unknown): Component[] => (Array.isArray(value) ? value.filter((c): c is Component => !!c && typeof c === "object") : []);
const typeOf = (c: Component) => (typeof c.type === "string" ? c.type.toUpperCase() : "");
const textOf = (c: Component) => (typeof c.text === "string" ? c.text : "");

export function bodyText(components: unknown): string {
  const body = asComponents(components).find((c) => typeOf(c) === "BODY");
  return body ? textOf(body) : "";
}

/** The highest {{n}} used in the text; 0 when there are none. */
export function variableCount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export type Sendable = { ok: true; variables: number } | { ok: false; reason: string };

/** What a sender that fills body values only (the inbox picker, automation rules) cannot fill in, or null when nothing. */
export type SendProblem = "media_header" | "header_variable" | "button_variable" | "too_many_variables";

export function templateSendProblem(components: unknown): SendProblem | null {
  const list = asComponents(components);
  for (const c of list) {
    const type = typeOf(c);
    if (type === "HEADER") {
      const format = typeof c.format === "string" ? c.format.toUpperCase() : "TEXT";
      if (format !== "TEXT") return "media_header";
      if (/\{\{/.test(textOf(c))) return "header_variable";
    }
    if (type === "BUTTONS" && Array.isArray(c.buttons)) {
      const needsValue = c.buttons.some((b) => b && typeof b === "object" && /\{\{/.test(String((b as { url?: unknown }).url ?? "")));
      if (needsValue) return "button_variable";
    }
  }
  return variableCount(bodyText(list)) > MAX_VARIABLES ? "too_many_variables" : null;
}

const INLINE_REASON: Record<SendProblem, string> = {
  media_header: "Has a media header. Send it from Broadcasts.",
  header_variable: "Has a variable in the header. Send it from Broadcasts.",
  button_variable: "Has a button with a variable. Send it from Broadcasts.",
  too_many_variables: "Has too many variables.",
};

/** The inline picker fills body variables only. Media headers and button variables need the Templates page. */
export function inlineSendable(components: unknown): Sendable {
  const problem = templateSendProblem(components);
  if (problem) return { ok: false, reason: INLINE_REASON[problem] };
  return { ok: true, variables: variableCount(bodyText(components)) };
}

/** Replaces {{n}} with the given values; unfilled ones stay visible as {{n}}. */
export function fillTemplate(text: string, values: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (match, n: string) => {
    const value = values[Number(n) - 1];
    return value && value.trim() ? value : match;
  });
}

/** WhatsApp rejects newlines, tabs and runs of four spaces inside a template parameter. */
export function cleanVariable(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export type VariablesResult = { ok: true; values: string[] } | { ok: false; error: string };

export function checkVariables(raw: unknown, expected: number): VariablesResult {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) return { ok: false, error: "variables must be a list of text values." };
  if (list.length !== expected) return { ok: false, error: `This template needs ${expected} value${expected === 1 ? "" : "s"}.` };
  const values = (list as string[]).map(cleanVariable);
  const missing = values.findIndex((v) => !v);
  if (missing >= 0) return { ok: false, error: `Fill in value ${missing + 1}.` };
  if (values.some((v) => v.length > MAX_VARIABLE_CHARS)) return { ok: false, error: "A value is too long." };
  return { ok: true, values };
}

export function buildBodyComponents(values: string[]): unknown[] {
  if (values.length === 0) return [];
  return [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }];
}
