import type { Prisma } from "@/generated/prisma/client";
import { countryProbe } from "@/lib/broadcasts/country";
import { prisma } from "@/lib/db";
import { type Actor, HttpError } from "@/lib/tenancy";
import {
  type ContactSnapshot,
  type Filter,
  SNAPSHOT_SELECT,
  filterMatches,
  filterToWhere,
  isEmptyFilter,
  parseFilter,
  prefilterWhere,
  usesAttributes,
  usesLastInbound,
} from "./filter";
import { PRESET_PREFIX, findPreset, presetSegments } from "./presets";

export const MAX_SEGMENTS = 50;
/** Filters on attributes are evaluated in code; beyond this many scanned contacts the answer is flagged as partial. */
export const MAX_SCAN = 200_000;
const PAGE = 2000;
const SAMPLE = 5;
const NAME_MAX = 80;

export type AudienceSpec = { segmentId?: string; filter?: Filter };

/** Contacts a person blocked (a conversation with status "blocked") never get marketing messages, so no audience counts them. */
export const NOT_BLOCKED: Prisma.ContactWhereInput = { conversations: { none: { status: "blocked" } } };
export type Sample = { id: string; name: string | null; phone: string | null; bsuid?: string | null; username?: string | null };
export type Preview = { count: number; sample: Sample[]; truncated: boolean };

/* ---------- segment CRUD ---------- */

function cleanName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "Give the segment a name.");
  const name = raw.trim();
  if (name.length > NAME_MAX) throw new HttpError(400, `Use a name of ${NAME_MAX} characters or fewer.`);
  return name;
}

export async function listSegments(actor: Actor) {
  const [rows, attributeKeys, tagRows] = await Promise.all([
    prisma.segment.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" }, take: MAX_SEGMENTS + 10 }),
    knownAttributeKeys(actor.tenantId),
    prisma.contact.findMany({ where: { tenantId: actor.tenantId, tags: { isEmpty: false } }, select: { tags: true }, take: 5000 }),
  ]);
  const tags = [...new Set(tagRows.flatMap((r) => r.tags))].sort();
  return { segments: rows, presets: presetSegments(), attributeKeys, tags };
}

export async function createSegment(actor: Actor, input: { name: unknown; filter: unknown }) {
  const name = cleanName(input.name);
  const filter = parseFilter(input.filter);
  if (isEmptyFilter(filter)) throw new HttpError(400, "Add at least one filter. A segment with no filters is just everyone.");
  const [count, same] = await Promise.all([
    prisma.segment.count({ where: { tenantId: actor.tenantId } }),
    prisma.segment.findFirst({ where: { tenantId: actor.tenantId, name }, select: { id: true } }),
  ]);
  if (count >= MAX_SEGMENTS) throw new HttpError(409, `You can keep up to ${MAX_SEGMENTS} segments. Delete one you no longer use.`);
  if (same) throw new HttpError(409, "You already have a segment with this name.");
  return prisma.segment.create({ data: { tenantId: actor.tenantId, name, filter: filter as Prisma.InputJsonObject, createdByUserId: actor.userId } });
}

async function ownedSegment(actor: Actor, id: string) {
  const segment = await prisma.segment.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!segment) throw new HttpError(404, "Segment not found.");
  return segment;
}

