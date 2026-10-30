import type { AskValidation, ConditionOperator } from "./flow";

export type VarContext = {
  variables: Record<string, unknown>;
  contact: { name?: string | null; phone?: string | null; attributes?: unknown };
};

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const MAX_VALUE = 1024;

function walk(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (FORBIDDEN.has(key) || current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Looks up contact.name, contact.phone, contact.<attribute>, then session variables, then contact attributes. */
export function resolveValue(name: string, ctx: VarContext): unknown {
  const path = name.trim().split(".");
  if (path[0] === "contact") {
    if (path[1] === "name") return ctx.contact.name ?? undefined;
    if (path[1] === "phone") return ctx.contact.phone ?? undefined;
    return walk(ctx.contact.attributes, path.slice(path[1] === "attributes" ? 2 : 1));
  }
  const fromVariables = walk(ctx.variables, path);
  return fromVariables !== undefined ? fromVariables : walk(ctx.contact.attributes, path);
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.slice(0, MAX_VALUE);
}

/** Replaces {{name}} placeholders. Unknown names become empty text. With json: true, values are escaped for use inside a JSON string. */
export function interpolate(template: string, ctx: VarContext, opts: { json?: boolean } = {}): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.\- ]{1,128}?)\s*\}\}/g, (_m, name: string) => {
    const text = stringify(resolveValue(name, ctx));
    return opts.json ? JSON.stringify(text).slice(1, -1) : text;
  });
}

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

export function evaluateCondition(operator: ConditionOperator, actual: unknown, expected: string | undefined): boolean {
  const left = stringify(actual);
  const right = expected ?? "";
  switch (operator) {
    case "exists":
      return left.trim() !== "";
    case "equals":
      return norm(left) === norm(right);
    case "not_equals":
      return norm(left) !== norm(right);
    case "contains":
      return norm(right) !== "" && norm(left).includes(norm(right));
    case "not_contains":
      return norm(right) === "" || !norm(left).includes(norm(right));
    case "starts_with":
      return norm(right) !== "" && norm(left).startsWith(norm(right));
    case "not_starts_with":
      return norm(right) === "" || !norm(left).startsWith(norm(right));
    case "gt":
    case "lt": {
      const a = Number(left);
      const b = Number(right);
      if (left.trim() === "" || right.trim() === "" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return operator === "gt" ? a > b : a < b;
    }
  }
}

/** Accepts 2026-03-27, 27/03/2026 and 27-03-2026 (day first, as most customers write it) and returns YYYY-MM-DD for a real calendar date. */
export function parseDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!year) return null;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2200 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type Answer = { ok: true; value: string } | { ok: false };

export function validateAnswer(kind: AskValidation, raw: string, choices?: string[]): Answer {
  const text = raw.trim();
  if (!text) return { ok: false };
  switch (kind) {
    case "text":
      return { ok: true, value: text.slice(0, 1024) };
    case "number": {
      const n = Number(text.replace(/,/g, ""));
      return Number.isFinite(n) && /^[-+]?[\d,]*\.?\d+$/.test(text) ? { ok: true, value: String(n) } : { ok: false };
    }
    case "email":
      return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(text) && text.length <= 254 ? { ok: true, value: text.toLowerCase() } : { ok: false };
    case "phone": {
      const digits = text.replace(/[\s().-]/g, "");
      return /^\+?\d{7,15}$/.test(digits) ? { ok: true, value: digits.startsWith("+") ? digits : `+${digits}` } : { ok: false };
    }
    case "date": {
      const date = parseDate(text);
      return date ? { ok: true, value: date } : { ok: false };
    }
    case "choice": {
      if (!choices || choices.length === 0) return { ok: true, value: text.slice(0, 1024) };
      const found = choices.find((c) => norm(c) === norm(text));
      if (found) return { ok: true, value: found };
      const index = /^\d{1,2}$/.test(text) ? Number(text) - 1 : -1;
      return index >= 0 && index < choices.length ? { ok: true, value: choices[index] } : { ok: false };
    }
  }
}
