import type { Prisma } from "@/generated/prisma/client";
import { callingCodesFor, countryOfBsuid } from "@/lib/broadcasts/country";
import { HttpError } from "@/lib/tenancy";

/*
 * Audience filter: { all?: Condition[]; any?: Condition[] }. A contact matches when every "all" condition holds and,
 * if there are "any" conditions, at least one of them holds. Attribute conditions cannot be written as reliable SQL
 * (missing keys behave as NULL), so a filter that uses them is evaluated in code over a narrowed scan (see service.ts).
 */

export type FieldKind = "text" | "tag" | "date" | "lastInbound" | "country" | "attribute";
export type Op =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "exists"
  | "not_exists"
  | "has"
  | "not_has"
  | "before"
  | "after"
  | "within_days"
  | "older_than_days"
  | "never"
  | "greater_than"
  | "less_than";

export type Condition = { field: string; op: Op; value?: string };
export type Filter = { all?: Condition[]; any?: Condition[] };

export const MAX_CONDITIONS = 20;
const MAX_VALUE = 200;
const ATTR_PREFIX = "attr:";
const ATTR_KEY = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,59}$/;
const DAY_MS = 86_400_000;

type FieldDef = { label: string; kind: FieldKind; column?: "name" | "phone" | "optInSource" | "leadStage" | "ownerUserId" | "createdAt" | "optInAt" };

export const FIELDS: Record<string, FieldDef> = {
  name: { label: "Name", kind: "text", column: "name" },
  phone: { label: "Phone number", kind: "text", column: "phone" },
  country: { label: "Country", kind: "country" },
  tag: { label: "Tag", kind: "tag" },
  optInSource: { label: "Where they opted in", kind: "text", column: "optInSource" },
  optInAt: { label: "Opted in on", kind: "date", column: "optInAt" },
  createdAt: { label: "Added on", kind: "date", column: "createdAt" },
  leadStage: { label: "Lead stage", kind: "text", column: "leadStage" },
  ownerUserId: { label: "Owner", kind: "text", column: "ownerUserId" },
  lastInbound: { label: "Last message from them", kind: "lastInbound" },
};

const OPS_BY_KIND: Record<FieldKind, Op[]> = {
  text: ["is", "is_not", "contains", "not_contains", "starts_with", "exists", "not_exists"],
  tag: ["has", "not_has"],
  date: ["before", "after", "within_days", "older_than_days", "exists", "not_exists"],
  lastInbound: ["within_days", "older_than_days", "never"],
  country: ["is", "is_not"],
  attribute: ["is", "is_not", "contains", "not_contains", "starts_with", "greater_than", "less_than", "exists", "not_exists"],
};

const NO_VALUE: Op[] = ["exists", "not_exists", "never"];

export const OP_LABELS: Record<Op, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  exists: "is filled in",
  not_exists: "is empty",
  has: "is tagged",
  not_has: "is not tagged",
  before: "is before",
  after: "is after",
  within_days: "in the last (days)",
  older_than_days: "more than (days) ago",
  never: "never",
  greater_than: "is more than",
  less_than: "is less than",
};

export const attributeField = (key: string) => `${ATTR_PREFIX}${key}`;
export const isAttributeField = (field: string) => field.startsWith(ATTR_PREFIX);
export const attributeKey = (field: string) => field.slice(ATTR_PREFIX.length);

export function kindOf(field: string): FieldKind | null {
  if (isAttributeField(field)) return ATTR_KEY.test(attributeKey(field)) ? "attribute" : null;
  return FIELDS[field]?.kind ?? null;
}

export const opsFor = (field: string): Op[] => OPS_BY_KIND[kindOf(field) ?? "text"];
export const needsValue = (op: Op) => !NO_VALUE.includes(op);

const bad = (message: string): never => {
  throw new HttpError(400, message);
};

