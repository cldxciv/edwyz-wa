import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lead backfill (docs/IG-PAGE-ADS-SPEC.md 3.11, 4.1, 4.2 L5 and L6, 4.9, 11.2 risk 16, PRM-10 acceptance 3): which forms are read
 * (the last-seen-running stamp, the end-date rule in the paged ad query, forms registered from an ad's Meta form id, fake ids
 * skipped), the reading order (every try recorded, failing forms never hold back healthy ones, the retry wait), the 26-hour window
 * and the 500-lead cap, the webhook and backfill race on one lead, the #100 capability fallback and its cache, the new Lead columns,
 * LeadForm.lastBackfillAt, the Lead Access Manager record (24 hours, read by the readiness facts) and priority-1 throttling. Meta is
 * a stub of graphFetchAs; the database is an in-memory stand-in with just enough of Prisma's where clauses for these modules.
 */

type Row = Record<string, any>;

const mem = vi.hoisted(() => {
  type R = Record<string, any>;
  const tables: Record<string, R[]> = {};
  let seq = 0;
  const t = (name: string) => (tables[name] ??= []);
  const isPlain = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
  const num = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const OPS = new Set(["in", "not", "gte", "gt", "lte", "lt", "startsWith", "none", "some"]);
  const UNIQUE: Record<string, string[][]> = { lead: [["tenantId", "leadgenId"]], leadSequenceRun: [["sequenceId", "leadId"]], platformSetting: [["key"]], leadForm: [["tenantId", "metaFormId"]], contact: [["tenantId", "phone"]] };
  const RELATIONS: Record<string, Record<string, (row: R) => R[]>> = { lead: { runs: (row) => t("leadSequenceRun").filter((r) => r.leadId === row.id) } };
  const flat = (where: R = {}) => {
    const out: R = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && isPlain(v) && Object.keys(v).every((p) => k.split("_").includes(p))) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  };
  function cond(table: string, row: R, key: string, c: unknown): boolean {
    const value = row[key];
    if (c === null) return value === null || value === undefined;
    if (c instanceof Date) return num(value) === c.getTime();
    if (isPlain(c)) {
      const keys = Object.keys(c);
      if (keys.length > 0 && keys.every((k) => OPS.has(k))) {
        return keys.every((op) => {
          const arg = c[op];
          if (op === "in") return (arg as unknown[]).includes(value);
          if (op === "not") return !cond(table, row, key, arg);
          if (op === "startsWith") return typeof value === "string" && value.startsWith(arg as string);
          if (op === "none" || op === "some") {
            const related = (RELATIONS[table]?.[key]?.(row) ?? []).some((r) => matches(key, r, arg as R));
            return op === "none" ? !related : related;
          }
          if (value === null || value === undefined) return false;
          const a = num(value) as number;
          const b = num(arg) as number;
          return op === "gte" ? a >= b : op === "gt" ? a > b : op === "lte" ? a <= b : a < b;
        });
      }
      return isPlain(value) && matches(key, value, c);
    }
    return num(value) === num(c);
  }
  function matches(table: string, row: R, where?: R): boolean {
    return Object.entries(flat(where)).every(([k, v]) =>
      k === "OR" ? (v as R[]).some((w) => matches(table, row, w)) : k === "AND" ? (v as R[]).every((w) => matches(table, row, w)) : k === "NOT" ? !matches(table, row, v as R) : cond(table, row, k, v),
    );
  }
  const pick = (row: R, select?: R): R => {
    if (!select) return { ...row };
    const out: R = {};
    for (const [k, s] of Object.entries(select)) if (s) out[k] = isPlain(s) && isPlain(row[k]) ? pick(row[k], s.select as R | undefined) : row[k];
    return out;
  };
  const order = (rows: R[], orderBy?: R | R[]) => {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((x, y) => {
      for (const o of list) {
        const [k, dir] = Object.entries(o)[0] as [string, "asc" | "desc"];
        const a = num(x[k]) as number;
        const b = num(y[k]) as number;
        if (a !== b) return (a < b ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  const defaults: Record<string, () => R> = {
    lead: () => ({ id: `lead_${++seq}`, status: "new", assignedToId: null, firstResponseAt: null, createdAt: new Date(), source: "instant_form", platform: null, isOrganic: null, isTest: false, adsetMetaId: null, consentAt: null, consentText: null }),
    leadForm: () => ({ id: `form_${++seq}`, origin: "registered", status: "active", name: null, consentText: null, spec: null, lastBackfillAt: null, hiddenAt: null, createdAt: new Date() }),
    contact: () => ({ id: `contact_${++seq}`, optIn: false, optedOutAt: null, tags: [], attributes: {}, name: null }),
    leadSequenceRun: () => ({ id: `run_${++seq}`, status: "active", stepIndex: 0, createdAt: new Date() }),
  };
  const stamp = (name: string, row: R) => {
    if (name === "platformSetting") row.updatedAt = new Date();
    return row;
  };
  const unique = (name: string, row: R) => {
    for (const cols of UNIQUE[name] ?? []) {
      if (t(name).some((r) => r !== row && cols.every((c) => r[c] !== undefined && r[c] !== null && r[c] === row[c]))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
  };
  type Args = { where?: R; select?: R; orderBy?: R | R[]; take?: number; data?: R; create?: R; update?: R };
  const delegate = (name: string) => {
    const find = async ({ where, select, orderBy, take }: Args = {}) => order(t(name).filter((r) => matches(name, r, where)), orderBy).slice(0, take ?? Infinity).map((r) => pick(r, select));
    const first = async (args: Args = {}) => (await find({ ...args, take: 1 }))[0] ?? null;
    return {
      findFirst: first,
      findUnique: first,
      findMany: find,
      count: async ({ where }: Args = {}) => t(name).filter((r) => matches(name, r, where)).length,
      create: async ({ data = {} }: Args) => {
        const row = stamp(name, { ...(defaults[name]?.() ?? {}), ...data });
        unique(name, row);
        t(name).push(row);
        return { ...row };
      },
      upsert: async ({ where, create = {}, update = {} }: Args) => {
        const row = t(name).find((r) => matches(name, r, where));
        if (row) return { ...stamp(name, Object.assign(row, update)) };
        const fresh = stamp(name, { ...(defaults[name]?.() ?? {}), ...create });
        unique(name, fresh);
        t(name).push(fresh);
        return { ...fresh };
      },
      updateMany: async ({ where, data = {} }: Args) => {
        const rows = t(name).filter((r) => matches(name, r, where));
        for (const r of rows) stamp(name, Object.assign(r, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: Args = {}) => {
        const keep = t(name).filter((r) => !matches(name, r, where));
        const count = t(name).length - keep.length;
        tables[name] = keep;
        return { count };
      },
    };
  };
  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  const prisma = new Proxy({} as R, { get: (_t, prop: string) => (prop === "then" ? undefined : (delegates[prop] ??= delegate(prop))) });
  return {
    prisma,
    rows: (name: string) => t(name),
    seed: (name: string, rows: R[]) => void t(name).push(...rows.map((r) => ({ ...(defaults[name]?.() ?? {}), ...r }))),
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
    },
  };
});

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  access: vi.fn(),
  convert: vi.fn(async (..._a: unknown[]) => undefined),
  emit: vi.fn(async (..._a: unknown[]) => undefined),
  route: vi.fn(async (..._a: unknown[]) => null),
  start: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/graph", () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false, public ambiguous = false) {
      super(message);
    }
  }
  return { GraphError, graphFetchAs: h.graph };
});
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: h.access }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/conversions", () => ({ queueConversion: h.convert }));
vi.mock("@/lib/integrations/emitters", () => ({ emitLeadCreated: h.emit }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/contacts/consent", () => ({ recordChannelConsent: async () => undefined }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAttributeChanges: () => undefined, emitAutomationEvent: () => undefined, emitTagChanges: () => undefined }));
vi.mock("@/lib/leads/assignment", () => ({ routeNewLead: h.route, assignLeadToConversation: async () => null }));
vi.mock("@/lib/leads/runner", () => ({ startSequenceForLead: h.start, runDueSequences: async () => 0 }));

import { GraphError } from "@/lib/graph";
import {
  ACTIVE_AD_WINDOW_MS,
  ADS_PAGE,
  BACKFILL_BUDGET_MS,
  BACKFILL_WINDOW_MS,
  backfillLeads,
  backfillStateKey,
  campaignRanWithin,
  campaignRunning,
  formRefOf,
  LEAD_ACCESS_MISSING_MS,
  LEADS_PAGE_LIMIT,
  leadAccessKey,
  leadAccessState,
  MAX_ADS_SCANNED,
  MAX_BACKFILL_LEADS,
  retryWaitMs,
  type BackfillDeps,
} from "@/lib/leads/backfill";
import { forgetLeadPlatformCapability, ingestForTenant, leadIsOrganic, leadPlatform, withLeadPlatform } from "@/lib/leads/ingest";
import { CAPABILITIES_KEY, CAPABILITY_TTL_MS } from "@/lib/promote/meta";
import { runLeadBackfill } from "@/lib/promote/tasks/backfill";
import { createThrottle, pageScope, type SettingStore } from "@/lib/promote/throttle";

const T = "t1";
const PAGE_ASSET = "page_asset_1";
const PAGE_ID = "104857600123";
const NOW = Date.parse("2026-10-31T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------------
// A small Meta: forms with leads (L5, paged by an offset cursor), single leads (L6) and form definitions (L3)
// ---------------------------------------------------------------------------------------------------------------------

type MetaLead = { id: string; created_time: string; ad_id?: string; adset_id?: string; campaign_id?: string; field_data: { name: string; values: string[] }[]; custom_disclaimer_responses?: unknown; platform?: string; is_organic?: boolean };
type Call = { path: string; query: Record<string, string> };

const meta = {
  forms: new Map<string, MetaLead[]>(),
  calls: [] as Call[],
  /** Meta answers #100 for platform and is_organic (V-P7 not confirmed). */
  noPlatform: false,
  /** A Meta error per L5 path. */
  failures: new Map<string, GraphError>(),
  /** Waits before answering a matching path (for the race test). */
  gate: null as null | { match: (path: string) => boolean; wait: () => Promise<void> },
};

const fieldsOf = (q: Record<string, string>) => new Set((q.fields ?? "").split(","));
function shape(l: MetaLead, fields: Set<string>): Row {
  const { platform, is_organic, ...rest } = l;
  return { ...rest, ...(fields.has("platform") ? { platform } : {}), ...(fields.has("is_organic") ? { is_organic } : {}) };
}

async function graphImpl(_token: string, req: { path: string; query?: Record<string, string> }) {
  const query = req.query ?? {};
  meta.calls.push({ path: req.path, query });
  if (meta.gate?.match(req.path)) await meta.gate.wait();
  const fields = fieldsOf(query);
  const [head, edge] = req.path.split("/");
  if ((fields.has("platform") || fields.has("is_organic")) && meta.noPlatform) throw new GraphError("(#100) Tried accessing nonexisting field (platform) on node type (Lead)", 400, 100);
  if (edge === "leads") {
    const failure = meta.failures.get(req.path);
    if (failure) throw failure;
    const all = meta.forms.get(head) ?? [];
    const from = Number(query.after ?? 0);
    const limit = Number(query.limit ?? 25);
    const data = all.slice(from, from + limit).map((l) => shape(l, fields));
    const next = from + limit < all.length ? String(from + limit) : null;
    return { data, paging: next ? { cursors: { after: next }, next: `https://graph.facebook.com/next?after=${next}` } : { cursors: {} } };
  }
  for (const [formId, leads] of meta.forms) {
    const lead = leads.find((l) => l.id === head);
    if (lead) return { ...shape(lead, fields), form_id: formId };
  }
  if (fields.has("questions")) return { questions: [{ key: "full_name" }, { key: "phone_number" }], legal_content: {} };
  throw new GraphError("(#100) Unsupported get request. Object does not exist", 400, 100, 33);
}

const L5 = () => meta.calls.filter((c) => c.path.endsWith("/leads"));
const lead = (id: string, over: Partial<MetaLead> = {}): MetaLead => ({
  id,
  created_time: new Date(NOW - HOUR).toISOString(),
  ad_id: "ad_1",
  adset_id: "adset_1",
  campaign_id: "camp_1",
  field_data: [
    { name: "full_name", values: [`Person ${id}`] },
    { name: "phone_number", values: [`+9198${String(id).replace(/\D/g, "").padStart(8, "0").slice(-8)}`] },
    { name: "whatsapp_updates_consent", values: ["Yes"] },
  ],
  platform: "ig",
  is_organic: false,
  ...over,
});
const leads = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => lead(`${prefix}${i + 1}`));

// ---------------------------------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------------------------------

type CampaignSeed = { id?: string; status?: string; launchedAt?: Date | null; updatedAt?: Date; endsAt?: Date | null };
let adSeq = 0;
/** An ad (ids sort in the order they are made) of a launched campaign; returns the campaign's id. */
function adFor(formRef: string, c: CampaignSeed = {}, tenantId = T, over: Row = {}): string {
  const id = `ad_${String(++adSeq).padStart(6, "0")}`;
  const campaignId = c.id ?? `camp_${id}`;
  mem.seed("ad", [
    {
      id,
      tenantId,
      metaAdId: `meta_${id}`,
      creative: { leadFormId: formRef },
      adSet: {
        campaignId,
        campaign: { id: campaignId, status: c.status ?? "active", launchedAt: c.launchedAt === undefined ? new Date(NOW - 3 * DAY) : c.launchedAt, updatedAt: c.updatedAt ?? new Date(NOW - 3 * DAY), endsAt: c.endsAt ?? null },
      },
      ...over,
    },
  ]);
  return campaignId;
}
function form(id: string, metaFormId: string, over: Row = {}) {
  mem.seed("leadForm", [{ id, tenantId: T, pageAssetId: PAGE_ASSET, metaFormId, createdAt: new Date(NOW - 10 * DAY), ...over }]);
}
const iso = (ms: number) => new Date(ms).toISOString();
/** The workspace's stored backfill state: when campaigns were last seen running, and each form's last try. */
function seedState(ran: Record<string, number>, tried: Record<string, { at: number; failures: number }> = {}, tenantId = T) {
  mem.seed("platformSetting", [
    {
      key: backfillStateKey(tenantId),
      value: { v: 1, ran: Object.fromEntries(Object.entries(ran).map(([k, at]) => [k, iso(at)])), tried: Object.fromEntries(Object.entries(tried).map(([k, t]) => [k, { at: iso(t.at), failures: t.failures }])) },
    },
  ]);
}
const stateOf = (tenantId = T) => mem.rows("platformSetting").find((r) => r.key === backfillStateKey(tenantId))?.value as { ran: Record<string, string>; tried: Record<string, { at: string; failures: number }> } | undefined;
/** Changes a campaign as every one of its ads sees it. */
const setCampaign = (campaignId: string, patch: Row) => {
  for (const a of mem.rows("ad")) if (a.adSet.campaignId === campaignId) Object.assign(a.adSet.campaign, patch);
};

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : null), set: async (key, value) => void rows.set(key, structuredClone(value)) };
}

let throttle = createThrottle({ store: memoryStore(), now: () => NOW });
const deps = (over: Partial<BackfillDeps> = {}): Partial<BackfillDeps> => ({
  now: () => NOW,
  access: async (_t, assetId) => ({ assetId, type: "page", externalId: PAGE_ID, name: "Fake Shop", token: "PAGE_TOKEN" }),
  throttle,
  mayRun: async () => true,
  budgetMs: 60_000,
  ...over,
});

beforeEach(() => {
  mem.reset();
  meta.forms.clear();
  meta.calls.length = 0;
  meta.noPlatform = false;
  meta.failures.clear();
  meta.gate = null;
  adSeq = 0;
  forgetLeadPlatformCapability();
  throttle = createThrottle({ store: memoryStore(), now: () => NOW });
  vi.clearAllMocks();
  h.graph.mockImplementation(graphImpl);
  h.access.mockImplementation(async (_t: string, assetId: string) => ({ assetId, type: "page", externalId: PAGE_ID, name: "Fake Shop", token: "PAGE_TOKEN" }));
  h.start.mockImplementation(async (tenantId: string, l: { id: string }) => {
    const [seq] = await mem.prisma.leadSequence.findMany({ where: { tenantId, enabled: true }, orderBy: { createdAt: "asc" } });
    if (!seq) return null;
    try {
      return (await mem.prisma.leadSequenceRun.create({ data: { tenantId, sequenceId: seq.id, leadId: l.id } })).id;
    } catch {
      return null;
    }
  });
  mem.seed("leadSequence", [{ id: "seq_1", tenantId: T, enabled: true, steps: [{ delayMinutes: 0, templateId: "tpl_1", stopOnReply: true }], appliesTo: null, createdAt: new Date(NOW - 30 * DAY) }]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================================================================

describe("which forms are read (3.11: an active ad, or one active in the last 7 days)", () => {
  it("reads only forms whose ad runs or ran in the last 7 days, found by the form's id or its Meta id", async () => {
    form("fA", "1001");
    form("fB", "1002");
    form("fC", "1003");
    form("fD", "1004");
    form("fE", "1005");
    form("fF", "1006");
    form("fG", "1007");
    for (const id of ["1001", "1002", "1003", "1004", "1005", "1006", "1007"]) meta.forms.set(id, [lead(`L${id}`)]);
    const running = adFor("fA"); // running, no end
    const pausedB = adFor("1002", { status: "paused" }); // by Meta id; last seen running 3 days ago
    const pausedC = adFor("fC", { status: "paused" }); // last seen running 10 days ago
    adFor("fD", { status: "active", endsAt: new Date(NOW - 8 * DAY), updatedAt: new Date(NOW - 20 * DAY) }); // ended 8 days ago
    adFor("fE", { status: "draft", launchedAt: null, updatedAt: new Date(NOW - HOUR) }); // never started
    adFor("1007", { status: "active", endsAt: new Date(NOW - 2 * DAY), updatedAt: new Date(NOW - 20 * DAY) }); // ended 2 days ago
    // fF has no ad at all; an ad of another workspace naming fF does not count either.
    adFor("fF", {}, "t2");
    seedState({ [pausedB]: NOW - 3 * DAY, [pausedC]: NOW - 10 * DAY });

    const result = await backfillLeads(deps());
    expect(new Set(L5().map((c) => c.path))).toEqual(new Set(["1001/leads", "1002/leads", "1007/leads"]));
    expect(result).toEqual({ forms: 3, leads: 3, failed: 0 });
    // The running campaign is stamped now; the 10-day-old stamp is dropped.
    expect(stateOf()!.ran).toEqual({ [running]: iso(NOW), [pausedB]: iso(NOW - 3 * DAY) });
  });

  it("a campaign paused months ago is never read, however recently its row changed; one seen running is read until 7 days after it was last seen", async () => {
    form("fOld", "1101");
    form("fLive", "1102");
    meta.forms.set("1101", [lead("L1101")]);
    meta.forms.set("1102", [lead("L1102")]);
    // A review check wrote to the old campaign's row 10 minutes ago (its disapproved ad is still checked): that is not running.
    adFor("fOld", { status: "paused", launchedAt: new Date(NOW - 90 * DAY), updatedAt: new Date(NOW - 10 * MIN) });
    const live = adFor("fLive", { id: "camp_live" });

    await backfillLeads(deps());
    expect(L5().map((c) => c.path)).toEqual(["1102/leads"]);
    expect(stateOf()!.ran).toEqual({ camp_live: iso(NOW) });

    // Seen running again 30 minutes later: the stamp is kept (it is refreshed once an hour), so nothing is written for it.
    await backfillLeads(deps({ now: () => NOW + 30 * MIN }));
    expect(stateOf()!.ran).toEqual({ camp_live: iso(NOW) });
    await backfillLeads(deps({ now: () => NOW + 61 * MIN }));
    expect(stateOf()!.ran).toEqual({ camp_live: iso(NOW + 61 * MIN) });

    // Paused, and its row keeps changing: read until 7 days after it was last seen running, then not.
    setCampaign(live, { status: "paused", updatedAt: new Date(NOW + 8 * DAY) });
    meta.calls.length = 0;
    await backfillLeads(deps({ now: () => NOW + 6 * DAY }));
    expect(L5().map((c) => c.path)).toEqual(["1102/leads"]);
    meta.calls.length = 0;
    await backfillLeads(deps({ now: () => NOW + 61 * MIN + 7 * DAY + MIN }));
    expect(L5()).toEqual([]);
    // The stamp is older than 7 days and no form is read any more: the state row is deleted.
    expect(stateOf()).toBeUndefined();
  });

  it("campaignRunning, campaignRanWithin and formRefOf follow the 7-day rule and read only a plain id", () => {
    expect(ACTIVE_AD_WINDOW_MS).toBe(7 * DAY);
    const at = (ms: number) => new Date(NOW - ms);
    expect(campaignRunning({ status: "active", launchedAt: at(DAY), endsAt: null }, NOW)).toBe(true);
    expect(campaignRunning({ status: "active", launchedAt: at(DAY), endsAt: at(MIN) }, NOW)).toBe(false);
    expect(campaignRunning({ status: "paused", launchedAt: at(DAY), endsAt: null }, NOW)).toBe(false);
    expect(campaignRunning({ status: "active", launchedAt: null, endsAt: null }, NOW)).toBe(false);
    expect(campaignRanWithin({ status: "active", launchedAt: at(DAY), endsAt: null }, null, NOW)).toBe(true);
    expect(campaignRanWithin({ status: "active", launchedAt: at(30 * DAY), endsAt: at(6 * DAY) }, null, NOW)).toBe(true);
    expect(campaignRanWithin({ status: "active", launchedAt: at(30 * DAY), endsAt: at(8 * DAY) }, null, NOW)).toBe(false);
    // A stopped campaign counts from when it was last seen running, never from its row's updatedAt.
    expect(campaignRanWithin({ status: "archived", launchedAt: at(30 * DAY), endsAt: null }, NOW - 6 * DAY, NOW)).toBe(true);
    expect(campaignRanWithin({ status: "paused", launchedAt: at(30 * DAY), endsAt: null }, NOW - 8 * DAY, NOW)).toBe(false);
    expect(campaignRanWithin({ status: "paused", launchedAt: at(30 * DAY), endsAt: null }, null, NOW)).toBe(false);
    expect(campaignRanWithin({ status: "active", launchedAt: null, endsAt: null }, NOW, NOW)).toBe(false);
    expect(campaignRanWithin(null, NOW, NOW)).toBe(false);
    expect(formRefOf({ leadFormId: "5566778899" })).toBe("5566778899");
    expect(formRefOf({ leadFormId: "bad id with spaces" })).toBeNull();
    expect(formRefOf({ leadFormId: 5 })).toBeNull();
    expect(formRefOf(null)).toBeNull();
  });

  it("pages through every matching ad, newest first, and the query itself leaves out campaigns that ended more than 7 days ago", async () => {
    expect(ADS_PAGE).toBe(1_000);
    expect(MAX_ADS_SCANNED).toBeGreaterThanOrEqual(10_000);
    form("fOldest", "1201");
    form("fBulk", "1202");
    form("fEnded", "1203");
    for (const id of ["1201", "1202", "1203"]) meta.forms.set(id, [lead(`L${id}`)]);
    adFor("fOldest", { id: "camp_a" }); // the oldest ad: on the last page
    for (let i = 0; i < 2_100; i++) adFor("fBulk", { id: "camp_a" });
    for (let i = 0; i < 30; i++) adFor("fEnded", { id: "camp_ended", endsAt: new Date(NOW - 30 * DAY) });
    const scan = vi.spyOn(mem.prisma.ad, "findMany");

    await backfillLeads(deps());
    expect(new Set(L5().map((c) => c.path))).toEqual(new Set(["1201/leads", "1202/leads"]));
    const calls = scan.mock.calls.map((c) => c[0] as Row);
    expect(calls.map((c) => [c.take, c.orderBy])).toEqual([[1_000, { id: "desc" }], [1_000, { id: "desc" }], [1_000, { id: "desc" }]]);
    const returned = (await Promise.all(scan.mock.results.map((r) => r.value as Promise<Row[]>))).flat();
    expect(returned).toHaveLength(2_101);
    expect(returned[0].creative.leadFormId).toBe("fBulk");
    expect(returned.at(-1)!.creative.leadFormId).toBe("fOldest");
    expect(returned.some((a) => a.creative.leadFormId === "fEnded")).toBe(false);
  });

  it("registers a form an old wizard ad names by its Meta id, under the workspace's own Page, so it is read with no lead yet", async () => {
    mem.seed("metaAsset", [
      { id: PAGE_ASSET, tenantId: T, type: "page", externalId: PAGE_ID, status: "active" },
      { id: "page_asset_t2", tenantId: "t2", type: "page", externalId: "999000111", status: "active" },
    ]);
    meta.forms.set("1301", [lead("L1301")]);
    meta.forms.set("1302", [lead("L1302")]);
    adFor("1301", {}, T, { creative: { leadFormId: "1301", pageId: PAGE_ID } });
    // The Page of another workspace, and a wizard ad with no Page: nothing is registered for them.
    adFor("1302", {}, T, { creative: { leadFormId: "1302", pageId: "999000111" } });
    adFor("1303", {}, T, { creative: { leadFormId: "1303" } });

    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 1, failed: 0 });
    expect(L5().map((c) => c.path)).toEqual(["1301/leads"]);
    expect(mem.rows("leadForm")).toEqual([expect.objectContaining({ tenantId: T, metaFormId: "1301", pageAssetId: PAGE_ASSET, origin: "registered" })]);
    expect(mem.rows("lead")).toEqual([expect.objectContaining({ leadgenId: "L1301", leadFormId: mem.rows("leadForm")[0].id })]);

    // The next run finds the row and registers nothing more.
    await backfillLeads(deps({ now: () => NOW + 30 * MIN }));
    expect(mem.rows("leadForm")).toHaveLength(1);
  });

  it("skips ads that never reached Meta and forms with no real Meta id (dry-run and simulated launches)", async () => {
    mem.seed("metaAsset", [{ id: PAGE_ASSET, tenantId: T, type: "page", externalId: PAGE_ID, status: "active" }]);
    form("fFake", "dryrun_leadform_abc");
    form("fReal", "1401");
    meta.forms.set("1401", [lead("L1401")]);
    adFor("fFake");
    adFor("fReal", {}, T, { metaAdId: "dryrun_ad_1" });
    adFor("dryrun_leadform_xyz", {}, T, { creative: { leadFormId: "dryrun_leadform_xyz", pageId: PAGE_ID } });
    expect(await backfillLeads(deps())).toEqual({ forms: 0, leads: 0, failed: 0 });
    expect(h.graph).not.toHaveBeenCalled();
    expect(mem.rows("leadForm")).toHaveLength(2);
  });

  it("reads forms never read first, then the oldest, so a run that stops early goes on with the others next time", async () => {
    form("fOld", "2001", { lastBackfillAt: new Date(NOW - 2 * HOUR) });
    form("fNew", "2002", { lastBackfillAt: new Date(NOW - 30 * MIN) });
    form("fNever", "2003");
    for (const id of ["2001", "2002", "2003"]) meta.forms.set(id, [lead(`L${id}`)]);
    for (const f of ["fOld", "fNew", "fNever"]) adFor(f);
    await backfillLeads(deps({ maxLeads: 2 }));
    expect(L5().map((c) => c.path)).toEqual(["2003/leads", "2001/leads"]);
    // Every try is recorded; the form left out this run is first among the good ones next time.
    expect(Object.keys(stateOf()!.tried).sort()).toEqual(["fNever", "fOld"]);
    meta.calls.length = 0;
    await backfillLeads(deps({ now: () => NOW + 30 * MIN, maxLeads: 1 }));
    expect(L5().map((c) => c.path)).toEqual(["2002/leads"]);
  });

  it("60 forms that always fail never hold back a form read fine before: it is read in each of two runs, and every try is recorded", async () => {
    let clock = NOW;
    form("fGood", "1500", { lastBackfillAt: new Date(NOW - DAY) });
    meta.forms.set("1500", [lead("L1500")]);
    adFor("fGood");
    for (let i = 1; i <= 60; i++) {
      const id = String(1500 + i);
      form(`fBad${i}`, id);
      adFor(`fBad${i}`);
      // A form deleted on Meta (or a Lead Access Manager refusal): every read fails.
      meta.failures.set(`${id}/leads`, new GraphError("(#100) Unsupported get request. Object does not exist", 400, 100, 33));
    }
    // Each failed read takes a second, so the 10-second budget runs out after about ten of them.
    h.graph.mockImplementation(async (token: string, req: { path: string; query?: Record<string, string> }) => {
      if (meta.failures.has(req.path)) clock += 1_000;
      return graphImpl(token, req);
    });
    const run = (at: number) => {
      clock = at;
      return backfillLeads(deps({ now: () => clock, budgetMs: BACKFILL_BUDGET_MS }));
    };

    const first = await run(NOW);
    expect(L5().map((c) => c.path)).toContain("1500/leads");
    expect(first.forms).toBe(1);
    expect(first.failed).toBeGreaterThan(5);
    expect(first.failed).toBeLessThan(15);
    meta.calls.length = 0;

    const second = await run(NOW + 30 * MIN);
    expect(L5().map((c) => c.path)).toContain("1500/leads");
    expect(second.forms).toBe(1);
    expect(mem.rows("leadForm").find((f) => f.id === "fGood")!.lastBackfillAt).toEqual(new Date(NOW + 30 * MIN));
    // Failed tries are recorded too, so the second run went on with failing forms the first had not tried.
    const tried = stateOf()!.tried;
    const failing = Object.entries(tried).filter(([, t]) => t.failures === 1);
    expect(failing).toHaveLength(first.failed + second.failed);
    expect(tried.fGood).toEqual({ at: iso(NOW + 30 * MIN), failures: 0 });
    expect(mem.rows("leadForm").filter((f) => f.id.startsWith("fBad")).every((f) => f.lastBackfillAt === null)).toBe(true);
  });

  it("a form that failed twice in a row waits 1 hour before its next try, then 2, 4 and at most 6 hours; a good read clears it", async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryWaitMs)).toEqual([0, 0, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR]);
    form("fBad", "1601");
    meta.forms.set("1601", [lead("L1601")]);
    adFor("fBad");
    meta.failures.set("1601/leads", new GraphError("(#100) Unsupported get request. Object does not exist", 400, 100, 33));
    const at = (ms: number) => backfillLeads(deps({ now: () => NOW + ms }));

    await at(0);
    await at(30 * MIN); // one failure: tried again at once
    expect(L5()).toHaveLength(2);
    await at(60 * MIN); // two in a row: waits an hour from the last try
    expect(L5()).toHaveLength(2);
    await at(90 * MIN);
    expect(L5()).toHaveLength(3);
    expect(stateOf()!.tried.fBad).toEqual({ at: iso(NOW + 90 * MIN), failures: 3 });
    await at(180 * MIN); // three in a row: waits 2 hours
    expect(L5()).toHaveLength(3);

    meta.failures.clear();
    expect(await at(210 * MIN)).toEqual({ forms: 1, leads: 1, failed: 0 });
    expect(stateOf()!.tried.fBad).toEqual({ at: iso(NOW + 210 * MIN), failures: 0 });
  });

  it("a stored try of another time is read back: a form tried after a good read moves behind the good forms read before it", async () => {
    form("fA", "1701", { lastBackfillAt: new Date(NOW - 3 * HOUR) });
    form("fB", "1702", { lastBackfillAt: new Date(NOW - 2 * HOUR) });
    for (const id of ["1701", "1702"]) meta.forms.set(id, [lead(`L${id}`)]);
    adFor("fA");
    adFor("fB");
    // fA was skipped by a cooldown an hour ago: its try is newer than fB's good read.
    seedState({}, { fA: { at: NOW - HOUR, failures: 0 } });
    await backfillLeads(deps({ maxLeads: 1 }));
    expect(L5().map((c) => c.path)).toEqual(["1702/leads"]);
  });

  it("the promote task runs it, and with no live form it makes no Meta call", async () => {
    form("fA", "1001");
    await expect(runLeadBackfill()).resolves.toEqual({ forms: 0, leads: 0, failed: 0 });
    expect(h.graph).not.toHaveBeenCalled();
  });
});

