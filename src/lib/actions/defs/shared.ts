/**
 * Helpers shared by the v1 action definitions (docs/EDDY-SPEC.md 4.2, 4.6). Pure, apart from the lazy database loader:
 * service modules are imported inside run()/preview() with `await import(...)`, so loading the registry (and with it the
 * model toolsets) never pulls the inbox, contacts or broadcast services, prisma or the Graph transport into a module graph
 * that only needs tool definitions.
 *
 * Nothing here calls a definition's run(): src/lib/actions/invoke.ts is the only caller (4.8 test 3).
 */
import { UNDO_WINDOW_MS } from "@/lib/eddy/contract";
import { hasRole, HttpError, type Actor } from "@/lib/tenancy";
import type { ActionDefinition } from "../registry";
import type { ActionCtx, CostLine, I18nKey, JsonSchema, Preview, UntrustedSource, UntrustedText, Warning } from "../types";
import { u, uOrNull } from "../untrusted";

export { u, uOrNull };

/** Identity helper that keeps a definition's argument and result types while it is written, then erases them for the registry. */
export function define<A extends Record<string, unknown>, R>(def: ActionDefinition<A, R>): ActionDefinition {
  return def as unknown as ActionDefinition;
}

/** The database, loaded on first use (see the file comment). */
export async function db() {
  return (await import("@/lib/db")).prisma;
}

export const UNDO_MS = UNDO_WINDOW_MS;

// ===== Schemas (strict: every object closes its properties and lists what it requires) =====

export const ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

export function obj(properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false, ...(description ? { description } : {}) };
}

export const id = (description: string): JsonSchema => ({ type: "string", pattern: ID_PATTERN, description });
export const str = (description: string, maxLength: number, minLength?: number): JsonSchema => ({ type: "string", description, maxLength, ...(minLength !== undefined ? { minLength } : {}) });
export const oneOf = (description: string, values: readonly string[]): JsonSchema => ({ type: "string", description, enum: values });
export const int = (description: string, minimum: number, maximum: number): JsonSchema => ({ type: "integer", description, minimum, maximum });
export const bool = (description: string): JsonSchema => ({ type: "boolean", description });
export const list = (description: string, items: JsonSchema, maxItems: number): JsonSchema => ({ type: "array", description, items, maxItems });
export const ids = (description: string, maxItems: number): JsonSchema => list(description, id("An id."), maxItems);
export const tagList = (description: string, maxItems = 10): JsonSchema => list(description, { type: "string", minLength: 1, maxLength: 40, description: "A tag." }, maxItems);
export const EMPTY = obj({});

// ===== Actors and roles =====

export const actorOf = (ctx: ActionCtx): Actor => ctx.p.actor;
export const isAdmin = (ctx: ActionCtx): boolean => hasRole(ctx.p.actor, "admin");

/** A route-equivalent role check (requireRole), with the route's own sentence. */
export function requireAdmin(ctx: ActionCtx, message = "You do not have permission to do this."): void {
  if (!isAdmin(ctx)) throw new HttpError(403, message);
}

// ===== Values =====

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asStringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const iso = (d: Date | string | null | undefined): string | null => (d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null);
export const clampLimit = (n: unknown, max: number, fallback: number): number => (typeof n === "number" && Number.isInteger(n) ? Math.min(Math.max(n, 1), max) : fallback);

/** Ratio as a whole percentage, or null without a denominator (tools compute percentages, 5.7). */
export function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Tags written by teammates are workspace text: the model reads them as data, never as instructions. */
export const tagsU = (tags: unknown): UntrustedText[] => asStringList(tags).map((t) => u("workspace_text", t, 40));

/** A contact's display name, or null. */
export function contactName(c: { name?: string | null; username?: string | null } | null | undefined): string | null {
  const name = c?.name?.trim() || c?.username?.trim();
  return name ? name : null;
}

/** The name on a card title: the contact's own words, so always UntrustedText (types.ts Preview.vars). */
export const nameVar = (name: string | null | undefined, fallback = "-"): UntrustedText => u("contact_name", name && name.trim() ? name : fallback, 80);

export const untrustedOr = (source: UntrustedSource, text: string | null | undefined, max = 200): UntrustedText | null => uOrNull(source, text ?? null, max);

// ===== Previews =====

export const FREE_INTERNAL: CostLine = { state: "free", reason: "internal" };
export const FREE_WINDOW: CostLine = { state: "free", reason: "service_window" };

/** A preview with the defaults filled in: no facts, no warnings, nothing editable, not a danger card, free. */
export function preview(p: { titleKey: I18nKey; confirmLabelKey: I18nKey; material: Record<string, string | number> } & Partial<Omit<Preview, "titleKey" | "confirmLabelKey" | "material">>): Preview {
  return {
    vars: {},
    facts: [],
    cost: FREE_INTERNAL,
    warnings: [],
    editable: [],
    danger: false,
    ...p,
  };
}

/** Warnings in a fixed order without duplicates, so the preview hash is stable. */
export function warnings(...list: (Warning | false | null | undefined)[]): Warning[] {
  const out: Warning[] = [];
  for (const w of list) if (w && !out.includes(w)) out.push(w);
  return out;
}

/** True when the card acts on a different chat than the one the member has open (6.5 warning differs_from_open_chat). */
export function differsFromOpenChat(ctx: ActionCtx, conversationId: string): boolean {
  const open = ctx.p.page?.conversationId;
  return typeof open === "string" && open.length > 0 && open !== conversationId;
}

/** A link or a phone-like number in text the model drafted (6.5 warning contains_link_or_number). */
export function hasLinkOrNumber(text: string): boolean {
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|co|me|ly|app)\b)/i.test(text) || /(\+?\d[\d\s().-]{6,}\d)/.test(text);
}

/** sha256 of a text, for card material (a changed draft is a material change at confirm). */
export async function textHash(text: string): Promise<string> {
  const { sha256Hex } = await import("../canonical");
  return sha256Hex(text);
}

/** The material entry for a set of ids, order-free. */
export async function idsHash(list: readonly string[]): Promise<string> {
  const { sha256Hex } = await import("../canonical");
  return sha256Hex([...list].sort().join(","));
}

// ===== Undo =====

/** The undo record's `before`/`after` as a record. */
export const undoPart = (v: unknown): Record<string, unknown> => asRecord(v);

/** The route's 404 sentence for a missing record. */
export const notFound = (what: string) => new HttpError(404, `${what} not found.`);