function parseCondition(raw: unknown): Condition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("Each filter needs a field, a test and a value.");
  const { field, op, value } = raw as Record<string, unknown>;
  if (typeof field !== "string") return bad("Each filter needs a field.");
  const kind = kindOf(field);
  if (!kind) return bad("One of the filters uses a field we do not know.");
  if (typeof op !== "string" || !OPS_BY_KIND[kind].includes(op as Op)) return bad("One of the filters uses a test that does not fit its field.");
  if (!needsValue(op as Op)) return { field, op: op as Op };
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !text.trim()) return bad("Fill in the value for every filter.");
  if (text.length > MAX_VALUE) return bad("A filter value is too long.");
  const clean = text.trim();
  if ((op === "within_days" || op === "older_than_days") && !/^\d{1,4}$/.test(clean)) return bad("Days must be a whole number.");
  if ((op === "before" || op === "after") && Number.isNaN(Date.parse(clean))) return bad("Dates must look like 2026-03-31.");
  if ((op === "greater_than" || op === "less_than") && !Number.isFinite(Number(clean))) return bad("Use a number for this test.");
  if (kind === "country" && !callingCodesFor(clean.toUpperCase()).length) return bad("We do not know that country code.");
  return { field, op: op as Op, value: kind === "country" ? clean.toUpperCase() : clean };
}

function parseGroup(raw: unknown, label: string): Condition[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return bad(`${label} must be a list of filters.`);
  if (raw.length > MAX_CONDITIONS) return bad(`Use at most ${MAX_CONDITIONS} filters.`);
  return raw.map(parseCondition);
}

export function parseFilter(raw: unknown): Filter {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("The audience filter is not valid.");
  const { all, any } = raw as Record<string, unknown>;
  const out: Filter = {};
  const a = parseGroup(all, "all");
  const b = parseGroup(any, "any");
  if (a?.length) out.all = a;
  if (b?.length) out.any = b;
  return out;
}

export const isEmptyFilter = (f: Filter | null | undefined) => !f || (!(f.all?.length ?? 0) && !(f.any?.length ?? 0));
export const conditionsOf = (f: Filter): Condition[] => [...(f.all ?? []), ...(f.any ?? [])];
export const usesAttributes = (f: Filter) => conditionsOf(f).some((c) => isAttributeField(c.field));
export const usesLastInbound = (f: Filter) => conditionsOf(f).some((c) => c.field === "lastInbound");

/* ---------- SQL (no attribute conditions) ---------- */

const insensitive = "insensitive" as const;
const days = (n: string, now: Date) => new Date(now.getTime() - Number(n) * DAY_MS);

function textWhere(column: string, c: Condition): Prisma.ContactWhereInput {
  const v = c.value ?? "";
  const eq = { [column]: { equals: v, mode: insensitive } } as Prisma.ContactWhereInput;
  const has = { [column]: { contains: v, mode: insensitive } } as Prisma.ContactWhereInput;
  // Every text column can be NULL (phone too, for a contact known only by BSUID), and NOT (NULL) never matches.
  const withNull = (neg: Prisma.ContactWhereInput): Prisma.ContactWhereInput => ({ OR: [{ [column]: null } as Prisma.ContactWhereInput, { NOT: neg }] });
  switch (c.op) {
    case "is":
      return eq;
    case "is_not":
      return withNull(eq);
    case "contains":
      return has;
    case "not_contains":
      return withNull(has);
    case "starts_with":
      return { [column]: { startsWith: v, mode: insensitive } } as Prisma.ContactWhereInput;
    case "exists":
      return { AND: [{ [column]: { not: null } } as Prisma.ContactWhereInput, { NOT: { [column]: "" } as Prisma.ContactWhereInput }] };
    default:
      return { OR: [{ [column]: null } as Prisma.ContactWhereInput, { [column]: "" } as Prisma.ContactWhereInput] };
  }
}