describe("the window and the cap (3.11, PRM-10 acceptance 3)", () => {
  it("reads the last 26 hours, 100 a page, at most 500 leads a run across forms", async () => {
    expect(BACKFILL_WINDOW_MS).toBe(26 * HOUR);
    expect(MAX_BACKFILL_LEADS).toBe(500);
    expect(LEADS_PAGE_LIMIT).toBe(100);
    form("fA", "3001");
    form("fB", "3002");
    meta.forms.set("3001", leads("A", 350));
    meta.forms.set("3002", leads("B", 350));
    adFor("fA");
    adFor("fB");

    const result = await backfillLeads(deps());
    expect(result).toEqual({ forms: 2, leads: 500, failed: 0 });
    expect(mem.rows("lead")).toHaveLength(500);
    const since = Math.floor((NOW - 26 * HOUR) / 1000);
    for (const c of L5()) {
      expect(JSON.parse(c.query.filtering)).toEqual([{ field: "time_created", operator: "GREATER_THAN", value: since }]);
      expect(Number(c.query.limit)).toBeLessThanOrEqual(100);
    }
    expect(L5().map((c) => `${c.path}:${c.query.limit}`)).toEqual([
      "3001/leads:100", "3001/leads:100", "3001/leads:100", "3001/leads:100",
      "3002/leads:100", "3002/leads:50",
    ]);
    // Both forms were read up to the cap, so both are marked.
    expect(mem.rows("leadForm").every((f) => f.lastBackfillAt?.getTime() === NOW)).toBe(true);
  });

  it("skips leads the workspace already has with one lookup per page, and counts only new ones", async () => {
    form("fA", "3001");
    meta.forms.set("3001", leads("A", 3));
    adFor("fA");
    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 3, failed: 0 });
    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 0, failed: 0 });
    expect(mem.rows("lead")).toHaveLength(3);
    expect(h.convert).toHaveBeenCalledTimes(3);
  });
});

