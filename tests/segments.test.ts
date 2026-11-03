import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  segment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  contact: { findMany: vi.fn(), count: vi.fn() },
  broadcast: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import {
  type Condition,
  type ContactSnapshot,
  conditionMatches,
  conditionWhere,
  describeCondition,
  filterMatches,
  filterToWhere,
  opsFor,
  parseFilter,
  prefilterWhere,
  usesAttributes,
} from "@/lib/segments/filter";
import { findPreset, presetSegments } from "@/lib/segments/presets";
import {
  MAX_SEGMENTS,
  contactWhereForSegment,
  countMatching,
  createSegment,
  deleteSegment,
  listSegments,
  matchingContactIds,
  previewSegmentFilter,
  resolveFilters,
  specFromJson,
  updateSegment,
} from "@/lib/segments/service";

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
const now = new Date("2026-03-01T12:00:00Z");
const day = 86_400_000;

const contact = (over: Partial<ContactSnapshot> = {}): ContactSnapshot => ({
  name: "Asha Rao",
  phone: "+919876543210",
  tags: ["vip"],
  attributes: { city: "Pune", orders: 5, plan: "Gold" },
  optInSource: "website",
  optInAt: new Date(now.getTime() - 10 * day),
  createdAt: new Date(now.getTime() - 40 * day),
  leadStage: null,
  ownerUserId: null,
  lastInboundAt: new Date(now.getTime() - 5 * day),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("parseFilter", () => {
  it("accepts all/any groups and trims values", () => {
    const f = parseFilter({ all: [{ field: "tag", op: "has", value: " vip " }], any: [{ field: "attr:city", op: "is", value: "Pune" }] });
    expect(f.all?.[0]).toEqual({ field: "tag", op: "has", value: "vip" });
    expect(f.any).toHaveLength(1);
  });
  it("treats empty input as an empty filter", () => {
    expect(parseFilter(undefined)).toEqual({});
    expect(parseFilter({ all: [] })).toEqual({});
  });
  it.each([
    [{ all: [{ field: "nope", op: "is", value: "x" }] }, /field we do not know/],
    [{ all: [{ field: "tag", op: "contains", value: "x" }] }, /does not fit its field/],
    [{ all: [{ field: "name", op: "is" }] }, /Fill in the value/],
    [{ all: [{ field: "createdAt", op: "within_days", value: "abc" }] }, /whole number/],
    [{ all: [{ field: "createdAt", op: "before", value: "not a date" }] }, /Dates must look like/],
    [{ all: [{ field: "attr:orders", op: "greater_than", value: "lots" }] }, /number/],
    [{ all: [{ field: "country", op: "is", value: "ZZ" }] }, /country code/],
    [{ all: [{ field: "attr:bad/key", op: "is", value: "x" }] }, /field we do not know/],
    [{ all: "x" }, /list of filters/],
    [[], /not valid/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseFilter(raw)).toThrow(message);
  });
  it("limits the number of filters", () => {
    const all = Array.from({ length: 21 }, () => ({ field: "tag", op: "has", value: "a" }));
    expect(() => parseFilter({ all })).toThrow(/at most 20/);
  });
  it("offers only sensible tests per field", () => {
    expect(opsFor("tag")).toEqual(["has", "not_has"]);
    expect(opsFor("attr:city")).toContain("greater_than");
    expect(opsFor("lastInbound")).toContain("never");
  });
});

describe("matching a contact in code", () => {
  it("evaluates attribute conditions case-insensitively and numerically", () => {
    expect(conditionMatches(contact(), { field: "attr:city", op: "is", value: "pune" })).toBe(true);
    expect(conditionMatches(contact(), { field: "attr:orders", op: "greater_than", value: "3" })).toBe(true);
    expect(conditionMatches(contact(), { field: "attr:orders", op: "less_than", value: "3" })).toBe(false);
    expect(conditionMatches(contact(), { field: "attr:missing", op: "not_exists" })).toBe(true);
    expect(conditionMatches(contact(), { field: "attr:missing", op: "is_not", value: "x" })).toBe(true);
  });
  it("reads a NULL tags column as no tags, and every negative attribute test holds for a missing attribute", () => {
    const bare = contact({ tags: null as unknown as string[], attributes: {} });
    expect(conditionMatches(bare, { field: "tag", op: "not_has", value: "vip" })).toBe(true);
    expect(conditionMatches(bare, { field: "tag", op: "has", value: "vip" })).toBe(false);
    for (const op of ["is_not", "not_contains"] as const) expect(conditionMatches(bare, { field: "attr:city", op, value: "Pune" }), op).toBe(true);
    expect(conditionMatches(bare, { field: "attr:city", op: "not_exists" })).toBe(true);
  });
  it("evaluates tags, country, dates and last message", () => {
    expect(conditionMatches(contact(), { field: "tag", op: "has", value: "vip" })).toBe(true);
    expect(conditionMatches(contact(), { field: "tag", op: "not_has", value: "vip" })).toBe(false);
    expect(conditionMatches(contact(), { field: "country", op: "is", value: "IN" })).toBe(true);
    expect(conditionMatches(contact(), { field: "country", op: "is_not", value: "US" })).toBe(true);
    expect(conditionMatches(contact(), { field: "createdAt", op: "older_than_days", value: "30" }, now)).toBe(true);
    expect(conditionMatches(contact(), { field: "createdAt", op: "within_days", value: "30" }, now)).toBe(false);
    expect(conditionMatches(contact(), { field: "lastInbound", op: "within_days", value: "7" }, now)).toBe(true);
    expect(conditionMatches(contact({ lastInboundAt: null }), { field: "lastInbound", op: "never" }, now)).toBe(true);
    expect(conditionMatches(contact({ lastInboundAt: null }), { field: "lastInbound", op: "older_than_days", value: "90" }, now)).toBe(true);
  });
  it("needs every all-condition and at least one any-condition", () => {
    const f = parseFilter({
      all: [{ field: "tag", op: "has", value: "vip" }],
      any: [
        { field: "attr:city", op: "is", value: "Delhi" },
        { field: "attr:plan", op: "is", value: "Gold" },
      ],
    });
    expect(filterMatches(contact(), f, now)).toBe(true);
    expect(filterMatches(contact({ attributes: { plan: "Free", city: "Pune" } }), f, now)).toBe(false);
    expect(filterMatches(contact({ tags: [] }), f, now)).toBe(false);
    expect(filterMatches(contact(), {}, now)).toBe(true);
  });
  it("describes a condition in plain words", () => {
    expect(describeCondition({ field: "attr:city", op: "is", value: "Pune" })).toBe("city is Pune");
    expect(describeCondition({ field: "tag", op: "has", value: "vip" })).toBe("Tag is tagged vip");
    expect(describeCondition({ field: "name", op: "not_exists" })).toBe("Name is empty");
  });
});

describe("filter to SQL", () => {
  it("builds tag and AND/OR where clauses", () => {
    expect(conditionWhere({ field: "tag", op: "has", value: "vip" })).toEqual({ tags: { has: "vip" } });
    const where = filterToWhere(
      parseFilter({
        all: [{ field: "tag", op: "has", value: "a" }],
        any: [
          { field: "name", op: "contains", value: "b" },
          { field: "tag", op: "has", value: "c" },
        ],
      }),
    );
    expect(where).toEqual({
      AND: [{ tags: { has: "a" } }, { OR: [{ name: { contains: "b", mode: "insensitive" } }, { tags: { has: "c" } }] }],
    });
  });
  it("turns a country into calling-code prefixes", () => {
    expect(conditionWhere({ field: "country", op: "is", value: "IN" })).toEqual({
      OR: [{ phone: { startsWith: "+91" } }, { AND: [{ phone: null }, { bsuid: { startsWith: "IN.", mode: "insensitive" } }] }],
    });
  });
  it("keeps contacts whose tags column is NULL in 'is not tagged'", () => {
    expect(conditionWhere({ field: "tag", op: "not_has", value: "vip" })).toEqual({ OR: [{ tags: { equals: null } }, { NOT: { tags: { has: "vip" } } }] });
  });
  it("keeps the NULL-safe tag test when it only narrows an attribute scan", () => {
    const f = parseFilter({ all: [{ field: "tag", op: "not_has", value: "vip" }, { field: "attr:city", op: "is", value: "Pune" }] });
    expect(prefilterWhere(f)).toEqual({ AND: [{ OR: [{ tags: { equals: null } }, { NOT: { tags: { has: "vip" } } }] }] });
  });
  it("pre-filters a scan only on plain all-conditions", () => {
    const f = parseFilter({
      all: [
        { field: "tag", op: "has", value: "a" },
        { field: "attr:city", op: "is", value: "Pune" },
      ],
    });
    expect(usesAttributes(f)).toBe(true);
    expect(prefilterWhere(f)).toEqual({ AND: [{ tags: { has: "a" } }] });
    expect(() => filterToWhere(f)).toThrow();
  });
});

/*
 * A tiny reader of the Prisma where clauses filter.ts builds, with SQL's three-valued logic: a comparison with a NULL
 * column is unknown (null), NOT unknown stays unknown, and only rows that come out true are returned. This is what made
 * NOT { tags: { has } } drop every contact whose tags column is NULL.
 */
type Row = { name: string | null; phone: string | null; bsuid: string | null; tags: string[] | null; optInSource: string | null; leadStage: string | null; ownerUserId: string | null; createdAt: Date; optInAt: Date | null; conversations: { lastInboundAt: Date | null }[] };
type Tri = boolean | null;
const and3 = (xs: Tri[]): Tri => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or3 = (xs: Tri[]): Tri => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const not3 = (x: Tri): Tri => (x === null ? null : !x);

function fieldTest(key: string, value: unknown, test: unknown): Tri {
  if (test === null) return value === null;
  if (typeof test !== "object" || test instanceof Date) return value === null ? null : value === test;
  const t = test as Record<string, unknown>;
  if (key === "tags") {
    if ("equals" in t && t.equals === null) return value === null;
    if (value === null) return null;
    return (value as string[]).includes(t.has as string);
  }
  if ("not" in t && t.not === null) return value !== null;
  if (value === null) return null;
  const ci = (s: unknown) => (t.mode === "insensitive" ? String(s).toLowerCase() : String(s));
  if ("equals" in t) return ci(value) === ci(t.equals);
  if ("contains" in t) return ci(value).includes(ci(t.contains));
  if ("startsWith" in t) return ci(value).startsWith(ci(t.startsWith));
  const time = (value as Date).getTime();
  if ("lt" in t) return time < (t.lt as Date).getTime();
  if ("gt" in t) return time > (t.gt as Date).getTime();
  if ("gte" in t) return time >= (t.gte as Date).getTime();
  throw new Error(`untested where: ${JSON.stringify(test)}`);
}

function sqlMatches(row: Row, where: Record<string, unknown>): Tri {
  return and3(
    Object.entries(where).map(([key, test]): Tri => {
      if (key === "AND") return and3((test as Record<string, unknown>[]).map((w) => sqlMatches(row, w)));
      if (key === "OR") return or3((test as Record<string, unknown>[]).map((w) => sqlMatches(row, w)));
      if (key === "NOT") return not3(sqlMatches(row, test as Record<string, unknown>));
      if (key === "conversations") {
        const { some, none } = test as { some?: Record<string, unknown>; none?: Record<string, unknown> };
        const hit = row.conversations.some((cv) => sqlMatches({ ...row, ...cv } as Row, (some ?? none)!) === true);
        return some ? hit : !hit;
      }
      return fieldTest(key, row[key as keyof Row] ?? null, test);
    }),
  );
}

describe("SQL and code give the same answer for negative rules, NULL columns included", () => {
  const base: Row = {
    name: "Asha Rao",
    phone: "+919876543210",
    bsuid: null,
    tags: ["vip"],
    optInSource: "website",
    leadStage: "Qualified",
    ownerUserId: "u1",
    createdAt: new Date(now.getTime() - 40 * day),
    optInAt: null,
    conversations: [{ lastInboundAt: new Date(now.getTime() - 5 * day) }],
  };
  const rows: Record<string, Row> = {
    "tagged vip": base,
    "other tags": { ...base, tags: ["wholesale"] },
    "empty tag list": { ...base, tags: [] },
    "NULL tags (inbound contact)": { ...base, tags: null, name: null, leadStage: null, ownerUserId: null, optInSource: null, conversations: [] },
    "no phone, BSUID only": { ...base, phone: null, bsuid: "IN.12345", tags: null },
    "blank lead stage": { ...base, leadStage: "" },
  };
  const snapshot = (r: Row): ContactSnapshot => ({ ...r, tags: r.tags ?? [], attributes: {}, lastInboundAt: r.conversations[0]?.lastInboundAt ?? null });
  const negative: { rule: Condition; matches: string[] }[] = [
    { rule: { field: "tag", op: "not_has", value: "vip" }, matches: ["other tags", "empty tag list", "NULL tags (inbound contact)", "no phone, BSUID only"] },
    { rule: { field: "name", op: "is_not", value: "Asha Rao" }, matches: ["NULL tags (inbound contact)"] },
    { rule: { field: "name", op: "not_contains", value: "zzz" }, matches: Object.keys(rows) },
    { rule: { field: "name", op: "not_exists" }, matches: ["NULL tags (inbound contact)"] },
    { rule: { field: "phone", op: "is_not", value: "+919876543210" }, matches: ["no phone, BSUID only"] },
    { rule: { field: "phone", op: "not_contains", value: "98765" }, matches: ["no phone, BSUID only"] },
    { rule: { field: "phone", op: "not_exists" }, matches: ["no phone, BSUID only"] },
    { rule: { field: "leadStage", op: "is_not", value: "qualified" }, matches: ["NULL tags (inbound contact)", "blank lead stage"] },
    { rule: { field: "leadStage", op: "not_exists" }, matches: ["NULL tags (inbound contact)", "blank lead stage"] },
    { rule: { field: "optInSource", op: "not_contains", value: "web" }, matches: ["NULL tags (inbound contact)"] },
    { rule: { field: "ownerUserId", op: "is_not", value: "u1" }, matches: ["NULL tags (inbound contact)"] },
    { rule: { field: "optInAt", op: "not_exists" }, matches: Object.keys(rows) },
    { rule: { field: "country", op: "is_not", value: "US" }, matches: Object.keys(rows) },
    { rule: { field: "country", op: "is_not", value: "IN" }, matches: [] },
    { rule: { field: "lastInbound", op: "never" }, matches: ["NULL tags (inbound contact)"] },
    { rule: { field: "lastInbound", op: "older_than_days", value: "30" }, matches: ["NULL tags (inbound contact)"] },
  ];

  it.each(negative)("$rule.field $rule.op $rule.value", ({ rule, matches }) => {
    const c = parseFilter({ all: [rule] }).all![0];
    for (const [label, row] of Object.entries(rows)) {
      const want = matches.includes(label);
      expect({ label, sql: sqlMatches(row, conditionWhere(c, now) as Record<string, unknown>) === true }).toEqual({ label, sql: want });
      expect({ label, code: conditionMatches(snapshot(row), c, now) }).toEqual({ label, code: want });
    }
  });
  it("counts the untagged contact for 'is not tagged' in both all and any mode", () => {
    const untagged = rows["NULL tags (inbound contact)"];
    const rule = { field: "tag", op: "not_has", value: "vip" };
    for (const f of [parseFilter({ all: [rule] }), parseFilter({ any: [rule, { field: "name", op: "is", value: "nobody" }] })]) {
      expect(sqlMatches(untagged, filterToWhere(f, now) as Record<string, unknown>)).toBe(true);
      expect(filterMatches(snapshot(untagged), f, now)).toBe(true);
    }
  });
});

describe("presets", () => {
  it("ships four named presets with valid filters", () => {
    expect(presetSegments().map((p) => p.name)).toEqual(["Recently active", "Win back", "At risk", "New this month"]);
    for (const p of presetSegments()) expect(() => parseFilter(p.filter)).not.toThrow();
    expect(findPreset("preset:winback")?.name).toBe("Win back");
  });
  it("win back matches 30 to 90 days since the last message", () => {
    const f = findPreset("preset:winback")!.filter;
    expect(filterMatches(contact({ lastInboundAt: new Date(now.getTime() - 60 * day) }), f, now)).toBe(true);
    expect(filterMatches(contact({ lastInboundAt: new Date(now.getTime() - 10 * day) }), f, now)).toBe(false);
    expect(filterMatches(contact({ lastInboundAt: null }), f, now)).toBe(false);
  });
});

describe("segment CRUD", () => {
  const filter = { all: [{ field: "tag", op: "has", value: "vip" }] };

  it("creates a segment for the actor's tenant", async () => {
    db.segment.count.mockResolvedValue(0);
    db.segment.findFirst.mockResolvedValue(null);
    db.segment.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "s1", ...data }));
    const s = await createSegment(actor, { name: "  VIPs ", filter });
    expect(db.segment.create).toHaveBeenCalledWith({ data: { tenantId: "t1", name: "VIPs", filter, createdByUserId: "u1" } });
    expect(s.id).toBe("s1");
  });
  it("refuses an empty filter, a blank name, a duplicate name and the segment cap", async () => {
    await expect(createSegment(actor, { name: "x", filter: {} })).rejects.toThrow(/at least one filter/);
    await expect(createSegment(actor, { name: " ", filter })).rejects.toThrow(/name/);
    db.segment.count.mockResolvedValue(0);
    db.segment.findFirst.mockResolvedValue({ id: "other" });
    await expect(createSegment(actor, { name: "VIPs", filter })).rejects.toThrow(/already have a segment/);
    db.segment.count.mockResolvedValue(MAX_SEGMENTS);
    db.segment.findFirst.mockResolvedValue(null);
    await expect(createSegment(actor, { name: "New", filter })).rejects.toThrow(/up to 50/);
  });
  it("updates only a segment of the tenant", async () => {
    db.segment.findFirst.mockResolvedValue(null);
    await expect(updateSegment(actor, "s9", { name: "x" })).rejects.toThrow(/not found/);
    expect(db.segment.findFirst).toHaveBeenCalledWith({ where: { id: "s9", tenantId: "t1" } });
    db.segment.findFirst.mockResolvedValue({ id: "s1", name: "Old" });
    db.segment.updateMany.mockResolvedValue({ count: 1 });
    db.segment.findFirstOrThrow.mockResolvedValue({ id: "s1", name: "New" });
    await updateSegment(actor, "s1", { filter });
    expect(db.segment.updateMany).toHaveBeenCalledWith({ where: { id: "s1", tenantId: "t1" }, data: { filter } });
    await expect(updateSegment(actor, "s1", {})).rejects.toThrow(/Nothing to update/);
  });
  it("will not delete a segment an unfinished broadcast still uses", async () => {
    db.segment.findFirst.mockResolvedValue({ id: "s1", name: "VIPs" });
    db.broadcast.count.mockResolvedValue(2);
    await expect(deleteSegment(actor, "s1")).rejects.toThrow(/2 broadcasts that have not finished/);
    expect(db.segment.deleteMany).not.toHaveBeenCalled();
    db.broadcast.count.mockResolvedValue(0);
    await deleteSegment(actor, "s1");
    expect(db.segment.deleteMany).toHaveBeenCalledWith({ where: { id: "s1", tenantId: "t1" } });
  });
  it("lists segments with presets, tags and attribute keys, all scoped to the tenant", async () => {
    db.segment.findMany.mockResolvedValue([{ id: "s1", name: "VIPs" }]);
    db.contact.findMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.attributes ? [{ attributes: { city: "Pune" } }, { attributes: { plan: "x" } }] : [{ tags: ["b", "a"] }, { tags: ["a"] }],
    );
    const out = await listSegments(actor);
    expect(out.attributeKeys).toEqual(["city", "plan"]);
    expect(out.tags).toEqual(["a", "b"]);
    expect(out.presets.length).toBe(4);
    expect(db.segment.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    for (const call of db.contact.findMany.mock.calls) expect(call[0].where.tenantId).toBe("t1");
  });
});