function dateWhere(column: string, c: Condition, now: Date): Prisma.ContactWhereInput {
  switch (c.op) {
    case "before":
      return { [column]: { lt: new Date(c.value!) } } as Prisma.ContactWhereInput;
    case "after":
      return { [column]: { gt: new Date(c.value!) } } as Prisma.ContactWhereInput;
    case "within_days":
      return { [column]: { gte: days(c.value!, now) } } as Prisma.ContactWhereInput;
    case "older_than_days":
      return { [column]: { lt: days(c.value!, now) } } as Prisma.ContactWhereInput;
    case "exists":
      return { [column]: { not: null } } as Prisma.ContactWhereInput;
    default:
      return { [column]: null } as Prisma.ContactWhereInput;
  }
}

function lastInboundWhere(c: Condition, now: Date): Prisma.ContactWhereInput {
  if (c.op === "within_days") return { conversations: { some: { lastInboundAt: { gte: days(c.value!, now) } } } };
  if (c.op === "older_than_days") return { conversations: { none: { lastInboundAt: { gte: days(c.value!, now) } } } };
  return { conversations: { none: { lastInboundAt: { not: null } } } };
}

/** Country comes from the phone number; a contact with no phone falls back to the country prefix of its BSUID. NULL-safe in both directions. */
function countryWhere(c: Condition): Prisma.ContactWhereInput {
  const iso = (c.value ?? "").toUpperCase();
  const starts = callingCodesFor(iso).map((code) => ({ phone: { startsWith: `+${code}` } }));
  const bsuidPrefix = { startsWith: `${iso}.`, mode: "insensitive" as const };
  if (c.op === "is") return { OR: [...starts, { AND: [{ phone: null }, { bsuid: bsuidPrefix }] }] };
  return { AND: [{ OR: [{ phone: null }, { NOT: { OR: starts } }] }, { OR: [{ phone: { not: null } }, { bsuid: null }, { NOT: { bsuid: bsuidPrefix } }] }] };
}

/**
 * Contacts created without tags (most inbound ones) have a NULL tags column, and NOT (NULL) is never true in SQL, so
 * "is not tagged" also takes the NULL rows explicitly. Prisma reads that NULL back as [], so this matches conditionMatches.
 */
function tagWhere(c: Condition): Prisma.ContactWhereInput {
  const has: Prisma.ContactWhereInput = { tags: { has: c.value! } };
  return c.op === "has" ? has : { OR: [{ tags: { equals: null } }, { NOT: has }] };
}

export function conditionWhere(c: Condition, now = new Date()): Prisma.ContactWhereInput {
  const kind = kindOf(c.field);
  if (kind === "tag") return tagWhere(c);
  if (kind === "country") return countryWhere(c);
  if (kind === "lastInbound") return lastInboundWhere(c, now);
  if (kind === "date") return dateWhere(FIELDS[c.field].column!, c, now);
  if (kind === "text") return textWhere(FIELDS[c.field].column!, c);
  throw new Error("Attribute conditions are evaluated in code.");
}

/** SQL for a filter with no attribute conditions. Empty filter gives {} (matches everyone). */
export function filterToWhere(filter: Filter, now = new Date()): Prisma.ContactWhereInput {
  const parts: Prisma.ContactWhereInput[] = (filter.all ?? []).map((c) => conditionWhere(c, now));
  if (filter.any?.length) parts.push({ OR: filter.any.map((c) => conditionWhere(c, now)) });
  return parts.length ? { AND: parts } : {};
}

/** SQL that narrows the scan for a filter that uses attributes: only the all-conditions that are plain columns. */
export function prefilterWhere(filter: Filter, now = new Date()): Prisma.ContactWhereInput {
  const plain = (filter.all ?? []).filter((c) => !isAttributeField(c.field));
  return plain.length ? { AND: plain.map((c) => conditionWhere(c, now)) } : {};
}

/* ---------- code evaluation ---------- */

export type ContactSnapshot = {
  name: string | null;
  phone: string | null;
  bsuid?: string | null;
  tags: string[];
  attributes: unknown;
  optInSource: string | null;
  optInAt: Date | null;
  createdAt: Date;
  leadStage: string | null;
  ownerUserId: string | null;
  lastInboundAt: Date | null;
};

