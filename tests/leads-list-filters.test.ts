import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Leads list and export (docs/IG-PAGE-ADS-SPEC.md 3.10, 3.11, D33, PRM-10): GET /api/leads and /api/leads/export accept the
 * source, platform and test filters, each item carries source, platform, isOrganic, isTest and adsetMetaId, and the CSV gains the
 * columns source, platform and test at the end. The routes run against an in-memory database that applies Prisma's where clauses,
 * so the filters are checked by what they return.
 */

type Row = Record<string, any>;

const mem = vi.hoisted(() => {
  type R = Record<string, any>;
  const tables: Record<string, R[]> = {};
  const t = (name: string) => (tables[name] ??= []);
  const isPlain = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const OPS = new Set(["in", "not", "gte", "gt", "lte", "lt", "startsWith"]);
  function cond(row: R, key: string, c: unknown): boolean {
    const value = row[key];
    if (c === null) return value === null || value === undefined;
    if (c instanceof Date) return num(value) === c.getTime();
    if (isPlain(c) && Object.keys(c).every((k) => OPS.has(k))) {
      return Object.entries(c).every(([op, arg]) => {
        if (op === "in") return (arg as unknown[]).includes(value);
        if (op === "not") return !cond(row, key, arg);
        if (op === "startsWith") return typeof value === "string" && value.startsWith(arg as string);
        if (value === null || value === undefined) return false;
        const a = num(value) as number;
        const b = num(arg) as number;
        return op === "gte" ? a >= b : op === "gt" ? a > b : op === "lte" ? a <= b : a < b;
      });
    }
    return num(value) === num(c);
  }
  function matches(row: R, where: R = {}): boolean {
    return Object.entries(where).every(([k, v]) =>
      k === "OR" ? (v as R[]).some((w) => matches(row, w)) : k === "AND" ? (v as R[]).every((w) => matches(row, w)) : k === "NOT" ? !matches(row, v as R) : cond(row, k, v),
    );
  }
  const pick = (row: R, select?: R) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });
  type Args = { where?: R; select?: R; orderBy?: R | R[]; take?: number };
  const calls: R[] = [];
  const delegate = (name: string) => ({
    findMany: async (args: Args = {}) => {
      if (name === "lead") calls.push(args);
      const rows = t(name).filter((r) => matches(r, args.where)).sort((a, b) => num(b.createdAt) as number - (num(a.createdAt) as number));
      return rows.slice(0, args.take ?? Infinity).map((r) => pick(r, args.select));
    },
    findFirst: async (args: Args = {}) => t(name).find((r) => matches(r, args.where)) ?? null,
  });
  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  const prisma = new Proxy({} as R, { get: (_t, prop: string) => (prop === "then" ? undefined : (delegates[prop] ??= delegate(prop))) });
  return {
    prisma,
    calls,
    seed: (name: string, rows: R[]) => void t(name).push(...rows),
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      calls.length = 0;
    },
  };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));

import { filtersFrom, PLATFORM_NOT_REPORTED } from "@/app/api/leads/filters";
import { GET as exportRoute } from "@/app/api/leads/export/route";
import { GET as listRoute } from "@/app/api/leads/route";
import { LEAD_PLATFORMS, LEAD_SOURCES } from "@/lib/leads/ingest";

const ORIGIN = "https://wa.edwyz.com";
const base = Date.parse("2026-10-30T10:00:00Z");
let n = 0;
const lead = (over: Row): Row => {
  n++;
  return {
    id: `l${n}`,
    tenantId: "t1",
    leadgenId: `${9000 + n}`,
    leadFormId: null,
    contactId: null,
    fields: { full_name: `Person ${n}` },
    campaignMetaId: "camp_1",
    adMetaId: "ad_1",
    adsetMetaId: null,
    consentText: null,
    consentAt: null,
    status: "new",
    assignedToId: null,
    firstResponseAt: null,
    createdAt: new Date(base - n * 60_000),
    source: "instant_form",
    platform: null,
    isOrganic: null,
    isTest: false,
    ...over,
  };
};

const list = async (query: string) => {
  const res = await listRoute(new Request(`${ORIGIN}/api/leads${query}`));
  return { status: res.status, body: (await res.json()) as { items: Row[]; error?: string } };
};
const ids = async (query: string) => (await list(query)).body.items.map((i) => i.id);

beforeEach(() => {
  mem.reset();
  n = 0;
  auth.role = "admin";
  mem.seed("lead", [
    lead({ id: "ig", platform: "instagram", isOrganic: false, adsetMetaId: "238500000201" }),
    lead({ id: "fb", platform: "facebook", isOrganic: true }),
    lead({ id: "none" }),
    lead({ id: "test", platform: "facebook", isTest: true }),
    lead({ id: "ctwa_new", leadgenId: "ctwa:wamid.A1", source: "ctwa" }),
    // A chat lead stored before Lead.source existed keeps the column's default; its leadgenId says ctwa.
    lead({ id: "ctwa_old", leadgenId: "ctwa:AR-click-1" }),
    lead({ id: "manual", source: "manual" }),
    lead({ id: "other", tenantId: "t2", platform: "instagram", isTest: true }),
  ]);
});

