import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test leads at ingest (docs/IG-PAGE-ADS-SPEC.md D33, D13, 3.5 "After start", 3.11, 11.2 risk 23, PRM-10 acceptance 2): a lead is a
 * test when its id is in the Page's test-lead list (promote/test-leads.ts) or an answer starts with "Edwyz test lead" or
 * "<test lead", never by a time window, in every workspace that has the Page. A test lead is listed with isTest and nothing else
 * happens: no contact, no sequence run, no conversion row, no routing notice, no lead.created. Real queueConversion and routing
 * lookups run against an in-memory database; Meta is a stub of graphFetchAs.
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
  const INCLUDES: Record<string, Record<string, (row: R) => R | undefined>> = { leadSequenceRun: { sequence: (row) => t("leadSequence").find((s) => s.id === row.sequenceId) } };
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
  const pick = (name: string, row: R, select?: R, include?: R): R => {
    const out: R = select ? {} : { ...row };
    for (const [k, s] of Object.entries(select ?? {})) if (s) out[k] = row[k];
    for (const [k, s] of Object.entries(include ?? {})) if (s) out[k] = INCLUDES[name]?.[k]?.(row);
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
    leadForm: () => ({ id: `form_${++seq}`, origin: "registered", status: "active", name: null, consentText: null, spec: null, lastBackfillAt: null, createdAt: new Date() }),
    contact: () => ({ id: `contact_${++seq}`, optIn: false, optedOutAt: null, tags: [], attributes: {}, name: null }),
    leadSequenceRun: () => ({ id: `run_${++seq}`, status: "active", stepIndex: 0, nextRunAt: null, createdAt: new Date() }),
    conversionEvent: () => ({ id: `ev_${++seq}` }),
    auditLog: () => ({ id: `audit_${++seq}`, createdAt: new Date() }),
  };
  const stamp = (name: string, row: R) => {
    if (name === "platformSetting") row.updatedAt = new Date(Date.now() + ++seq);
    return row;
  };
  const unique = (name: string, row: R) => {
    for (const cols of UNIQUE[name] ?? []) {
      if (t(name).some((r) => r !== row && cols.every((c) => r[c] !== undefined && r[c] !== null && r[c] === row[c]))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
  };
  type Args = { where?: R; select?: R; include?: R; orderBy?: R | R[]; take?: number; data?: R; create?: R; update?: R };
  const delegate = (name: string) => {
    const find = async ({ where, select, include, orderBy, take }: Args = {}) => order(t(name).filter((r) => matches(name, r, where)), orderBy).slice(0, take ?? Infinity).map((r) => pick(name, r, select, include));
    const first = async (args: Args = {}) => (await find({ ...args, take: 1 }))[0] ?? null;
    return {
      findFirst: first,
      findUnique: first,
      findMany: find,
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

const h = vi.hoisted(() => ({ graph: vi.fn(), access: vi.fn(), assign: vi.fn(), emit: vi.fn(async (..._a: unknown[]) => undefined), enqueue: vi.fn(async (..._a: unknown[]) => undefined), start: vi.fn() }));

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
vi.mock("@/lib/queue", () => ({ enqueue: h.enqueue }));
vi.mock("@/lib/routing", () => ({ assignConversation: h.assign }));
vi.mock("@/lib/integrations/emitters", () => ({ emitLeadCreated: h.emit }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAttributeChanges: () => undefined, emitAutomationEvent: () => undefined, emitTagChanges: () => undefined }));
vi.mock("@/lib/leads/runner", () => ({ startSequenceForLead: h.start, runDueSequences: async () => 0 }));

import { handleLeadJob } from "@/lib/leads/ingest";
import { updateLead } from "@/lib/leads/service";
import { META_TEST_LEAD_PREFIX, rememberTestLead, TEST_LEAD_PHONE, TEST_LEAD_PREFIX, TEST_LEADS_MARKED_ON_INGEST } from "@/lib/promote/test-leads";

const PAGE_ID = "104857600123";
const FORM = "5566778899001122";
const MIN = 60_000;
const NOW = Date.now();

type MetaLead = { id: string; created_time: string; field_data: { name: string; values: string[] }[] };
const metaLeads = new Map<string, MetaLead>();

function metaLead(id: string, answers: Record<string, string>, at = NOW): MetaLead {
  const l = { id, created_time: new Date(at).toISOString(), field_data: Object.entries(answers).map(([name, v]) => ({ name, values: [v] })) };
  metaLeads.set(id, l);
  return l;
}
const realAnswers = (phone = "+91 98765 43210") => ({ full_name: "Asha Kulkarni", phone_number: phone, email: "asha@fakeshop.example", whatsapp_updates_consent: "Yes" });
const testAnswers = (code = "ABC123") => ({ full_name: `${TEST_LEAD_PREFIX} ${code}`, phone_number: TEST_LEAD_PHONE, email: `test.lead.${code.toLowerCase()}@example.com`, whatsapp_updates_consent: "Yes" });

const ingest = (leadgenId: string) => handleLeadJob({ leadgenId, pageId: PAGE_ID, formId: FORM });
const leadRow = (tenantId: string, leadgenId: string) => mem.rows("lead").find((l) => l.tenantId === tenantId && l.leadgenId === leadgenId);
const conversions = (leadId: string) => mem.rows("conversionEvent").filter((e) => e.leadId === leadId);
const runs = (leadId: string) => mem.rows("leadSequenceRun").filter((r) => r.leadId === leadId);

beforeEach(() => {
  mem.reset();
  metaLeads.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Two workspaces have the same Page (an agency and its client, 11.2 risk 23).
  mem.seed("metaAsset", [
    { id: "asset_t1", tenantId: "t1", type: "page", externalId: PAGE_ID, status: "active" },
    { id: "asset_t2", tenantId: "t2", type: "page", externalId: PAGE_ID, status: "active" },
  ]);
  for (const tenantId of ["t1", "t2"]) {
    mem.seed("leadSequence", [{ id: `seq_${tenantId}`, tenantId, enabled: true, name: "Welcome", steps: [{ delayMinutes: 0, templateId: "tpl_1", stopOnReply: true }], appliesTo: null, createdAt: new Date(NOW - 30 * 86_400_000) }]);
  }
  h.access.mockImplementation(async (tenantId: string, assetId: string) => ({ assetId, type: "page", externalId: PAGE_ID, name: "Fake Shop", token: `PAGE_TOKEN_${tenantId}` }));
  h.graph.mockImplementation(async (_token: string, req: { path: string; query?: Record<string, string> }) => {
    const l = metaLeads.get(req.path);
    if (l) return { ...l, form_id: FORM, ad_id: "ad_1", adset_id: "adset_1", campaign_id: "camp_1", platform: "ig", is_organic: false };
    if (req.path === FORM) return { questions: [{ key: "full_name" }, { key: "phone_number" }, { key: "email" }, { key: "whatsapp_updates_consent", label: "Get WhatsApp updates?" }] };
    throw new Error(`unexpected Meta read ${req.path}`);
  });
  h.assign.mockResolvedValue({ assignedToId: "u7", reason: "assigned" });
  h.start.mockImplementation(async (tenantId: string, l: { id: string }) => (await mem.prisma.leadSequenceRun.create({ data: { tenantId, sequenceId: `seq_${tenantId}`, leadId: l.id } })).id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("test leads are recognised by what Meta returns, not by a time window (D33)", () => {
  it("lead ingest marks test leads, so Edwyz may send them (the 409 gate is open)", () => {
    expect(TEST_LEADS_MARKED_ON_INGEST).toBe(true);
  });

  it("a real lead arriving 1 minute after a test lead is not isTest, and gets its welcome, conversion and lead.created", async () => {
    await rememberTestLead(PAGE_ID, "TL1", new Date(NOW - 2 * MIN));
    metaLead("TL1", testAnswers(), NOW - 2 * MIN);
    metaLead("RL1", realAnswers(), NOW - MIN);
    await ingest("TL1");
    await ingest("RL1");

    for (const tenantId of ["t1", "t2"]) {
      expect(leadRow(tenantId, "TL1")).toMatchObject({ isTest: true });
      const real = leadRow(tenantId, "RL1")!;
      expect(real).toMatchObject({ isTest: false, source: "instant_form", platform: "instagram" });
      expect(real.contactId).toBeTruthy();
      expect(runs(real.id)).toHaveLength(1);
      expect(conversions(real.id)).toEqual([expect.objectContaining({ eventName: "Lead", status: "pending" })]);
    }
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(h.emit.mock.calls.every((c) => (c[1] as { leadgenId: string }).leadgenId === "RL1")).toBe(true);
  });

  it("a lead whose id is in the Page's test-lead list is isTest in both workspaces sharing the Page, even with ordinary answers", async () => {
    await rememberTestLead(PAGE_ID, "TL2", new Date(NOW - 5 * MIN));
    metaLead("TL2", realAnswers("+91 91234 56789"));
    await ingest("TL2");
    const rows = mem.rows("lead").filter((l) => l.leadgenId === "TL2");
    expect(rows.map((l) => [l.tenantId, l.isTest])).toEqual([["t1", true], ["t2", true]]);
    expect(rows.every((l) => l.contactId === null && l.consentAt === null)).toBe(true);
    expect(mem.rows("contact")).toEqual([]);
    expect(mem.rows("conversionEvent")).toEqual([]);
    expect(mem.rows("leadSequenceRun")).toEqual([]);
  });

  it("an answer that starts with 'Edwyz test lead' or '<test lead' makes a test lead, in any question", async () => {
    metaLead("TA1", { ...realAnswers("+91 90000 00001"), full_name: `${TEST_LEAD_PREFIX} QW12ER` });
    metaLead("TA2", { ...realAnswers("+91 90000 00002"), full_name: `${META_TEST_LEAD_PREFIX}: dummy data for full_name>` });
    metaLead("TA3", { ...realAnswers("+91 90000 00003"), which_service: `  ${TEST_LEAD_PREFIX} QW12ER` });
    metaLead("RA4", { ...realAnswers("+91 90000 00004"), which_service: `Haircut, not an ${TEST_LEAD_PREFIX}` });
    for (const id of ["TA1", "TA2", "TA3", "RA4"]) await ingest(id);
    expect(Object.fromEntries(mem.rows("lead").filter((l) => l.tenantId === "t1").map((l) => [l.leadgenId, l.isTest]))).toEqual({ TA1: true, TA2: true, TA3: true, RA4: false });
  });

  it("a test lead makes no sequence run, no CAPI row and no routing notice, and leaves the contact with the same phone untouched", async () => {
    // A person with an open chat and the same phone number: a real lead would be routed to that chat's owner.
    mem.seed("contact", [{ id: "c_asha", tenantId: "t1", phone: "+919876543210", tags: ["vip"], optIn: true, name: "Asha" }]);
    mem.seed("conversation", [{ id: "cv_1", tenantId: "t1", contactId: "c_asha", assignedToId: null, lastMessageAt: new Date(NOW - MIN) }]);
    metaLead("TL3", { ...realAnswers(), full_name: `${TEST_LEAD_PREFIX} ZX9` });
    await ingest("TL3");
    const test = leadRow("t1", "TL3")!;
    expect(test).toMatchObject({ isTest: true, contactId: null, consentAt: null });
    expect(runs(test.id)).toEqual([]);
    expect(conversions(test.id)).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.assign).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(mem.rows("contact").find((c) => c.id === "c_asha")).toMatchObject({ tags: ["vip"], optIn: true });

    // The same lead without the test answer is handled as real: routed, converted and welcomed.
    metaLead("RL3", realAnswers());
    await ingest("RL3");
    const real = leadRow("t1", "RL3")!;
    expect(real).toMatchObject({ isTest: false, contactId: "c_asha" });
    expect(h.assign).toHaveBeenCalledWith("t1", "cv_1");
    expect(conversions(real.id)).toHaveLength(1);
    expect(runs(real.id)).toHaveLength(1);
  });

  it("marking a test lead qualified or won sends no conversion either (D13)", async () => {
    metaLead("TL4", testAnswers("Q1"));
    metaLead("RL4", realAnswers("+91 95555 00004"));
    await ingest("TL4");
    await ingest("RL4");
    const actor = { tenantId: "t1", userId: "u1", role: "admin" as const };
    const test = leadRow("t1", "TL4")!;
    const real = leadRow("t1", "RL4")!;
    await updateLead(actor, test.id, { status: "qualified" });
    await updateLead(actor, test.id, { status: "won" });
    await updateLead(actor, real.id, { status: "qualified" });
    expect(conversions(test.id)).toEqual([]);
    expect(conversions(real.id).map((e) => e.eventName)).toEqual(["Lead", "QualifiedLead"]);
    expect(leadRow("t1", "TL4")).toMatchObject({ status: "won" });
  });
});