describe("the webhook and the backfill race on one lead (11.2 risk 16)", () => {
  it("gives one Lead, one conversion, one lead.created and one sequence run", async () => {
    form("fA", "4001");
    meta.forms.set("4001", [lead("L4001")]);
    adFor("fA");
    // Both reads reach Meta before either answers, so both have checked that the lead is new.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    meta.gate = { match: (p) => p === "L4001" || p === "4001/leads", wait: () => (++arrived === 2 && release(), both) };

    const [webhook, backfill] = await Promise.all([
      ingestForTenant(T, PAGE_ASSET, { leadgenId: "L4001", pageId: PAGE_ID, formId: "4001" }),
      backfillLeads(deps()),
    ]);
    expect(arrived).toBe(2);
    expect(mem.rows("lead").filter((l) => l.leadgenId === "L4001")).toHaveLength(1);
    expect(mem.rows("leadSequenceRun")).toHaveLength(1);
    expect(mem.rows("contact")).toHaveLength(1);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.convert).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    // Exactly one side stored it; the other answered "already there" without an error.
    expect(Number(webhook !== null) + backfill.leads).toBe(1);
    expect(backfill.failed).toBe(0);
  });
});

describe("the capability probe for platform and is_organic (4.1)", () => {
  it("falls back on #100, stores the answer for 7 days, and the next reads (backfill and webhook) leave the fields out", async () => {
    meta.noPlatform = true;
    form("fA", "5001");
    meta.forms.set("5001", [lead("L5001"), lead("L5002")]);
    adFor("fA");

    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 2, failed: 0 });
    const [first, second] = L5();
    expect(fieldsOf(first.query).has("platform")).toBe(true);
    expect(fieldsOf(first.query).has("is_organic")).toBe(true);
    expect(fieldsOf(second.query).has("platform")).toBe(false);
    expect([...fieldsOf(second.query)]).toEqual(expect.arrayContaining(["id", "created_time", "ad_id", "adset_id", "campaign_id", "form_id", "field_data", "custom_disclaimer_responses"]));
    const stored = mem.rows("platformSetting").find((r) => r.key === CAPABILITIES_KEY)!;
    expect(stored.value.lead_platform).toEqual({ supported: false, checkedAt: new Date(NOW).toISOString() });
    expect(mem.rows("lead").map((l) => [l.platform, l.isOrganic])).toEqual([[null, null], [null, null]]);

    // Another process (no memo) reads the stored answer: the webhook's L6 asks without the fields, once.
    forgetLeadPlatformCapability();
    meta.calls.length = 0;
    meta.forms.get("5001")!.push(lead("L5003"));
    await ingestForTenant(T, PAGE_ASSET, { leadgenId: "L5003", pageId: PAGE_ID, formId: "5001" });
    const l6 = meta.calls.filter((c) => c.path === "L5003");
    expect(l6).toHaveLength(1);
    expect(fieldsOf(l6[0].query).has("platform")).toBe(false);
  });

  it("asks again once the stored answer is 7 days old, and keeps the fields while Meta has them, writing nothing", async () => {
    mem.seed("platformSetting", [{ key: CAPABILITIES_KEY, value: { lead_platform: { supported: false, checkedAt: new Date(NOW - CAPABILITY_TTL_MS - MIN).toISOString() } } }]);
    const read = vi.fn(async (withPlatform: boolean) => withPlatform);
    expect(await withLeadPlatform(read, NOW)).toEqual({ result: true, withPlatform: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(mem.rows("platformSetting")[0].value.lead_platform.supported).toBe(false);

    // A fresh "no" is trusted without asking Meta with the fields.
    forgetLeadPlatformCapability();
    mem.rows("platformSetting")[0].value.lead_platform.checkedAt = new Date(NOW - DAY).toISOString();
    read.mockClear();
    expect(await withLeadPlatform(read, NOW)).toEqual({ result: false, withPlatform: false });
    expect(read.mock.calls).toEqual([[false]]);
  });

  it("an error other than #100 is not a capability answer: it is thrown and nothing is stored", async () => {
    const read = vi.fn(async () => {
      throw new GraphError("(#100) Unsupported get request. Object does not exist", 400, 100, 33);
    });
    await expect(withLeadPlatform(read, NOW)).rejects.toThrow(/Object does not exist/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mem.rows("platformSetting")).toEqual([]);
  });
});