export const SNAPSHOT_SELECT = {
  name: true,
  phone: true,
  bsuid: true,
  tags: true,
  attributes: true,
  optInSource: true,
  optInAt: true,
  createdAt: true,
  leadStage: true,
  ownerUserId: true,
} as const;

const lower = (s: string) => s.toLowerCase();

function textMatches(value: string | null, c: Condition): boolean {
  const have = value === null || value === undefined ? "" : lower(String(value).trim());
  const want = lower(c.value ?? "");
  switch (c.op) {
    case "is":
      return have === want || (have !== "" && Number.isFinite(Number(have)) && Number.isFinite(Number(want)) && Number(have) === Number(want));
    case "is_not":
      return !textMatches(value, { ...c, op: "is" });
    case "contains":
      return have.includes(want);
    case "not_contains":
      return !have.includes(want);
    case "starts_with":
      return have.startsWith(want);
    case "exists":
      return have !== "";
    case "not_exists":
      return have === "";
    case "greater_than":
      return have !== "" && Number.isFinite(Number(have)) && Number(have) > Number(want);
    case "less_than":
      return have !== "" && Number.isFinite(Number(have)) && Number(have) < Number(want);
    default:
      return false;
  }
}

function dateMatches(value: Date | null, c: Condition, now: Date): boolean {
  if (c.op === "exists") return !!value;
  if (c.op === "not_exists") return !value;
  if (!value) return false;
  const t = value.getTime();
  switch (c.op) {
    case "before":
      return t < Date.parse(c.value!);
    case "after":
      return t > Date.parse(c.value!);
    case "within_days":
      return t >= days(c.value!, now).getTime();
    default:
      return t < days(c.value!, now).getTime();
  }
}

function attributeText(attributes: unknown, key: string): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return null;
  const v = (attributes as Record<string, unknown>)[key];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null;
}

export function conditionMatches(contact: ContactSnapshot, c: Condition, now = new Date()): boolean {
  const kind = kindOf(c.field);
  if (kind === "attribute") return textMatches(attributeText(contact.attributes, attributeKey(c.field)), c);
  if (kind === "tag") return c.op === "has" ? (contact.tags ?? []).includes(c.value!) : !(contact.tags ?? []).includes(c.value!);
  if (kind === "country") {
    const iso = (c.value ?? "").toUpperCase();
    const hit = contact.phone ? callingCodesFor(iso).some((code) => contact.phone!.startsWith(`+${code}`)) : countryOfBsuid(contact.bsuid ?? "") === iso;
    return c.op === "is" ? hit : !hit;
  }
  if (kind === "lastInbound") {
    if (c.op === "never") return !contact.lastInboundAt;
    if (c.op === "within_days") return !!contact.lastInboundAt && contact.lastInboundAt.getTime() >= days(c.value!, now).getTime();
    return !contact.lastInboundAt || contact.lastInboundAt.getTime() < days(c.value!, now).getTime();
  }
  const column = FIELDS[c.field]?.column;
  if (!column) return false;
  if (kind === "date") return dateMatches(contact[column as "createdAt" | "optInAt"], c, now);
  return textMatches(contact[column as "name" | "phone" | "optInSource" | "leadStage" | "ownerUserId"], c);
}

export function filterMatches(contact: ContactSnapshot, filter: Filter, now = new Date()): boolean {
  const all = (filter.all ?? []).every((c) => conditionMatches(contact, c, now));
  if (!all) return false;
  return !filter.any?.length || filter.any.some((c) => conditionMatches(contact, c, now));
}

/** One line per condition, in words a shop owner reads: "Tag is tagged vip". */
export function describeCondition(c: Condition): string {
  const kind = kindOf(c.field);
  const label = isAttributeField(c.field) ? attributeKey(c.field) : (FIELDS[c.field]?.label ?? c.field);
  const op = kind === "tag" ? OP_LABELS[c.op] : OP_LABELS[c.op];
  return needsValue(c.op) ? `${label} ${op} ${c.value}` : `${label} ${op}`;
}
