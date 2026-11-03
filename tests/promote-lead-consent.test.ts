import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WhatsApp consent of instant-form leads and the 60-minute welcome catch-up (docs/IG-PAGE-ADS-SPEC.md D35, 3.5 step 2 and step 4,
 * 3.11, PRM-10 acceptance 2a): the `whatsapp_opt_in` box of forms built in Edwyz is a consent question through consentKind; a lead
 * who ticks it is opted in and welcomed; an unticked lead keeps needs_opt_in and gets no sequence; and a sequence turned on within
 * 60 minutes of its campaign's start catches up at most 50 consented leads, and nothing after 60 minutes. The database is an
 * in-memory stand-in; Meta is a stub of graphFetchAs.
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
    lead: () => ({ id: `lead_${++seq}`, status: "new", assignedToId: null, firstResponseAt: null, createdAt: new Date(), source: "instant_form", platform: null, isOrganic: null, isTest: false, adsetMetaId: null, consentAt: null, consentText: null, campaignMetaId: null, fields: {} }),
    leadForm: () => ({ id: `form_${++seq}`, origin: "registered", status: "active", name: null, consentText: null, spec: null, lastBackfillAt: null, createdAt: new Date() }),
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

const h = vi.hoisted(() => ({ graph: vi.fn(), access: vi.fn(), start: vi.fn(), blocked: new Set<string>() }));

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
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async (id: string) => !h.blocked.has(id) }));
vi.mock("@/lib/queue", () => ({ enqueue: async () => undefined }));
vi.mock("@/lib/conversions", () => ({ queueConversion: async () => undefined }));
vi.mock("@/lib/integrations/emitters", () => ({ emitLeadCreated: async () => undefined }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined }));
vi.mock("@/lib/contacts/consent", () => ({ recordChannelConsent: async () => undefined }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitAttributeChanges: () => undefined, emitAutomationEvent: () => undefined, emitTagChanges: () => undefined }));
vi.mock("@/lib/leads/assignment", () => ({ routeNewLead: async () => null, assignLeadToConversation: async () => null }));
vi.mock("@/lib/leads/runner", () => ({ startSequenceForLead: h.start, runDueSequences: async () => 0 }));

import { consentKind } from "@/lib/leads/fields";
import { BUILT_CONSENT_KEY, builtFormDefinitionKeys, fetchFormDefinitionKeys } from "@/lib/leads/form-definition";
import { disclaimerAnswers, ingestForTenant } from "@/lib/leads/ingest";
import { campaignStart, CATCH_UP_MAX_RUNS, CATCH_UP_WINDOW_MS, catchUpKey, runSequenceCatchUp } from "@/lib/leads/worker";
import { CONSENT_CHECKBOX } from "@/lib/promote/catalog/lead-questions";
import { presetSpec } from "@/lib/promote/form-presets";
import { consentTextOf, validateSpec, type FormSpec } from "@/lib/promote/lead-forms";

const T = "t1";
const PAGE_ASSET = "page_asset_1";
const PAGE_ID = "104857600123";
const META_FORM = "5566778899001122";
const MIN = 60_000;
const NOW = Date.now();

/** A salon form built in Edwyz: the preset questions plus the default WhatsApp box (optional, never ticked in advance). */
function builtSpec(lang: "en_US" | "hi_IN" = "en_US"): FormSpec {
  const result = validateSpec({ ...presetSpec("salon", { privacyUrl: "https://fakeshop.example/privacy", locale: lang }), name: "Salon leads" }, { businessName: "Fake Shop", whatsappNumber: "+91 98765 43210" });
  if (!result.spec) throw new Error(JSON.stringify(result.problems));
  return result.spec;
}

/** An extra box the owner added next to the WhatsApp box (form-builder-helpers "others"); its words read as consent. */
const EMAIL_BOX = { key: "email_offers", text: "I agree to receive email offers", required: false, checkedByDefault: false };
function withBoxes(spec: FormSpec, ...boxes: Row[]): FormSpec {
  return { ...spec, disclaimer: { ...spec.disclaimer!, checkboxes: [...spec.disclaimer!.checkboxes, ...boxes] } } as FormSpec;
}