describe("the new lead fields (L5 and L6, 5.1)", () => {
  it("stores adsetMetaId, platform, isOrganic, source instant_form and Meta's created_time", async () => {
    form("fA", "6001");
    const created = new Date(NOW - 5 * HOUR).toISOString();
    meta.forms.set("6001", [lead("L6001", { adset_id: "238500000201", platform: "ig", is_organic: false, created_time: created }), lead("L6002", { platform: "fb", is_organic: true }), lead("L6003", { platform: "threads_or_new" })]);
    adFor("fA");
    await backfillLeads(deps());
    const byId = Object.fromEntries(mem.rows("lead").map((l) => [l.leadgenId, l]));
    expect(byId.L6001).toMatchObject({ adsetMetaId: "238500000201", adMetaId: "ad_1", campaignMetaId: "camp_1", platform: "instagram", isOrganic: false, source: "instant_form", isTest: false, leadFormId: "fA" });
    expect(byId.L6001.createdAt.toISOString()).toBe(created);
    expect(byId.L6002).toMatchObject({ platform: "facebook", isOrganic: true });
    expect(byId.L6003).toMatchObject({ platform: "unknown" });
  });

  it("maps Meta's platform and is_organic values", () => {
    expect(["fb", "facebook", "ig", "INSTAGRAM", "msg", "messenger", "wa", "an", "audience_network"].map(leadPlatform)).toEqual(["facebook", "facebook", "instagram", "instagram", "messenger", "messenger", "whatsapp", "audience_network", "audience_network"]);
    expect(leadPlatform("oculus")).toBe("unknown");
    expect([undefined, null, "", 5].map(leadPlatform)).toEqual([null, null, null, null]);
    expect([true, false, "1", "0", "true", "false", 1, 0, undefined, "maybe"].map(leadIsOrganic)).toEqual([true, false, true, false, true, false, true, false, null, null]);
  });
});