export async function updateSegment(actor: Actor, id: string, patch: { name?: unknown; filter?: unknown }) {
  const segment = await ownedSegment(actor, id);
  const data: { name?: string; filter?: Prisma.InputJsonObject } = {};
  if (patch.name !== undefined) {
    data.name = cleanName(patch.name);
    if (data.name !== segment.name && (await prisma.segment.findFirst({ where: { tenantId: actor.tenantId, name: data.name }, select: { id: true } }))) {
      throw new HttpError(409, "You already have a segment with this name.");
    }
  }
  if (patch.filter !== undefined) {
    const filter = parseFilter(patch.filter);
    if (isEmptyFilter(filter)) throw new HttpError(400, "Add at least one filter.");
    data.filter = filter as Prisma.InputJsonObject;
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to update.");
  const { count } = await prisma.segment.updateMany({ where: { id: segment.id, tenantId: actor.tenantId }, data });
  if (count === 0) throw new HttpError(404, "Segment not found.");
  return prisma.segment.findFirstOrThrow({ where: { id: segment.id, tenantId: actor.tenantId } });
}

const OPEN_STATUSES = ["draft", "scheduled", "sending", "paused"] as const;

export async function deleteSegment(actor: Actor, id: string) {
  const segment = await ownedSegment(actor, id);
  const inUse = await prisma.broadcast.count({
    where: { tenantId: actor.tenantId, status: { in: [...OPEN_STATUSES] }, audienceFilter: { path: ["segmentId"], equals: segment.id } },
  });
  if (inUse > 0) throw new HttpError(409, `${inUse === 1 ? "A broadcast that has not finished uses" : `${inUse} broadcasts that have not finished use`} this segment. Finish or cancel ${inUse === 1 ? "it" : "them"} first.`);
  await prisma.segment.deleteMany({ where: { id: segment.id, tenantId: actor.tenantId } });
}

/* ---------- resolving and evaluating an audience ---------- */

/** The filters an audience spec stands for: the chosen segment first, then the extra filter stack. All must hold. */
export async function resolveFilters(tenantId: string, spec: AudienceSpec | null | undefined): Promise<Filter[]> {
  const out: Filter[] = [];
  if (spec?.segmentId) {
    if (spec.segmentId.startsWith(PRESET_PREFIX)) {
      const preset = findPreset(spec.segmentId);
      if (!preset) throw new HttpError(404, "Segment not found.");
      out.push(preset.filter);
    } else {
      const segment = await prisma.segment.findFirst({ where: { id: spec.segmentId, tenantId }, select: { filter: true } });
      if (!segment) throw new HttpError(404, "Segment not found.");
      out.push(parseFilter(segment.filter));
    }
  }
  if (spec?.filter) out.push(parseFilter(spec.filter));
  return out.filter((f) => !isEmptyFilter(f));
}

/** Reads the audience spec stored on a broadcast (Broadcast.audienceFilter). Never throws on malformed JSON. */
export function specFromJson(raw: unknown): AudienceSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { segmentId, filter } = raw as { segmentId?: unknown; filter?: unknown };
  const spec: AudienceSpec = {};
  if (typeof segmentId === "string" && segmentId) spec.segmentId = segmentId;
  try {
    const parsed = parseFilter(filter);
    if (!isEmptyFilter(parsed)) spec.filter = parsed;
  } catch {
    /* a broken stored filter simply narrows nothing */
  }
  return spec;
}

export function whereForFilters(filters: Filter[], now = new Date()): Prisma.ContactWhereInput {
  const parts = filters.map((f) => filterToWhere(f, now)).filter((w) => Object.keys(w).length > 0);
  return parts.length ? { AND: parts } : {};
}

const combine = (...parts: Prisma.ContactWhereInput[]): Prisma.ContactWhereInput => {
  const real = parts.filter((p) => Object.keys(p).length > 0);
  return real.length === 1 ? real[0] : { AND: real };
};

type ScanRow = Omit<ContactSnapshot, "lastInboundAt"> & { id: string; conversations?: { lastInboundAt: Date | null }[] };

function snapshotOf(row: ScanRow): ContactSnapshot {
  const times = (row.conversations ?? []).map((c) => c.lastInboundAt?.getTime() ?? 0).filter(Boolean);
  return { ...row, lastInboundAt: times.length ? new Date(Math.max(...times)) : null };
}

type ScanOptions = { allowPartial?: boolean };

/**
 * Anything that sends to, counts or prices an audience must see all of it. When a rule on attributes would have to look at more than
 * MAX_SCAN contacts the answer is incomplete, so those callers stop with a clear message instead of using a partial list. Previews, lists and
 * samples say "partial" and carry on (`allowPartial`).
 */
function assertComplete(scanResult: { truncated: boolean }, opts: ScanOptions): void {
  if (scanResult.truncated && !opts.allowPartial) {
    throw new HttpError(422, `These rules would need to check more than ${MAX_SCAN.toLocaleString()} contacts, which is too many to do reliably. Narrow the audience first, for example with a tag or a second rule.`);
  }
}

/** Walks contacts that pass the SQL pre-filter and keeps those the whole filter list accepts. Stops at `limit` hits. */
async function scan(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], limit: number, now: Date) {
  const pre = combine(base, ...filters.map((f) => prefilterWhere(f, now)));
  const withInbound = filters.some(usesLastInbound);
  const hits: Sample[] = [];
  let seen = 0;
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = (await prisma.contact.findMany({
      where: { tenantId, ...pre },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, username: true, ...SNAPSHOT_SELECT, ...(withInbound ? { conversations: { select: { lastInboundAt: true } } } : {}) },
    })) as ScanRow[];
    for (const row of rows) {
      const snap = snapshotOf(row);
      if (!filters.every((f) => filterMatches(snap, f, now))) continue;
      total++;
      if (hits.length < limit) hits.push({ id: row.id, name: row.name, phone: row.phone, bsuid: row.bsuid ?? null, username: (row as { username?: string | null }).username ?? null });
    }
    seen += rows.length;
    if (rows.length < PAGE) return { hits, total, truncated: false };
    if (seen >= MAX_SCAN) return { hits, total, truncated: true };
    cursor = rows[rows.length - 1].id;
  }
}