describe("GET /api/leads filters (source, platform, test)", () => {
  it("source picks the leads of one source, counting old chat leads as ctwa and never as instant_form", async () => {
    expect(await ids("?source=ctwa")).toEqual(["ctwa_new", "ctwa_old"]);
    expect(await ids("?source=instant_form")).toEqual(["ig", "fb", "none", "test"]);
    expect(await ids("?source=manual")).toEqual(["manual"]);
    expect(await ids("?source=ctig")).toEqual([]);
    // The name the list used for form leads before Lead.source existed still works.
    expect(await ids("?source=meta_lead_form")).toEqual(["ig", "fb", "none", "test"]);
  });

  it("platform picks Instagram or Facebook leads, and not_reported the ones Meta gave no platform for", async () => {
    expect(await ids("?platform=instagram")).toEqual(["ig"]);
    expect(await ids("?platform=facebook")).toEqual(["fb", "test"]);
    expect(await ids(`?platform=${PLATFORM_NOT_REPORTED}`)).toEqual(["none", "ctwa_new", "ctwa_old", "manual"]);
  });

  it("test=true lists only test leads and test=false hides them; both are listed by default", async () => {
    expect(await ids("?test=true")).toEqual(["test"]);
    expect(await ids("?test=false")).toEqual(["ig", "fb", "none", "ctwa_new", "ctwa_old", "manual"]);
    expect(await ids("?test=1")).toEqual(["test"]);
    expect(await ids("")).toHaveLength(7);
  });

  it("filters combine with each other and with the old ones, always inside the workspace", async () => {
    expect(await ids("?source=instant_form&platform=facebook&test=false")).toEqual(["fb"]);
    expect(await ids("?platform=instagram&test=true")).toEqual([]);
    expect(await ids("?status=new&source=ctwa&campaign=camp_1")).toEqual(["ctwa_new", "ctwa_old"]);
    expect(mem.calls.every((c) => c.where.tenantId === "t1")).toBe(true);
  });

  it("answers 400 in plain words for an unknown source, platform or test value", async () => {
    expect(await list("?source=tiktok")).toEqual({ status: 400, body: { error: "source must be one of instant_form, ctwa, ctig, ctm, manual." } });
    expect(await list("?platform=myspace")).toEqual({ status: 400, body: { error: "platform must be one of facebook, instagram, messenger, whatsapp, audience_network, unknown, not_reported." } });
    expect(await list("?test=maybe")).toEqual({ status: 400, body: { error: "test must be true or false." } });
    expect(mem.calls).toEqual([]);
  });

  it("each item carries source, platform, isOrganic, isTest and adsetMetaId", async () => {
    const { body } = await list("");
    const by = Object.fromEntries(body.items.map((i) => [i.id, i]));
    expect(by.ig).toMatchObject({ source: "instant_form", platform: "instagram", isOrganic: false, isTest: false, adsetMetaId: "238500000201", adMetaId: "ad_1" });
    expect(by.fb).toMatchObject({ platform: "facebook", isOrganic: true, adsetMetaId: null });
    expect(by.none).toMatchObject({ platform: null, isOrganic: null });
    expect(by.test).toMatchObject({ isTest: true });
    expect(by.ctwa_new.source).toBe("ctwa");
    expect(by.ctwa_old.source).toBe("ctwa");
    expect(by.manual.source).toBe("manual");
  });

  it("filtersFrom accepts every Lead.source and Lead.platform value the database allows", () => {
    for (const source of LEAD_SOURCES) expect(filtersFrom(new URLSearchParams({ source })).source).toBe(source);
    for (const platform of [...LEAD_PLATFORMS, PLATFORM_NOT_REPORTED]) expect(filtersFrom(new URLSearchParams({ platform })).platform).toBe(platform);
    expect(filtersFrom(new URLSearchParams({ test: "false" })).test).toBe(false);
    expect(filtersFrom(new URLSearchParams({ status: "new" }))).toEqual({ status: "new", formId: undefined, campaign: undefined, assignedToId: undefined, from: undefined, to: undefined });
  });
});

describe("GET /api/leads/export", () => {
  const csv = async (query = "") => {
    const res = await exportRoute(new Request(`${ORIGIN}/api/leads/export${query}`));
    return { status: res.status, text: await res.text() };
  };
  const parse = (text: string) => text.replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(","));

  it("adds the columns source, platform and test at the end, so the columns before them keep their places", async () => {
    const { status, text } = await csv();
    expect(status).toBe(200);
    const [header, ...rows] = parse(text);
    expect(header).toEqual(["created_at", "status", "name", "email", "phone", "form", "campaign_id", "ad_id", "first_response_at", "response_seconds", "opted_in", "consent_at", "source", "platform", "test"]);
    expect(text).toContain("created_at,status,name,email,phone,form");
    const byName = Object.fromEntries(rows.map((r) => [r[2], r.slice(-3)]));
    expect(byName["Person 1"]).toEqual(["instant_form", "instagram", "no"]);
    expect(byName["Person 3"]).toEqual(["instant_form", "", "no"]);
    expect(byName["Person 4"]).toEqual(["instant_form", "facebook", "yes"]);
    expect(byName["Person 6"]).toEqual(["ctwa", "", "no"]);
  });

  it("uses the same filters as the list, and stays admin only", async () => {
    const [, ...rows] = parse((await csv("?test=true")).text);
    expect(rows.map((r) => r[2])).toEqual(["Person 4"]);
    const [, ...igRows] = parse((await csv("?platform=instagram&source=instant_form")).text);
    expect(igRows.map((r) => r[2])).toEqual(["Person 1"]);
    expect((await csv("?platform=myspace")).status).toBe(400);
    auth.role = "agent";
    expect((await csv()).status).toBe(403);
  });
});