describe("resolving an audience", () => {
  it("combines a saved segment with an extra filter stack", async () => {
    db.segment.findFirst.mockResolvedValue({ filter: { all: [{ field: "tag", op: "has", value: "vip" }] } });
    const filters = await resolveFilters("t1", { segmentId: "seg1", filter: { all: [{ field: "attr:city", op: "is", value: "Pune" }] } });
    expect(filters).toHaveLength(2);
    expect(db.segment.findFirst).toHaveBeenCalledWith({ where: { id: "seg1", tenantId: "t1" }, select: { filter: true } });
  });
  it("404s for a segment of another tenant or an unknown preset", async () => {
    db.segment.findFirst.mockResolvedValue(null);
    await expect(resolveFilters("t1", { segmentId: "foreign" })).rejects.toThrow(/not found/);
    await expect(resolveFilters("t1", { segmentId: "preset:nope" })).rejects.toThrow(/not found/);
    expect(await resolveFilters("t1", { segmentId: "preset:at_risk" })).toHaveLength(1);
  });
  it("reads a stored audience leniently", () => {
    expect(specFromJson(null)).toEqual({});
    expect(specFromJson({ segmentId: "s1", filter: { all: [{ field: "bogus", op: "is", value: "1" }] } })).toEqual({ segmentId: "s1" });
    expect(specFromJson({ filter: { all: [{ field: "tag", op: "has", value: "a" }] } }).filter?.all).toHaveLength(1);
  });
});

