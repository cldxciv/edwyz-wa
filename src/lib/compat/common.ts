import type { Contact } from "@/generated/prisma/client";
import { normalizeBsuid } from "@/lib/contacts/identity";
import { normalizePhone } from "@/lib/contacts/phone";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./spec";

export const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${name} must be a whole number from 1 to ${max}.`);
  return n;
}

/** Offset pagination is bounded so a deep page cannot force the database to skip millions of rows. */
export const MAX_OFFSET_WINDOW = 10_000;

export type Paging = { page_number: number; page_size: number; skip: number; take: number };

export function parsePaging(params: URLSearchParams): Paging {
  const page_number = intParam(params, "page_number", 1, 1_000_000);
  const page_size = intParam(params, "page_size", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  if (page_number * page_size > MAX_OFFSET_WINDOW) {
    throw new HttpError(400, `page_number x page_size must not exceed ${MAX_OFFSET_WINDOW}. Narrow the list with filters instead of paging that deep.`);
  }
  return { page_number, page_size, skip: (page_number - 1) * page_size, take: page_size };
}

/** The envelope shared by every list endpoint: the items under a named key plus page_number, page_size, total and has_more. */
export function pageJson(key: string, items: unknown[], paging: Paging, total: number) {
  const more = paging.skip + items.length < total;
  const nextFits = (paging.page_number + 1) * paging.page_size <= MAX_OFFSET_WINDOW;
  return { [key]: items, page_number: paging.page_number, page_size: paging.page_size, total, has_more: more && nextFits, window_exhausted: more && !nextFits };
}

export function sliceMemory<T>(rows: T[], paging: Paging): T[] {
  return rows.slice(paging.skip, paging.skip + paging.take);
}

export const toE164 = (input: string): string | null => normalizePhone(input.trim().startsWith("+") ? input : `+${input}`);

const EXTERNAL_PREFIX = "external_id:";
const BSUID_PREFIX = "bsuid:";
const PHONE_LIKE = /^\+?[\d\s\-().]+$/;

/**
 * Accepts a phone number (with or without +, as E.164 digits), a contact id, external_id:<value>, bsuid:<value> or a bare BSUID like US.1234.
 * Bare digits are read as already including the country code, unlike the dashboard which assumes a default country.
 */
export async function findContact(tenantId: string, target: string): Promise<Contact | null> {
  const t = target.trim();
  if (!t || t.length > 200) return null;
  if (t.startsWith(EXTERNAL_PREFIX)) {
    const value = t.slice(EXTERNAL_PREFIX.length);
    if (!value) return null;
    return prisma.contact.findFirst({ where: { tenantId, attributes: { path: ["external_id"], equals: value } } });
  }
  if (t.startsWith(BSUID_PREFIX)) {
    const value = t.slice(BSUID_PREFIX.length);
    return value ? prisma.contact.findFirst({ where: { tenantId, bsuid: value } }) : null;
  }
  if (PHONE_LIKE.test(t)) {
    const phone = toE164(t);
    return phone ? prisma.contact.findFirst({ where: { tenantId, phone } }) : null;
  }
  const bare = normalizeBsuid(t);
  if (bare) return prisma.contact.findFirst({ where: { tenantId, bsuid: bare } });
  return prisma.contact.findFirst({ where: { id: t, tenantId } });
}

export type ResolvedTarget = { contact: Contact | null; conversationId: string | null };

/** A path target that may also be a conversation id. Conversation ids are looked up first, then everything findContact accepts. */
export async function resolveTarget(tenantId: string, target: string): Promise<ResolvedTarget> {
  const t = target.trim();
  if (!t || t.length > 200) return { contact: null, conversationId: null };
  const plain = !t.startsWith(EXTERNAL_PREFIX) && !t.startsWith(BSUID_PREFIX) && !PHONE_LIKE.test(t) && !normalizeBsuid(t);
  if (plain) {
    const conversation = await prisma.conversation.findFirst({ where: { id: t, tenantId }, include: { contact: true } });
    if (conversation) return { contact: conversation.contact, conversationId: conversation.id };
  }
  return { contact: await findContact(tenantId, t), conversationId: null };
}

export async function requireContact(tenantId: string, target: string): Promise<Contact> {
  const contact = await findContact(tenantId, target);
  if (!contact) throw new HttpError(404, "Contact not found.");
  return contact;
}

/** Contacts may carry no phone number (identified only by BSUID or external_id); callers must handle null. */
export const phoneOf = (c: { phone: string | null }): string | null => c.phone ?? null;

export function requirePhone(c: { phone: string | null }): string {
  const phone = phoneOf(c);
  if (!phone) throw new HttpError(422, "This contact has no phone number, so it cannot be messaged.");
  return phone;
}

const attrs = (c: { attributes: unknown }): Record<string, unknown> => (isObject(c.attributes) ? c.attributes : {});

export function contactView(c: Contact) {
  const a = attrs(c);
  return {
    id: c.id,
    phone_number: phoneOf(c),
    external_id: typeof a.external_id === "string" ? a.external_id : null,
    bsuid: c.bsuid ?? null,
    username: c.username ?? null,
    wa_id: c.waId ?? null,
    name: c.name,
    tags: c.tags,
    custom_params: Object.entries(a).map(([name, value]) => ({ name, value })),
    opt_in: c.optIn,
    opted_out_at: c.optedOutAt?.toISOString() ?? null,
    created: c.createdAt.toISOString(),
  };
}

export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const MAX_NAME = 200;
const MAX_TAGS = 50;
const MAX_ATTR_BYTES = 10_000;

export function parseName(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_NAME) throw new HttpError(400, `name must be a string up to ${MAX_NAME} characters.`);
  return value.trim();
}

export function parseTags(value: unknown, field = "tags"): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS || value.some((x) => typeof x !== "string" || !x.trim() || x.length > 60)) {
    throw new HttpError(400, `${field} must be up to ${MAX_TAGS} short strings.`);
  }
  return [...new Set((value as string[]).map((x) => x.trim()))];
}

/** Accepts [{ name, value }] (the form existing recipes send). A null value means "remove". */
export function parseCustomParams(value: unknown, field = "custom_params"): Record<string, unknown> {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, `${field} must be an array of { name, value } with at most 100 items.`);
  const out: Record<string, unknown> = {};
  for (const item of value) {
    if (!isObject(item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 60) {
      throw new HttpError(400, `Every ${field} item needs a name of up to 60 characters.`);
    }
    const v = item.value;
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new HttpError(400, `${field} values must be text, number, boolean or null.`);
    out[item.name.trim()] = v;
  }
  return out;
}

/** Merges patch into current; null values delete keys. */
export function mergeAttributes(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  if (JSON.stringify(merged).length > MAX_ATTR_BYTES) throw new HttpError(400, "Attributes are limited to 10 KB in total.");
  return merged;
}

export const currentAttributes = attrs;