describe("lastBackfillAt, Lead Access Manager and throttling (3.2, 4.9)", () => {
  it("a permission error is recorded for the readiness row, the form is not marked read, and a later read clears it", async () => {
    form("fA", "7001");
    meta.forms.set("7001", [lead("L7001")]);
    adFor("fA");
    expect(await leadAccessState(T, PAGE_ASSET, NOW)).toBe("unknown");
    meta.failures.set("7001/leads", new GraphError("(#200) The user does not have permission to access this lead's information", 403, 200));

    expect(await backfillLeads(deps())).toEqual({ forms: 0, leads: 0, failed: 1 });
    expect(await leadAccessState(T, PAGE_ASSET, NOW)).toBe("missing");
    expect(mem.rows("platformSetting").find((r) => r.key === leadAccessKey(T, PAGE_ASSET))?.value).toMatchObject({ state: "missing" });
    expect(mem.rows("leadForm")[0].lastBackfillAt).toBeNull();
    expect(stateOf()!.tried.fA).toEqual({ at: iso(NOW), failures: 1 });

    meta.failures.clear();
    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 1, failed: 0 });
    expect(await leadAccessState(T, PAGE_ASSET, NOW)).toBe("ok");
    expect(mem.rows("leadForm")[0].lastBackfillAt).toEqual(new Date(NOW));
  });

  it("a refusal shows Lead Access Manager as missing on the readiness row for 24 hours, then unknown until a read says", async () => {
    expect(LEAD_ACCESS_MISSING_MS).toBe(24 * HOUR);
    mem.seed("metaAsset", [{ id: PAGE_ASSET, tenantId: T, type: "page", externalId: PAGE_ID, name: "Fake Shop", status: "active", meta: {} }]);
    form("fA", "7101");
    meta.forms.set("7101", [lead("L7101")]);
    adFor("fA");
    meta.failures.set("7101/leads", new GraphError("(#200) The user does not have permission to access this lead's information", 403, 200));
    await backfillLeads(deps());

    // The readiness facts read it for the chosen Page, so the lead form goal's row says what to fix.
    const { evaluatePrereqs, loadPrereqFacts } = await import("@/lib/promote/prereqs");
    const owner = { userId: "u1", tenantId: T, role: "owner" as const };
    const facts = await loadPrereqFacts(owner, { now: NOW + HOUR });
    expect(facts.page?.assetId).toBe(PAGE_ASSET);
    expect(facts.leadAccess).toBe("missing");
    expect(evaluatePrereqs(facts, { goal: "lead_form" }).find((r) => r.check === "lead_access")).toMatchObject({ status: "missing", blocks: true });
    // Another workspace's Page is not this one's.
    expect((await loadPrereqFacts({ ...owner, tenantId: "t2" }, { now: NOW + HOUR })).leadAccess).toBe("unknown");

    // A day later the old refusal no longer blocks Start; Meta decides at Start and the next read records again.
    expect(await leadAccessState(T, PAGE_ASSET, NOW + 23 * HOUR)).toBe("missing");
    expect(await leadAccessState(T, PAGE_ASSET, NOW + 25 * HOUR)).toBe("unknown");
    expect((await loadPrereqFacts(owner, { now: NOW + 25 * HOUR })).leadAccess).toBe("unknown");

    // A refusal again (2 tries later, after the retry wait) refreshes it.
    await backfillLeads(deps({ now: () => NOW + 30 * MIN }));
    await backfillLeads(deps({ now: () => NOW + 25 * HOUR }));
    expect(await leadAccessState(T, PAGE_ASSET, NOW + 26 * HOUR)).toBe("missing");
  });

  it("a cooldown on the Page holds the read without a call; high usage does not hold priority 1", async () => {
    form("fA", "8001");
    meta.forms.set("8001", [lead("L8001")]);
    adFor("fA");
    await throttle.noteError(pageScope(PAGE_ID), { code: 613 });
    expect(await backfillLeads(deps())).toEqual({ forms: 0, leads: 0, failed: 0 });
    expect(h.graph).not.toHaveBeenCalled();

    throttle = createThrottle({ store: memoryStore(), now: () => NOW });
    await throttle.noteUsage(pageScope(PAGE_ID), { pct: 95, regainMs: null, tier: null, sources: ["x-business-use-case-usage"] });
    expect(await backfillLeads(deps())).toEqual({ forms: 1, leads: 1, failed: 0 });
  });

  it("a rate-limit error from Meta starts the Page's cooldown and counts the form as failed", async () => {
    form("fA", "8101");
    meta.forms.set("8101", [lead("L8101")]);
    adFor("fA");
    meta.failures.set("8101/leads", new GraphError("(#17) User request limit reached", 400, 17));
    expect(await backfillLeads(deps())).toEqual({ forms: 0, leads: 0, failed: 1 });
    expect(await throttle.cooldown(pageScope(PAGE_ID))).toMatchObject({ code: 17 });
    expect(await leadAccessState(T, PAGE_ASSET)).toBe("unknown");
  });

  it("skips a workspace that may not run background work, and a Page that can no longer be used", async () => {
    form("fA", "9001");
    meta.forms.set("9001", [lead("L9001")]);
    adFor("fA");
    expect(await backfillLeads(deps({ mayRun: async () => false }))).toEqual({ forms: 0, leads: 0, failed: 0 });
    expect(await backfillLeads(deps({ access: async () => Promise.reject(new Error("Reconnect it in Settings.")) }))).toEqual({ forms: 0, leads: 0, failed: 1 });
    expect(h.graph).not.toHaveBeenCalled();
  });
});