describe("counting and previewing", () => {
  const base = { tenantId: "t1", optIn: true, optedOutAt: null };

  it("counts in SQL when no attribute is involved", async () => {
    db.contact.count.mockResolvedValue(7);
    const f = parseFilter({ all: [{ field: "tag", op: "has", value: "vip" }] });
    expect(await countMatching("t1", base, [f])).toBe(7);
    expect(db.contact.count).toHaveBeenCalledWith({ where: { AND: [base, { AND: [{ AND: [{ tags: { has: "vip" } }] }] }] } });
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });
  it("scans in code when an attribute is involved, still scoped to the tenant", async () => {
    db.contact.findMany.mockResolvedValue([
      { id: "c1", ...contact({ attributes: { city: "Pune" } }) },
      { id: "c2", ...contact({ attributes: { city: "Delhi" } }) },
    ]);
    const f = parseFilter({ all: [{ field: "attr:city", op: "is", value: "Pune" }] });
    expect(await matchingContactIds("t1", base, [f])).toEqual(["c1"]);
    expect(db.contact.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });
  it("previews how many match and how many can be messaged", async () => {
    db.contact.findMany.mockResolvedValue([{ ...contact(), id: "c1", name: "A", phone: "+911" }]);
    const out = await previewSegmentFilter(actor, { filter: parseFilter({ all: [{ field: "attr:plan", op: "is", value: "Gold" }] }) });
    expect(out.count).toBe(1);
    expect(out.eligible).toBe(1);
    expect(out.sample[0].id).toBe("c1");
    expect(out.truncated).toBe(false);
  });
  it("gives a where clause for one segment of the contacts list", async () => {
    const where = await contactWhereForSegment("t1", "preset:recent", now);
    expect(JSON.stringify(where)).toContain("lastInboundAt");
  });
});