const metaLeads = new Map<string, Row>();
function metaLead(id: string, over: Row = {}) {
  metaLeads.set(id, {
    id,
    created_time: new Date(NOW - MIN).toISOString(),
    form_id: META_FORM,
    field_data: [
      { name: "full_name", values: ["Asha Kulkarni"] },
      { name: "phone_number", values: [`+91 98${id.replace(/\D/g, "").padStart(8, "0").slice(-8)}`] },
    ],
    ...over,
  });
}
const ingest = (id: string) => ingestForTenant(T, PAGE_ASSET, { leadgenId: id, pageId: PAGE_ID, formId: META_FORM });
const leadRow = (id: string) => mem.rows("lead").find((l) => l.leadgenId === id)!;
const contactOf = (id: string) => mem.rows("contact").find((c) => c.id === leadRow(id).contactId)!;
const runsOf = (id: string) => mem.rows("leadSequenceRun").filter((r) => r.leadId === leadRow(id).id);

beforeEach(() => {
  mem.reset();
  metaLeads.clear();
  h.blocked.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.access.mockImplementation(async (_t: string, assetId: string) => ({ assetId, type: "page", externalId: PAGE_ID, name: "Fake Shop", token: "PAGE_TOKEN" }));
  h.graph.mockImplementation(async (_token: string, req: { path: string }) => {
    const l = metaLeads.get(req.path);
    if (l) return l;
    throw new Error(`unexpected Meta read ${req.path}`);
  });
  h.start.mockImplementation(async (tenantId: string, l: { id: string }) => {
    const [s] = await mem.prisma.leadSequence.findMany({ where: { tenantId, enabled: true }, orderBy: { createdAt: "asc" } });
    if (!s) return null;
    try {
      return (await mem.prisma.leadSequenceRun.create({ data: { tenantId, sequenceId: s.id, leadId: l.id } })).id;
    } catch {
      return null;
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================================================================

describe("the whatsapp_opt_in box is consent (D35, 3.5 step 2)", () => {
  it("consentKind reads the box's key as consent, whatever its words or language, and it is the box every built form carries", () => {
    expect(BUILT_CONSENT_KEY).toBe(CONSENT_CHECKBOX.key);
    expect(consentKind("whatsapp_opt_in")).toBe("consent");
    expect(consentKind("whatsapp_opt_in", "I agree to get WhatsApp messages from Fake Shop")).toBe("consent");
    expect(consentKind("whatsapp_opt_in", "मैं Fake Shop से WhatsApp मैसेज पाने के लिए सहमत हूँ")).toBe("consent");
  });

  it("a built form's spec defines the box as its consent question, with no Meta call", () => {
    for (const lang of ["en_US", "hi_IN"] as const) {
      const spec = builtSpec(lang);
      expect(spec.disclaimer?.checkboxes).toEqual([expect.objectContaining({ key: "whatsapp_opt_in", required: false })]);
      // The owner's own questions (which service, preferred day) are known by key too; none of them is consent.
      const own = spec.questions.filter((q) => q.type === "CUSTOM").map((q) => q.key);
      expect(own.length).toBeGreaterThan(0);
      expect(builtFormDefinitionKeys(spec)).toEqual({ questionKeys: [...own, "whatsapp_opt_in"], consentKeys: ["whatsapp_opt_in"], channelKeys: [] });
    }
    // A form built without the box has no consent question; an imported form's spec (no disclaimer) or none at all is not a built form's.
    const noBox = builtFormDefinitionKeys({ ...builtSpec(), disclaimer: null })!;
    expect(noBox.consentKeys).toEqual([]);
    expect(noBox.channelKeys).toEqual([]);
    expect(noBox.questionKeys).not.toContain("whatsapp_opt_in");
    expect(builtFormDefinitionKeys({ source: "meta", questions: [{ type: "FULL_NAME" }] })).toBeNull();
    expect(builtFormDefinitionKeys(null)).toBeNull();
    expect(h.graph).not.toHaveBeenCalled();
  });

  it("only the WhatsApp box is a consent question of a built form: the owner's other boxes are data, whatever their words", () => {
    const spec = withBoxes(builtSpec(), EMAIL_BOX, { key: "marketing_consent", text: "I consent to marketing calls", required: false, checkedByDefault: false });
    expect(builtFormDefinitionKeys(spec)).toEqual(expect.objectContaining({ consentKeys: ["whatsapp_opt_in"], channelKeys: [] }));
    expect(builtFormDefinitionKeys(spec)!.questionKeys).toEqual(expect.arrayContaining(["whatsapp_opt_in", "email_offers", "marketing_consent"]));
    // Without the WhatsApp box the form has no consent question at all, even with an "I agree to offers" box.
    const noWhatsApp = { ...spec, disclaimer: { ...spec.disclaimer!, checkboxes: spec.disclaimer!.checkboxes.filter((b) => b.key !== "whatsapp_opt_in") } };
    expect(builtFormDefinitionKeys(noWhatsApp)).toEqual(expect.objectContaining({ consentKeys: [], channelKeys: [] }));
  });

  it("Meta's copy of the form (L3 legal_content) reads the same box as consent", async () => {
    h.graph.mockResolvedValueOnce({ questions: [{ key: "full_name" }], legal_content: { custom_disclaimer: { checkboxes: [{ key: "whatsapp_opt_in", text: "I agree to get WhatsApp messages from Fake Shop" }, { key: "terms_ok", text: "I accept the terms" }] } } });
    expect(await fetchFormDefinitionKeys("PAGE_TOKEN", META_FORM)).toEqual({ questionKeys: ["full_name", "whatsapp_opt_in", "terms_ok"], consentKeys: ["whatsapp_opt_in"], channelKeys: [] });
  });

  it("custom_disclaimer_responses become answers: yes for a ticked box, no otherwise", () => {
    expect(disclaimerAnswers([{ checkbox_key: "whatsapp_opt_in", is_checked: "1" }, { checkbox_key: "Terms_OK", is_checked: "" }, { checkbox_key: "x", is_checked: true }, { checkbox_key: "y", is_checked: "0" }, { is_checked: "1" }, "junk"])).toEqual({ whatsapp_opt_in: "yes", terms_ok: "no", x: "yes", y: "no" });
    expect(disclaimerAnswers(undefined)).toEqual({});
  });
});

describe("leads of a form built in Edwyz (3.11: only consented leads get the welcome)", () => {
  const spec = builtSpec();
  beforeEach(() => {
    mem.seed("leadForm", [{ id: "form_built", tenantId: T, pageAssetId: PAGE_ASSET, metaFormId: META_FORM, origin: "created", spec, consentText: consentTextOf(spec) }]);
    mem.seed("leadSequence", [{ id: "seq_welcome", tenantId: T, enabled: true, steps: [{ delayMinutes: 0, templateId: "tpl_1", stopOnReply: true }], appliesTo: { leadFormId: "form_built" }, createdAt: new Date(NOW - 86_400_000) }]);
  });

  it("the whatsapp_opt_in answer is read as consent: the lead is opted in, records the box's words and gets the welcome", async () => {
    metaLead("L1", { custom_disclaimer_responses: [{ checkbox_key: "whatsapp_opt_in", is_checked: "1" }] });
    expect(await ingest("L1")).toBeTruthy();
    expect(leadRow("L1")).toMatchObject({ consentText: "I agree to get WhatsApp messages from Fake Shop", fields: expect.objectContaining({ whatsapp_opt_in: "yes" }) });
    expect(leadRow("L1").consentAt).toBeInstanceOf(Date);
    expect(contactOf("L1")).toMatchObject({ optIn: true, optInSource: "lead_form" });
    expect(contactOf("L1").tags).not.toContain("needs_opt_in");
    expect(runsOf("L1")).toHaveLength(1);
    // The built form's definition comes from its spec: Meta was asked for the lead only.
    expect(h.graph.mock.calls.map((c) => c[1].path)).toEqual(["L1"]);

    // Meta may put the box in field_data instead: the same answer counts.
    metaLead("L2", { field_data: [{ name: "full_name", values: ["Ravi"] }, { name: "phone_number", values: ["+91 98000 00002"] }, { name: "whatsapp_opt_in", values: ["1"] }] });
    await ingest("L2");
    expect(contactOf("L2")).toMatchObject({ optIn: true });
    expect(runsOf("L2")).toHaveLength(1);
  });

  it("an unticked lead is still a lead, gets needs_opt_in and no sequence, whether Meta leaves the box out or sends it unticked", async () => {
    metaLead("U1");
    metaLead("U2", { custom_disclaimer_responses: [{ checkbox_key: "whatsapp_opt_in", is_checked: "" }] });
    metaLead("U3", { custom_disclaimer_responses: [{ checkbox_key: "whatsapp_opt_in", is_checked: "0" }] });
    for (const id of ["U1", "U2", "U3"]) {
      await ingest(id);
      expect(leadRow(id), id).toMatchObject({ consentAt: null, consentText: null, isTest: false });
      expect(contactOf(id).optIn, id).toBe(false);
      expect(contactOf(id).tags, id).toContain("needs_opt_in");
      expect(runsOf(id), id).toEqual([]);
    }
    expect(leadRow("U2").fields).toMatchObject({ whatsapp_opt_in: "no" });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("never assumes consent for a built form, even with a stored consentAssumed setting and consent text", async () => {
    mem.seed("platformSetting", [{ key: "leads:form-settings:t1:form_built", value: { consentAssumed: true } }]);
    metaLead("U4");
    await ingest("U4");
    expect(leadRow("U4").consentAt).toBeNull();
    expect(contactOf("U4").tags).toContain("needs_opt_in");
    expect(runsOf("U4")).toEqual([]);
  });

  it("an unticked lead of someone already opted in keeps their opt-in but gets no welcome from this form", async () => {
    mem.seed("contact", [{ id: "c_known", tenantId: T, phone: "+919800000005", optIn: true, tags: ["customer"] }]);
    metaLead("U5", { field_data: [{ name: "full_name", values: ["Known"] }, { name: "phone_number", values: ["+91 98000 00005"] }] });
    await ingest("U5");
    expect(leadRow("U5")).toMatchObject({ contactId: "c_known", consentAt: null });
    expect(mem.rows("contact").find((c) => c.id === "c_known")).toMatchObject({ optIn: true });
    expect(mem.rows("contact").find((c) => c.id === "c_known")!.tags).not.toContain("needs_opt_in");
    expect(h.start).not.toHaveBeenCalled();
  });

  it("with an extra email-offers box, the WhatsApp box alone decides: ticked WhatsApp and unticked email is opted in and welcomed", async () => {
    mem.rows("leadForm")[0].spec = withBoxes(spec, EMAIL_BOX);
    metaLead("E1", { custom_disclaimer_responses: [{ checkbox_key: "whatsapp_opt_in", is_checked: "1" }, { checkbox_key: "email_offers", is_checked: "" }] });
    await ingest("E1");
    expect(leadRow("E1")).toMatchObject({ consentText: "I agree to get WhatsApp messages from Fake Shop", fields: expect.objectContaining({ whatsapp_opt_in: "yes", email_offers: "no" }) });
    expect(leadRow("E1").consentAt).toBeInstanceOf(Date);
    expect(contactOf("E1")).toMatchObject({ optIn: true, optInSource: "lead_form" });
    expect(contactOf("E1").tags).not.toContain("needs_opt_in");
    expect(runsOf("E1")).toHaveLength(1);

    // The email box ticked and the WhatsApp box not: no WhatsApp opt-in and no welcome.
    metaLead("E2", { custom_disclaimer_responses: [{ checkbox_key: "whatsapp_opt_in", is_checked: "0" }, { checkbox_key: "email_offers", is_checked: "1" }] });
    await ingest("E2");
    expect(leadRow("E2").consentAt).toBeNull();
    expect(contactOf("E2").tags).toContain("needs_opt_in");
    expect(runsOf("E2")).toEqual([]);
  });

  it("a built form without the WhatsApp box opts nobody in, even when another box says 'I agree to offers' and is ticked", async () => {
    mem.rows("leadForm")[0].spec = { ...spec, disclaimer: { ...spec.disclaimer!, checkboxes: [EMAIL_BOX] } };
    metaLead("N1", { custom_disclaimer_responses: [{ checkbox_key: "email_offers", is_checked: "1" }] });
    await ingest("N1");
    expect(leadRow("N1")).toMatchObject({ consentAt: null, fields: expect.objectContaining({ email_offers: "yes" }) });
    expect(contactOf("N1").optIn).toBe(false);
    expect(runsOf("N1")).toEqual([]);
  });
});

describe("the 60-minute welcome catch-up (3.5 step 4, PRM-10 acceptance 2a)", () => {
  const START = NOW - 20 * MIN;
  let n = 0;
  function seedLead(over: Row = {}, contact: Row = {}) {
    const id = `lc_${++n}`;
    mem.seed("contact", [{ id: `c_${id}`, tenantId: T, phone: `+9190${String(n).padStart(8, "0")}`, optIn: true, ...contact }]);
    mem.seed("lead", [{ id, tenantId: T, leadgenId: `g_${id}`, leadFormId: "form_1", contactId: `c_${id}`, consentAt: new Date(START + n * 1000), createdAt: new Date(START + n * 1000), campaignMetaId: "mc_1", fields: {}, ...over }]);
    return id;
  }
  const started = () => new Set(mem.rows("leadSequenceRun").map((r) => r.leadId));

  beforeEach(() => {
    n = 0;
    mem.seed("adCampaign", [{ id: "camp_1", tenantId: T, status: "active", metaCampaignId: "mc_1", launchedAt: new Date(START), startsAt: null }]);
    mem.seed("ad", [{ id: "ad_1", tenantId: T, metaAdId: "meta_ad_1", creative: { leadFormId: "form_1" }, adSet: { campaignId: "camp_1" } }]);
    mem.seed("leadForm", [
      { id: "form_1", tenantId: T, pageAssetId: PAGE_ASSET, metaFormId: META_FORM, origin: "created" },
      { id: "form_2", tenantId: T, pageAssetId: PAGE_ASSET, metaFormId: "998877" },
    ]);
    // The follow-up was turned on a few minutes after Start (the second card, 3.5 step 4).
    mem.seed("leadSequence", [{ id: "seq_form", tenantId: T, enabled: true, steps: [{ delayMinutes: 0, templateId: "tpl_1", stopOnReply: true }], appliesTo: { leadFormId: "form_1" }, createdAt: new Date(NOW - 2 * MIN) }]);
  });

  it("starts at most 50 runs, oldest first, only for consented, real leads since the start that have none", async () => {
    const consented = Array.from({ length: 60 }, () => seedLead());
    const unconsented = Array.from({ length: 5 }, () => seedLead({ consentAt: null }, { optIn: true }));
    const tests = Array.from({ length: 2 }, () => seedLead({ isTest: true }));
    const optedOut = seedLead({}, { optIn: false, optedOutAt: new Date(NOW - MIN) });
    const before = seedLead({ createdAt: new Date(START - 5 * MIN), consentAt: new Date(START - 5 * MIN) });
    const otherForm = seedLead({ leadFormId: "form_2" });
    const hasRun = seedLead();
    mem.seed("leadSequenceRun", [{ id: "run_old", tenantId: T, sequenceId: "seq_form", leadId: hasRun }]);

    expect(CATCH_UP_MAX_RUNS).toBe(50);
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 1, started: 50 });
    const got = started();
    expect(consented.slice(0, 50).every((id) => got.has(id))).toBe(true);
    expect(consented.slice(50).some((id) => got.has(id))).toBe(false);
    for (const id of [...unconsented, ...tests, optedOut, before, otherForm]) expect(got.has(id), id).toBe(false);
    expect(mem.rows("leadSequenceRun").filter((r) => r.leadId === hasRun)).toHaveLength(1);
    expect(mem.rows("platformSetting").find((r) => r.key === catchUpKey(T, "seq_form", "camp_1"))?.value).toMatchObject({ started: 50 });

    // At most 50 in all for the sequence and campaign: the next scan adds none, though 10 consented leads are left.
    expect(await runSequenceCatchUp(new Date(NOW + MIN))).toEqual({ campaigns: 1, started: 0 });
    expect(mem.rows("leadSequenceRun")).toHaveLength(51);
  });

  it("a sequence on before the start has nothing to catch up; turned off and on again within the hour, it welcomes the leads it missed", async () => {
    const welcomed = seedLead();
    mem.seed("leadSequenceRun", [{ id: "run_ingest", tenantId: T, sequenceId: "seq_form", leadId: welcomed }]);
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 1, started: 0 });
    expect(mem.rows("platformSetting")).toEqual([]);

    const seqRow = mem.rows("leadSequence")[0];
    seqRow.enabled = false;
    const missed = [seedLead(), seedLead()];
    expect((await runSequenceCatchUp(new Date(NOW + MIN))).started).toBe(0);
    seqRow.enabled = true;
    expect((await runSequenceCatchUp(new Date(NOW + 2 * MIN))).started).toBe(2);
    expect(missed.every((id) => started().has(id))).toBe(true);
    expect(mem.rows("platformSetting")[0].value).toMatchObject({ started: 2 });
  });

  it("counts toward the same 50: with 48 already started, only 2 more start", async () => {
    mem.seed("platformSetting", [{ key: catchUpKey(T, "seq_form", "camp_1"), value: { started: 48 }, updatedAt: new Date(NOW) }]);
    for (let i = 0; i < 5; i++) seedLead();
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(2);
    expect(mem.rows("platformSetting")[0].value).toMatchObject({ started: 50 });
  });

  it("back-fills nothing once the campaign started more than 60 minutes ago", async () => {
    expect(CATCH_UP_WINDOW_MS).toBe(60 * MIN);
    for (let i = 0; i < 3; i++) seedLead();
    expect(await runSequenceCatchUp(new Date(START + 61 * MIN))).toEqual({ campaigns: 0, started: 0 });
    expect(mem.rows("leadSequenceRun")).toEqual([]);
    expect(mem.rows("platformSetting")).toEqual([]);
    // At 59 minutes it still does.
    expect(await runSequenceCatchUp(new Date(START + 59 * MIN))).toEqual({ campaigns: 1, started: 3 });
  });

  it("counts from a later scheduled start, so leads before it are not caught up", async () => {
    mem.rows("adCampaign")[0].launchedAt = new Date(NOW - 3 * 60 * MIN);
    mem.rows("adCampaign")[0].startsAt = new Date(START);
    expect(campaignStart(mem.rows("adCampaign")[0] as { launchedAt: Date; startsAt: Date })).toEqual(new Date(START));
    expect(campaignStart({ launchedAt: null, startsAt: new Date(START) })).toBeNull();
    const after = seedLead();
    const early = seedLead({ createdAt: new Date(START - 10 * MIN) });
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 1, started: 1 });
    expect(started()).toEqual(new Set([after]));
    expect(started().has(early)).toBe(false);
  });

  it("only a sequence made for the campaign's form catches up, and only while it is on and the workspace may run", async () => {
    seedLead();
    const seqRow = mem.rows("leadSequence")[0];
    seqRow.appliesTo = null; // a sequence for every lead is not "the follow-up for this form"
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(0);
    seqRow.appliesTo = { leadFormId: "form_2" };
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(0);
    seqRow.appliesTo = { leadFormId: "form_1" };
    seqRow.enabled = false;
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(0);
    seqRow.enabled = true;
    h.blocked.add(T);
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(0);
    expect(mem.rows("platformSetting")).toEqual([]);
    h.blocked.clear();
    expect((await runSequenceCatchUp(new Date(NOW))).started).toBe(1);
  });

  it("counts from Start when the campaign was launched paused days before: leads since Start are caught up", async () => {
    const camp = mem.rows("adCampaign")[0];
    camp.launchedAt = new Date(NOW - 3 * 24 * 60 * MIN);
    camp.updatedAt = new Date(NOW - 10 * MIN);
    // Without the Start row the start is the launch, 3 days ago: nothing to catch up.
    const after = seedLead({ createdAt: new Date(NOW - 5 * MIN), consentAt: new Date(NOW - 5 * MIN) });
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 0, started: 0 });

    mem.seed("auditLog", [
      { id: "a_1", tenantId: T, action: "ads.campaign.activated", target: "camp_1", createdAt: new Date(NOW - 10 * MIN) },
      // A Start of another workspace's campaign with the same id is not this one's.
      { id: "a_2", tenantId: "t2", action: "ads.campaign.activated", target: "camp_other", createdAt: new Date(NOW - 5 * MIN) },
    ]);
    const before = seedLead({ createdAt: new Date(NOW - 20 * MIN), consentAt: new Date(NOW - 20 * MIN) });
    expect(campaignStart({ launchedAt: camp.launchedAt, startsAt: null, activatedAt: new Date(NOW - 10 * MIN) })).toEqual(new Date(NOW - 10 * MIN));
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 1, started: 1 });
    expect(started()).toEqual(new Set([after]));
    expect(started().has(before)).toBe(false);
    // The window runs 60 minutes from Start, not from the launch.
    expect((await runSequenceCatchUp(new Date(NOW + 49 * MIN))).campaigns).toBe(1);
    expect((await runSequenceCatchUp(new Date(NOW + 51 * MIN))).campaigns).toBe(0);
  });

  it("a resume counts as a start too, and a scheduled start still to come means nothing has run", async () => {
    const camp = mem.rows("adCampaign")[0];
    camp.launchedAt = new Date(NOW - 5 * 24 * 60 * MIN);
    camp.updatedAt = new Date(NOW - 15 * MIN);
    mem.seed("auditLog", [
      { id: "a_1", tenantId: T, action: "ads.campaign.activated", target: "camp_1", createdAt: new Date(NOW - 4 * 24 * 60 * MIN) },
      { id: "a_2", tenantId: T, action: "ads.campaign.resumed", target: "camp_1", createdAt: new Date(NOW - 15 * MIN) },
    ]);
    const lead = seedLead({ createdAt: new Date(NOW - 5 * MIN), consentAt: new Date(NOW - 5 * MIN) });
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 1, started: 1 });
    expect(started()).toEqual(new Set([lead]));
    expect(campaignStart({ launchedAt: new Date(NOW - MIN), startsAt: new Date(NOW + 60 * MIN), activatedAt: new Date(NOW) })).toEqual(new Date(NOW + 60 * MIN));
  });

  it("a campaign that is not running, or was never started, catches nothing up", async () => {
    seedLead();
    mem.rows("adCampaign")[0].status = "paused";
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 0, started: 0 });
    mem.rows("adCampaign")[0].status = "active";
    mem.rows("adCampaign")[0].launchedAt = null;
    expect(await runSequenceCatchUp(new Date(NOW))).toEqual({ campaigns: 0, started: 0 });
  });
});