/** Contact ids matching `base` AND every filter. `base` carries the opt-in rules; it must already include the tenant. */
export async function matchingContactIds(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], now = new Date(), opts: ScanOptions = {}): Promise<string[]> {
  if (!filters.some(usesAttributes)) {
    const rows = await prisma.contact.findMany({ where: combine(base, whereForFilters(filters, now)), select: { id: true } });
    return rows.map((r) => r.id);
  }
  const result = await scan(tenantId, base, filters, Number.MAX_SAFE_INTEGER, now);
  assertComplete(result, opts);
  return result.hits.map((h) => h.id);
}

export async function countMatching(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], now = new Date(), opts: ScanOptions = {}): Promise<number> {
  if (!filters.some(usesAttributes)) return prisma.contact.count({ where: combine(base, whereForFilters(filters, now)) });
  const result = await scan(tenantId, base, filters, 0, now);
  assertComplete(result, opts);
  return result.total;
}

export async function previewMatching(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], now = new Date()): Promise<Preview> {
  if (!filters.some(usesAttributes)) {
    const where = combine(base, whereForFilters(filters, now));
    const [count, sample] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({ where, orderBy: { createdAt: "desc" }, take: SAMPLE, select: { id: true, name: true, phone: true, bsuid: true, username: true } }),
    ]);
    return { count, sample, truncated: false };
  }
  const { hits, total, truncated } = await scan(tenantId, base, filters, SAMPLE, now);
  return { count: total, sample: hits, truncated };
}

/** Segment preview for the editor: how many contacts match, and how many of those can receive marketing messages. */
export async function previewSegmentFilter(actor: Actor, spec: AudienceSpec) {
  const filters = await resolveFilters(actor.tenantId, spec);
  const base: Prisma.ContactWhereInput = { tenantId: actor.tenantId };
  const eligible: Prisma.ContactWhereInput = { tenantId: actor.tenantId, optIn: true, optedOutAt: null, ...NOT_BLOCKED };
  const [all, ok] = await Promise.all([previewMatching(actor.tenantId, base, filters), countMatching(actor.tenantId, eligible, filters, new Date(), { allowPartial: true })]);
  return { count: all.count, eligible: ok, sample: all.sample, truncated: all.truncated };
}

/** The distinct attribute keys used by this workspace's contacts (first few thousand), for pickers. */
export async function knownAttributeKeys(tenantId: string, limit = 3000): Promise<string[]> {
  const rows = await prisma.contact.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: limit, select: { attributes: true } });
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.attributes && typeof r.attributes === "object" && !Array.isArray(r.attributes)) for (const k of Object.keys(r.attributes)) if (k.length <= 60) keys.add(k);
  }
  return [...keys].sort().slice(0, 200);
}

/** One phone-like string per matching contact (the phone, or a country probe for BSUID-only contacts), for per-country cost estimates and coverage checks. */
export async function matchingPhones(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], now = new Date(), opts: ScanOptions = {}): Promise<string[]> {
  if (!filters.some(usesAttributes)) {
    const rows = await prisma.contact.findMany({ where: combine(base, whereForFilters(filters, now)), select: { phone: true, bsuid: true } });
    return rows.map(countryProbe);
  }
  const result = await scan(tenantId, base, filters, Number.MAX_SAFE_INTEGER, now);
  assertComplete(result, opts);
  return result.hits.map(countryProbe);
}

/** Name and attributes of up to `limit` matching contacts, to test how well a value mapping fills in. */
export async function matchingContactsForMapping(tenantId: string, base: Prisma.ContactWhereInput, filters: Filter[], limit: number, now = new Date()) {
  const ids = await matchingContactIds(tenantId, base, filters, now, { allowPartial: true });
  const picked = ids.slice(0, limit);
  if (picked.length === 0) return { total: ids.length, contacts: [] as { name: string | null; phone: string; attributes: unknown }[] };
  const contacts = await prisma.contact.findMany({ where: { tenantId, id: { in: picked } }, select: { name: true, phone: true, attributes: true } });
  return { total: ids.length, contacts };
}

const LIST_ID_CAP = 10_000;

/** A `where` for the contacts list restricted to one segment (saved or preset). Segments that use attributes list their first 10,000 matches. */
export async function contactWhereForSegment(tenantId: string, segmentId: string, now = new Date()): Promise<Prisma.ContactWhereInput> {
  const filters = await resolveFilters(tenantId, { segmentId });
  if (!filters.some(usesAttributes)) return whereForFilters(filters, now);
  const ids = await matchingContactIds(tenantId, { tenantId }, filters, now, { allowPartial: true });
  return { id: { in: ids.slice(0, LIST_ID_CAP) } };
}
