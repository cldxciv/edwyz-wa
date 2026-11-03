import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Instant forms built in Edwyz (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, D13, D33, D35, 4.2 L1 to L4, 4.8, PRM-10 acceptance 1 to
 * 2b): presets, validation in plain words, build on Meta through promote/meta.ts against the fake Meta of 9.3 (no network),
 * copy, import, hide, test leads, the draft's form for Start, dry runs, and the five routes behind the promote guard.
 * The database is an in-memory stand-in with just enough of Prisma's where clauses for these modules.
 */

type Row = Record<string, unknown>;

const mem = vi.hoisted(() => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  let seq = 0;
  const t = (name: string) => (tables[name] ??= []);
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
  const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  /** Compound unique keys (tenantId_metaFormId) are flattened into their columns. */
  const flat = (where: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(where)) {
      if (k !== "OR" && k !== "AND" && k.includes("_") && isPlain(v) && Object.keys(v).every((p) => k.split("_").includes(p))) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  };
  function cond(value: unknown, c: unknown): boolean {
    if (c === null) return value === null || value === undefined;
    if (c instanceof Date) return same(value, c);
    if (isPlain(c)) {
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("endsWith" in c) return typeof value === "string" && value.endsWith(c.endsWith as string);
      if ("startsWith" in c) return typeof value === "string" && value.startsWith(c.startsWith as string);
      if ("not" in c) return !cond(value, c.not);
      throw new Error(`mem: unsupported condition ${JSON.stringify(c)}`);
    }
    return same(value, c);
  }
  function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
    return Object.entries(flat(where)).every(([k, v]) =>
      k === "OR" ? (v as Record<string, unknown>[]).some((w) => matches(row, w)) : k === "AND" ? (v as Record<string, unknown>[]).every((w) => matches(row, w)) : cond(row[k], v),
    );
  }
  const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
  const order = (rows: Record<string, unknown>[], orderBy?: Record<string, "asc" | "desc">) => {
    if (!orderBy) return rows;
    const [k, dir] = Object.entries(orderBy)[0];
    const n = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
    return [...rows].sort((a, b) => (dir === "desc" ? n(b[k]) - n(a[k]) : n(a[k]) - n(b[k])));
  };
  const base = Date.UTC(2026, 9, 1);
  const defaults: Record<string, () => Record<string, unknown>> = {
    leadForm: () => ({
      id: `form_${++seq}`,
      origin: "registered",
      status: "active",
      name: null,
      consentText: null,
      formType: null,
      locale: null,
      spec: null,
      metaStatus: null,
      syncedAt: null,
      copiedFromId: null,
      lastBackfillAt: null,
      testLeadUntil: null,
      hiddenAt: null,
      createdAt: new Date(base + ++seq),
    }),
    auditLog: () => ({ id: `audit_${++seq}`, createdAt: new Date() }),
  };
  const stamp = (name: string, row: Record<string, unknown>) => {
    if (name === "platformSetting") row.updatedAt = new Date(base + ++seq);
    return row;
  };
  type Args = { where?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take?: number; data?: Record<string, unknown>; create?: Record<string, unknown>; update?: Record<string, unknown> };
  const delegate = (name: string) => {
    const first = async ({ where, select, orderBy }: Args = {}) => {
      const row = order(t(name).filter((r) => matches(r, where)), orderBy)[0];
      return row ? pick(row, select) : null;
    };
    return {
      findFirst: first,
      findUnique: first,
      findMany: async ({ where, select, orderBy, take }: Args = {}) => order(t(name).filter((r) => matches(r, where)), orderBy).slice(0, take ?? Infinity).map((r) => pick(r, select)),
      create: async ({ data = {} }: Args) => {
        if (name === "platformSetting" && t(name).some((r) => r.key === data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = stamp(name, { ...(defaults[name]?.() ?? {}), ...data });
        t(name).push(row);
        return { ...row };
      },
      upsert: async ({ where, create = {}, update = {} }: Args) => {
        const row = t(name).find((r) => matches(r, where));
        if (row) return { ...stamp(name, Object.assign(row, update)) };
        const fresh = stamp(name, { ...(defaults[name]?.() ?? {}), ...create });
        t(name).push(fresh);
        return { ...fresh };
      },
      updateMany: async ({ where, data = {} }: Args) => {
        const rows = t(name).filter((r) => matches(r, where));
        for (const r of rows) stamp(name, Object.assign(r, data));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: Args = {}) => {
        const keep = t(name).filter((r) => !matches(r, where));
        const count = t(name).length - keep.length;
        tables[name] = keep;
        return { count };
      },
    };
  };
  const delegates: Record<string, ReturnType<typeof delegate>> = {};
  const prisma = new Proxy({} as Record<string, unknown>, { get: (_target, prop: string) => (prop === "then" ? undefined : (delegates[prop] ??= delegate(prop))) });
  return {
    prisma,
    rows: (name: string) => t(name),
    seed: (name: string, rows: Record<string, unknown>[]) => void t(name).push(...rows.map((r) => ({ ...r }))),
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
    },
  };
});

const h = vi.hoisted(() => ({ getActor: vi.fn(), access: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/auth", () => ({ getActor: h.getActor }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: h.access }));

import { POST as buildRoute } from "@/app/api/leads/forms/build/route";
import { POST as copyRoute } from "@/app/api/leads/forms/[id]/copy/route";
import { POST as hideRoute } from "@/app/api/leads/forms/[id]/hide/route";
import { POST as testLeadRoute } from "@/app/api/leads/forms/[id]/test-lead/route";
import { GET as metaRoute } from "@/app/api/leads/forms/meta/route";
import { POST as registerRoute } from "@/app/api/leads/forms/route";
import { fetchFormDefinitionKeys } from "@/lib/leads/form-definition";
import { createForm, CREATED_FORM_CONSENT, listForms, updateForm } from "@/lib/leads/service";
import type { AssetAccess } from "@/lib/meta-connect";
import { LEAD_QUESTION_TYPES } from "@/lib/promote/catalog/lead-questions";
import { FORM_PRESET_KEYS, presetQuestions, presetSpec, presetSuggestions } from "@/lib/promote/form-presets";
import {
  buildForm,
  consentTextOf,
  copyForm,
  draftFormName,
  draftIdOfName,
  ensureDraftForm,
  formSpecHash,
  FormSpecError,
  hideForm,
  importForm,
  LEAD_FORM_COPY,
  leadFormErrorResponse,
  LeadgenTermsRefusal,
  listMetaForms,
  sendTestLead,
  TEST_LEAD_PHONE,
  TEST_SENT_MS,
  testFieldData,
  testLeadLimiter,
  toMetaSpec,
  unhideForm,
  validateSpec,
  type LeadFormDeps,
  type SpecContext,
} from "@/lib/promote/lead-forms";
import { createPromoteMeta, type PromoteMeta } from "@/lib/promote/meta";
import { PROMOTE_NOT_FOUND, PROMOTE_WRITERS_ONLY } from "@/lib/promote/route-guard";
import { setPromoteSettings } from "@/lib/promote/settings";
import { hasTestAnswers, isStoredTestLead, looksLikeTestAnswer, TEST_LEADS_MARKED_ON_INGEST, testLeadsKey } from "@/lib/promote/test-leads";
import { createThrottle, type SettingStore } from "@/lib/promote/throttle";
import { HttpError } from "@/lib/tenancy";
import { createFakeMetaPromote, FAKE_FORM_ID, FAKE_PAGE_ID, type FakeMetaPromote, type PromoteCallRecord } from "./helpers/fake-meta-promote";

const T = "t1";
const T0 = new Date("2026-10-31T10:00:00Z");
const ORIGIN = "https://wa.edwyz.com";
const PRIVACY = "https://fakeshop.example/privacy";
const PAGE = "page_asset";
type Role = "owner" | "admin" | "agent";
const actor = (role: Role = "admin", tenantId = T) => ({ userId: "u1", tenantId, role });
const CTX: SpecContext = { whatsappNumber: "+91 98765 43210", businessName: "Fake Shop", now: T0 };
const CONSENT_TEXT = "I agree to get WhatsApp messages from Fake Shop";

/** The salon preset with email, named, plus any overrides. */
const spec = (over: Record<string, unknown> = {}) => ({ ...presetSpec("salon", { privacyUrl: PRIVACY, email: true }), name: "Salon leads", ...over });

function memoryStore(): SettingStore {
  const rows = new Map<string, unknown>();
  return { get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : null), set: async (key, value) => void rows.set(key, structuredClone(value)) };
}

type Setup = { fake: FakeMetaPromote; meta: PromoteMeta; deps: Partial<LeadFormDeps>; fetch: ReturnType<typeof vi.fn>; posts: (path?: RegExp) => PromoteCallRecord[] };

function setup(opts: { dryRun?: boolean } = {}): Setup {
  const fake = createFakeMetaPromote();
  const fetch = vi.fn(fake.fetch);
  vi.stubGlobal("fetch", fetch);
  const page: AssetAccess = { assetId: PAGE, type: "page", externalId: FAKE_PAGE_ID, name: "Fake Shop", token: fake.pageToken() };
  const access = vi.fn(async (_tenantId: string, assetId: string) => {
    if (assetId !== PAGE) throw new HttpError(404, "Asset not found.");
    return page;
  });
  const now = () => T0.getTime();
  const meta = createPromoteMeta({
    access,
    sandbox: async () => false,
    store: memoryStore(),
    throttle: createThrottle({ store: memoryStore(), now }),
    env: opts.dryRun ? { SPEND_DRY_RUN: "1" } : {},
    sleep: async () => undefined,
    now,
    readTimeoutMs: 2_000,
    writeTimeoutMs: 2_000,
  });
  const deps: Partial<LeadFormDeps> = {
    meta,
    readDefinition: (_t, _a, formId) => fetchFormDefinitionKeys(fake.pageToken(), formId),
    now: () => new Date(T0),
    dryRun: opts.dryRun === true,
    code: () => "ABC123",
    // As if lead ingest marked test leads already; the gate itself is tested on its own.
    testLeadsReady: true,
  };
  return { fake, meta, deps, fetch, posts: (path = /\/leadgen_forms$/) => fake.calls.filter((c) => c.method === "POST" && path.test(c.path)) };
}

const formRows = () => mem.rows("leadForm");
const formRow = (id: string) => formRows().find((r) => r.id === id) as Row;
const settingRow = (key: string) => mem.rows("platformSetting").find((r) => r.key === key) as Row | undefined;
const audits = () => mem.rows("auditLog").map((r) => r.action);

beforeEach(async () => {
  mem.reset();
  mem.seed("metaAsset", [
    { id: PAGE, tenantId: T, type: "page", externalId: FAKE_PAGE_ID, name: "Fake Shop" },
    { id: "other_page", tenantId: "t2", type: "page", externalId: "777000777", name: "Other" },
  ]);
  mem.seed("phoneNumber", [{ id: "pn1", tenantId: T, displayPhone: "+91 98765 43210", verifiedName: "Fake Shop WA", createdAt: new Date(0) }]);
  mem.seed("adCampaign", ["draft1", "draft2", "draft3", "draft4"].map((id) => ({ id, tenantId: T, status: "draft" })));
  await testLeadLimiter.clear();
  h.getActor.mockReset();
  h.access.mockReset();
  h.getActor.mockResolvedValue(actor("admin"));
  process.env.SITE_URL = ORIGIN;
  for (const k of ["PROMOTE_ENABLED", "SPEND_DRY_RUN", "PROMOTE_EXPERIMENTAL", "SPEND_SIM"]) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================================================================

describe("presets (3.5 step 2)", () => {
  it("every preset validates, with and without email, and with the WhatsApp number question type", () => {
    for (const key of FORM_PRESET_KEYS) {
      for (const email of [false, true]) {
        for (const whatsappNumber of [false, true]) {
          const r = validateSpec(presetSpec(key, { privacyUrl: PRIVACY, email, whatsappNumber }), CTX);
          expect(r.problems, `${key} email=${email} wa=${whatsappNumber}`).toEqual([]);
          const s = r.spec!;
          expect(s.questions.slice(0, 2).map((q) => q.type)).toEqual(["FULL_NAME", whatsappNumber ? "WHATSAPP_NUMBER" : "PHONE"]);
          expect(s.questions.some((q) => q.type === "EMAIL")).toBe(email);
          expect(s.disclaimer?.checkboxes).toEqual([{ key: "whatsapp_opt_in", text: CONSENT_TEXT, required: false }]);
          expect(s.thankYou).toMatchObject({ kind: "whatsapp", url: "https://wa.me/919876543210", buttonText: "Chat on WhatsApp" });
          expect(s).toMatchObject({ formType: "more_volume", locale: "en_US", privacyUrl: PRIVACY, privacyLinkText: "Privacy policy" });
        }
      }
      // The suggestion chips fit within the 3 questions of the owner's own.
      const withSuggestions = presetSpec(key, { privacyUrl: PRIVACY });
      withSuggestions.questions.push(...presetSuggestions(key));
      expect(validateSpec(withSuggestions, CTX).problems, key).toEqual([]);
    }
  });

  it("salon asks which service and the preferred day, coaching which class, generic nothing of its own", () => {
    const salon = presetQuestions("salon");
    expect(salon.map((q) => q.key ?? q.type)).toEqual(["FULL_NAME", "PHONE", "which_service", "preferred_day"]);
    expect(salon.map((q) => q.label)).toEqual([undefined, undefined, "Which service?", "Preferred day"]);
    expect(salon[3].options?.map((o) => o.value)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(presetQuestions("coaching").map((q) => q.label ?? q.type)).toEqual(["FULL_NAME", "PHONE", "Which class?"]);
    expect(presetQuestions("generic", { email: true }).map((q) => q.type)).toEqual(["FULL_NAME", "PHONE", "EMAIL"]);
    expect(presetQuestions("salon", { lang: "hi" })[2].label).not.toBe("Which service?");
  });
});

describe("validateSpec", () => {
  const NON_CUSTOM = LEAD_QUESTION_TYPES.filter((t) => t !== "CUSTOM");
  const fifteen = [...NON_CUSTOM.slice(0, 12).map((type) => ({ type })), ...[1, 2, 3].map((n) => ({ type: "CUSTOM", label: `Question ${n}` }))];

  it("takes 15 questions and refuses a 16th, and a fourth question of the owner's own", () => {
    expect(fifteen).toHaveLength(15);
    expect(validateSpec(spec({ questions: fifteen }), CTX).problems).toEqual([]);
    expect(validateSpec(spec({ questions: [...fifteen, { type: NON_CUSTOM[12] }] }), CTX).problems).toContainEqual({ field: "questions", message: "A form can have at most 15 questions." });
    const fourOwn = [{ type: "FULL_NAME" }, { type: "PHONE" }, ...[1, 2, 3, 4].map((n) => ({ type: "CUSTOM", label: `Q${n}` }))];
    expect(validateSpec(spec({ questions: fourOwn }), CTX).problems).toEqual([{ field: "questions", message: "Add at most 3 questions of your own." }]);
  });

  it("refuses an http privacy link, a missing one with the help text, and link text over 70 characters; Promote settings fill a missing link", () => {
    expect(validateSpec(spec({ privacyUrl: "http://fakeshop.example/privacy" }), CTX).problems).toEqual([{ field: "privacyUrl", message: "The link must start with https://" }]);
    expect(validateSpec(spec({ privacyUrl: null }), CTX).problems).toEqual([{ field: "privacyUrl", message: "Meta needs a link to your privacy policy. Edwyz can't host one for you." }]);
    expect(validateSpec(spec({ privacyUrl: null }), { ...CTX, privacyUrl: PRIVACY }).spec?.privacyUrl).toBe(PRIVACY);
    expect(validateSpec(spec({ privacyLinkText: "x".repeat(71) }), CTX).problems).toEqual([{ field: "privacyLinkText", message: LEAD_FORM_COPY.linkText }]);
  });

  it("refuses to make the WhatsApp consent box required or ticked in advance, and any box that asks to message people", () => {
    const box = (c: Row) => spec({ disclaimer: { checkboxes: [c] } });
    expect(validateSpec(box({ key: "whatsapp_opt_in", text: CONSENT_TEXT, required: true }), CTX).problems).toEqual([
      { field: "disclaimer.checkboxes.0", message: "This box can't be required. People choose it themselves." },
    ]);
    expect(validateSpec(box({ key: "whatsapp_opt_in", required: false, checkedByDefault: true }), CTX).problems).toEqual([{ field: "disclaimer.checkboxes.0", message: LEAD_FORM_COPY.precheck }]);
    expect(validateSpec(box({ key: "updates_ok", text: "I agree to receive WhatsApp offers", is_required: true }), CTX).problems[0].message).toBe(LEAD_FORM_COPY.consentRequired);
    // A terms box may be required; the WhatsApp box's text defaults to the consent sentence.
    const ok = validateSpec(spec({ disclaimer: { checkboxes: [{ key: "whatsapp_opt_in" }, { key: "terms", text: "I accept the terms and conditions", required: true }] } }), CTX);
    expect(ok.spec?.disclaimer?.checkboxes).toEqual([
      { key: "whatsapp_opt_in", text: CONSENT_TEXT, required: false },
      { key: "terms", text: "I accept the terms and conditions", required: true },
    ]);
    // The owner may take the consent section off.
    expect(validateSpec(spec({ disclaimer: null }), CTX).spec?.disclaimer).toBeNull();
  });

  it("checks the thank-you button: wa.me to the workspace number by default, or Call, or an https website", () => {
    expect(validateSpec(spec(), { ...CTX, whatsappNumber: null }).problems).toEqual([{ field: "thankYou.url", message: LEAD_FORM_COPY.noWhatsapp }]);
    expect(validateSpec(spec({ thankYou: { kind: "whatsapp", url: "https://evil.example/919876543210" } }), CTX).problems).toEqual([{ field: "thankYou.url", message: LEAD_FORM_COPY.waLink }]);
    expect(validateSpec(spec({ thankYou: { kind: "call" } }), CTX).spec?.thankYou).toMatchObject({ kind: "call", phone: "+919876543210", url: null, buttonText: "Call" });
    expect(validateSpec(spec({ thankYou: { kind: "call", phone: "12345" } }), CTX).problems).toEqual([{ field: "thankYou.phone", message: LEAD_FORM_COPY.phone }]);
    expect(validateSpec(spec({ thankYou: { kind: "website", url: "http://fakeshop.example" } }), CTX).problems).toEqual([{ field: "thankYou.url", message: LEAD_FORM_COPY.website }]);
    expect(validateSpec(spec({ thankYou: { kind: "website", url: "https://fakeshop.example/book" } }), CTX).spec?.thankYou).toMatchObject({ kind: "website", url: "https://fakeshop.example/book" });
    expect(validateSpec(spec({ thankYou: { kind: "sms" } }), CTX).problems).toEqual([{ field: "thankYou.kind", message: LEAD_FORM_COPY.thankYouKind }]);
  });

  it("checks the form type and the language, and needs a way to reach people", () => {
    expect(validateSpec(spec({ formType: "higher_intent" }), CTX).spec?.formType).toBe("higher_intent");
    expect(validateSpec(spec({ formType: "best" }), CTX).problems).toEqual([{ field: "formType", message: LEAD_FORM_COPY.formType }]);
    expect(validateSpec(spec({ locale: "hi_IN" }), CTX).spec?.disclaimer?.checkboxes[0].text).not.toBe(CONSENT_TEXT);
    expect(validateSpec(spec({ locale: "xx_YY" }), CTX).problems).toEqual([{ field: "locale", message: LEAD_FORM_COPY.locale }]);
    expect(validateSpec(spec({ questions: [{ type: "FULL_NAME" }, { type: "CITY" }] }), CTX).problems).toEqual([{ field: "questions", message: LEAD_FORM_COPY.needsContact }]);
    expect(validateSpec(spec({ questions: [{ type: "FULL_NAME" }, { type: "FULL_NAME" }, { type: "PHONE" }] }), CTX).problems).toEqual([{ field: "questions.1", message: LEAD_FORM_COPY.duplicate }]);
    expect(validateSpec("nope", CTX).problems).toEqual([{ field: "spec", message: LEAD_FORM_COPY.spec }]);
  });

  it("the L2 input sends higher intent as is_optimized_for_quality and a wa.me link behind the thank-you button", () => {
    const s = validateSpec(spec({ formType: "higher_intent", intro: { title: "Book a visit", lines: ["Tell us what you need", "We call back in a day"] } }), CTX).spec!;
    const body = toMetaSpec(s);
    expect(body.optimizedForQuality).toBe(true);
    expect(body.thankYouPage).toMatchObject({ button_type: "VIEW_WEBSITE", website_url: "https://wa.me/919876543210" });
    expect(body.contextCard).toEqual({ title: "Book a visit", style: "LIST_STYLE", content: ["Tell us what you need", "We call back in a day"] });
    expect(body.questions[3]).toEqual({ type: "CUSTOM", key: "which_service", label: "Which service?" });
  });
});

// =====================================================================================================================

describe("buildForm (L2 with the Page token, then createForm with origin created)", () => {
  it("registers origin created with the spec, never assumes consent, and checks the terms (C2) before the POST", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    const created = [...s.fake.forms.values()].filter((f) => f.name === "Salon leads");
    expect(created).toHaveLength(1);
    const row = formRow(form.id);
    expect(row).toMatchObject({ tenantId: T, pageAssetId: PAGE, metaFormId: created[0].id, origin: "created", formType: "more_volume", locale: "en_US", metaStatus: "ACTIVE", name: "Salon leads", hiddenAt: null, copiedFromId: null });
    expect(row.spec).toEqual(validateSpec(spec(), CTX).spec);
    expect(form).toMatchObject({ origin: "created", consentAssumed: false, consentAssumedApplies: false, formType: "more_volume" });
    expect(mem.rows("platformSetting").filter((r) => String(r.key).startsWith("leads:form-settings"))).toEqual([]);
    expect(s.fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${FAKE_PAGE_ID}`, `POST ${FAKE_PAGE_ID}/leadgen_forms`]);
    expect(s.posts()[0].tokenKind).toBe("page");
    expect(audits()).toContain("lead.form_created");
    s.fake.assertClean();
  });

  it("sends the consent box as whatsapp_opt_in, not required and not ticked by default", async () => {
    const s = setup();
    await buildForm(actor(), PAGE, spec(), s.deps);
    const body = s.posts()[0].body as { custom_disclaimer: { body: unknown; checkboxes: Row[] }; questions: Row[]; privacy_policy: Row; thank_you_page: Row; is_optimized_for_quality: boolean };
    expect(body.custom_disclaimer.checkboxes).toEqual([{ key: "whatsapp_opt_in", text: CONSENT_TEXT, is_required: false, is_checked_by_default: false }]);
    // Meta's custom_disclaimer.body is an object {text, url_entities}, not a plain string.
    expect(body.custom_disclaimer.body).toEqual({ text: "Tick the box if you'd like messages from Fake Shop on WhatsApp. You can reply STOP at any time to stop them." });
    expect(body.privacy_policy).toEqual({ url: PRIVACY, link_text: "Privacy policy" });
    expect(body.thank_you_page).toMatchObject({ button_type: "VIEW_WEBSITE", website_url: "https://wa.me/919876543210" });
    expect(body.questions.map((q) => q.type)).toEqual(["FULL_NAME", "PHONE", "EMAIL", "CUSTOM", "CUSTOM"]);
    expect(body.is_optimized_for_quality).toBe(false);
  });

  it("registers the consent box's words as the form's consentText, so a lead who ticks it records the sentence, not the key", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    expect(formRow(form.id).consentText).toBe(CONSENT_TEXT);
    expect(form).toMatchObject({ consentText: CONSENT_TEXT, consentAssumed: false, consentTextNotUsed: false });
    // No consent section: no consent text. A terms box is not consent; every consent box's words are kept.
    const bare = await buildForm(actor(), PAGE, spec({ name: "No consent", disclaimer: null }), s.deps);
    expect(formRow(bare.id).consentText).toBeNull();
    const two = validateSpec(spec({ disclaimer: { checkboxes: [{ key: "whatsapp_opt_in" }, { key: "terms", text: "I accept the terms", required: true }, { key: "offers_ok", text: "I agree to receive WhatsApp offers" }] } }), CTX).spec!;
    expect(consentTextOf(two)).toBe(`${CONSENT_TEXT}\nI agree to receive WhatsApp offers`);
    const copy = await copyForm(actor(), form.id, spec({ name: "Salon leads v2" }), s.deps);
    expect(formRow(copy.id).consentText).toBe(CONSENT_TEXT);
  });

  it("refuses a required consent box, a 16th question or an http link before any Meta call", async () => {
    const s = setup();
    for (const bad of [
      spec({ disclaimer: { checkboxes: [{ key: "whatsapp_opt_in", text: CONSENT_TEXT, required: true }] } }),
      spec({ privacyUrl: "http://fakeshop.example/privacy" }),
      spec({ questions: [...presetQuestions("salon"), ...LEAD_QUESTION_TYPES.filter((t) => t !== "CUSTOM").slice(2, 14).map((type) => ({ type }))] }),
    ]) {
      await expect(buildForm(actor(), PAGE, bad, s.deps)).rejects.toBeInstanceOf(FormSpecError);
    }
    expect(s.fetch).not.toHaveBeenCalled();
    expect(formRows()).toEqual([]);
  });

  it("without Lead Gen terms: the leadgen_tos Opens Meta fix and zero POSTs", async () => {
    const s = setup();
    s.fake.scenario("leadgen_terms_missing");
    const error = await buildForm(actor(), PAGE, spec(), s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeadgenTermsRefusal);
    expect(error).toMatchObject({ status: 409, code: "leadgen_tos", fix: { kind: "opens_meta", key: "leadgen_tos" }, message: "Accept Meta's lead ad terms for Fake Shop first." });
    expect(s.fake.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(formRows()).toEqual([]);
    const res = leadFormErrorResponse(error)!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Accept Meta's lead ad terms for Fake Shop first.",
      code: "leadgen_tos",
      fix: { kind: "opens_meta", key: "leadgen_tos", label: "Accept Meta's lead ad terms (opens Meta, one time)" },
    });
  });

  it("when C2 can't tell, Meta's terms refusal of the POST gives the same fix", async () => {
    const s = setup();
    s.fake.scenario("leadgen_terms_missing");
    const unknown: Partial<LeadFormDeps> = { ...s.deps, meta: { ...s.meta, getPageReadiness: async () => ({ leadgenTermsAccepted: null, whatsappNumber: null, whatsappNumberChecked: false }) } };
    await expect(buildForm(actor(), PAGE, spec(), unknown)).rejects.toBeInstanceOf(LeadgenTermsRefusal);
    expect(formRows()).toEqual([]);
  });

  it("refuses a Page of another workspace with no Meta call", async () => {
    const s = setup();
    await expect(buildForm(actor(), "other_page", spec(), s.deps)).rejects.toMatchObject({ status: 404 });
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("uses the privacy link saved in Promote settings when the form has none", async () => {
    const s = setup();
    await setPromoteSettings(T, { privacyUrl: PRIVACY });
    const form = await buildForm(actor(), PAGE, spec({ privacyUrl: undefined }), s.deps);
    expect((formRow(form.id).spec as Row).privacyUrl).toBe(PRIVACY);
  });

  it("an ambiguous POST is settled by name when exactly one unknown form has it, and never sent again", async () => {
    const s = setup();
    s.fake.failNextCreate({ match: /leadgen_forms$/ });
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    const named = [...s.fake.forms.values()].filter((f) => f.name === "Salon leads");
    expect(named).toHaveLength(1);
    expect(form.metaFormId).toBe(named[0].id);
    expect(s.posts()).toHaveLength(1);
    s.fake.failNextCreate({ match: /leadgen_forms$/, apply: false });
    await expect(buildForm(actor(), PAGE, spec(), s.deps)).rejects.toMatchObject({ status: 504, message: LEAD_FORM_COPY.ambiguous });
    expect(s.posts()).toHaveLength(2);
    expect(formRows()).toHaveLength(1);
  });
});

describe("createForm guards for built forms (D35)", () => {
  it("refuses consentAssumed on a created form, at registration and later", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    await expect(createForm(actor(), { metaFormId: "123123", pageAssetId: PAGE, consentAssumed: true }, { origin: "created" })).rejects.toMatchObject({ status: 400, message: CREATED_FORM_CONSENT });
    await expect(updateForm(actor(), form.id, { consentAssumed: true })).rejects.toMatchObject({ status: 400, message: CREATED_FORM_CONSENT });
    // Re-registering it through the old register route's path cannot turn it on either.
    await expect(createForm(actor(), { metaFormId: form.metaFormId, pageAssetId: PAGE, consentAssumed: true })).rejects.toMatchObject({ status: 400 });
    expect(mem.rows("platformSetting").filter((r) => String(r.key).startsWith("leads:form-settings"))).toEqual([]);
  });
});

describe("copyForm (editing makes a copy, D13)", () => {
  it("creates a new Meta form with copiedFromId and leaves the original as it is", async () => {
    const s = setup();
    const original = await buildForm(actor(), PAGE, spec(), s.deps);
    const edited = spec({ name: undefined, formType: "higher_intent" });
    const copy = await copyForm(actor(), original.id, edited, s.deps);
    expect(copy.id).not.toBe(original.id);
    expect(copy.metaFormId).not.toBe(original.metaFormId);
    expect(copy).toMatchObject({ origin: "created", copiedFromId: original.id, name: "Salon leads (copy)", formType: "higher_intent" });
    expect(s.posts()).toHaveLength(2);
    expect((s.posts()[1].body as Row).is_optimized_for_quality).toBe(true);
    expect(formRow(original.id)).toMatchObject({ copiedFromId: null, hiddenAt: null, formType: "more_volume" });
    expect(audits()).toContain("lead.form_copied");
    // With no spec the stored one is copied.
    const again = await copyForm(actor(), original.id, undefined, s.deps);
    expect(again).toMatchObject({ copiedFromId: original.id, name: "Salon leads" });
    // Nothing is sent for another workspace's form.
    await expect(copyForm(actor("admin", "t2"), original.id, edited, s.deps)).rejects.toMatchObject({ status: 404 });
    expect(s.posts()).toHaveLength(3);
  });
});

describe("importForm (E-R7: L1 and L3, origin imported)", () => {
  it("stores origin imported with the name, status and questions, and the consent boxes for lead sync", async () => {
    const s = setup();
    const seeded = s.fake.forms.get(FAKE_FORM_ID)!;
    s.fake.forms.set(FAKE_FORM_ID, {
      ...seeded,
      questions: [{ type: "FULL_NAME", key: "full_name" }, { type: "PHONE", key: "phone_number" }, { type: "CUSTOM", key: "offers_ok", label: "I agree to get WhatsApp offers" }],
    });
    const form = await importForm(actor(), PAGE, FAKE_FORM_ID, s.deps);
    const row = formRow(form.id);
    expect(row).toMatchObject({ origin: "imported", name: "Diwali offer", metaFormId: FAKE_FORM_ID, metaStatus: "ACTIVE", locale: "en_US", pageAssetId: PAGE });
    expect((row.spec as Row).questions).toEqual([
      { type: "FULL_NAME", key: "full_name" },
      { type: "PHONE", key: "phone_number" },
      { type: "CUSTOM", key: "offers_ok", label: "I agree to get WhatsApp offers" },
    ]);
    expect(form).toMatchObject({ origin: "imported", consentDefinitionRead: true, consentQuestionKeys: ["offers_ok"] });
    expect(s.fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(s.fake.calls.map((c) => c.path)).toEqual([`${FAKE_PAGE_ID}/leadgen_forms`, FAKE_FORM_ID]);
    expect(audits()).toContain("lead.form_imported");
  });

  it("refuses a form that isn't on the Page, and keeps a built form's origin when it is imported later", async () => {
    const s = setup();
    await expect(importForm(actor(), PAGE, "123456789", s.deps)).rejects.toMatchObject({ status: 404, message: LEAD_FORM_COPY.notOnPage });
    expect(formRows()).toEqual([]);
    const built = await buildForm(actor(), PAGE, spec(), s.deps);
    const builtSpec = formRow(built.id).spec;
    const again = await importForm(actor(), PAGE, built.metaFormId, s.deps);
    expect(again).toMatchObject({ id: built.id, origin: "created", formType: "more_volume" });
    expect(formRow(built.id).spec).toEqual(builtSpec);
  });

  it("reads Meta's locale in either case (Meta documents EN_US, HI_IN) and stores it as en_US", async () => {
    const s = setup();
    s.fake.forms.set(FAKE_FORM_ID, { ...s.fake.forms.get(FAKE_FORM_ID)!, locale: "HI_IN" });
    const form = await importForm(actor(), PAGE, FAKE_FORM_ID, s.deps);
    expect(formRow(form.id).locale).toBe("hi_IN");
    expect((formRow(form.id).spec as Row).locale).toBe("hi_IN");
    s.fake.forms.set(FAKE_FORM_ID, { ...s.fake.forms.get(FAKE_FORM_ID)!, locale: "not a locale" });
    await importForm(actor(), PAGE, FAKE_FORM_ID, s.deps);
    expect(formRow(form.id).locale).toBeNull();
  });
});

describe("hideForm (local only, never archived on Meta)", () => {
  it("removes the form from listForms, and undo restores it", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    const callsBefore = s.fake.calls.length;
    expect((await listForms(T)).map((f) => f.id)).toEqual([form.id]);
    expect(await hideForm(actor(), form.id, false, { now: () => T0 })).toEqual({ id: form.id, hidden: true });
    expect(await listForms(T)).toEqual([]);
    expect((await listForms(T, { includeHidden: true }))[0]).toMatchObject({ id: form.id, hidden: true });
    expect(await unhideForm(actor(), form.id)).toEqual({ id: form.id, hidden: false });
    expect((await listForms(T)).map((f) => f.id)).toEqual([form.id]);
    expect(s.fake.calls.length).toBe(callsBefore);
    expect(audits()).toEqual(expect.arrayContaining(["lead.form_hidden", "lead.form_unhidden"]));
    await expect(hideForm(actor("admin", "t2"), form.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("sendTestLead (L4, D33)", () => {
  it("fills the answers, stores the returned lead id under the Page key, and sets testLeadUntil", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    const r = await sendTestLead(actor(), form.id, s.deps);
    expect(r).toMatchObject({ formId: form.id, code: "ABC123", testLeadUntil: new Date(T0.getTime() + TEST_SENT_MS) });
    const [call] = s.posts(/\/test_leads$/);
    expect(call).toMatchObject({ path: `${form.metaFormId}/test_leads`, tokenKind: "page" });
    const lead = s.fake.leads.get(r.testLeadId)!;
    expect(lead.fieldData).toEqual([
      { name: "full_name", values: ["Edwyz test lead ABC123"] },
      { name: "phone_number", values: [TEST_LEAD_PHONE] },
      { name: "email", values: ["test.lead.abc123@example.com"] },
      { name: "which_service", values: ["Edwyz test lead ABC123"] },
      { name: "preferred_day", values: ["mon"] },
    ]);
    expect(hasTestAnswers(lead.fieldData)).toBe(true);
    expect(settingRow(testLeadsKey(FAKE_PAGE_ID))?.value).toEqual({ leads: [{ id: r.testLeadId, at: T0.toISOString() }] });
    expect(await isStoredTestLead(FAKE_PAGE_ID, r.testLeadId, T0)).toBe(true);
    expect(await isStoredTestLead(FAKE_PAGE_ID, r.testLeadId, new Date(T0.getTime() + 31 * 86_400_000))).toBe(false);
    expect(formRow(form.id).testLeadUntil).toEqual(new Date(T0.getTime() + TEST_SENT_MS));
    expect((await listForms(T))[0].testLeadUntil).toEqual(new Date(T0.getTime() + TEST_SENT_MS));
    expect(audits()).toContain("lead.test_lead_sent");
    // A second test lead keeps the first id.
    const second = await sendTestLead(actor(), form.id, s.deps);
    expect(((settingRow(testLeadsKey(FAKE_PAGE_ID))?.value as { leads: { id: string }[] }).leads).map((e) => e.id)).toEqual([r.testLeadId, second.testLeadId]);
  });

  it("fills only the answers it knows the names of, and lets Meta fill the rest (or all, when the questions are unknown)", async () => {
    expect(testFieldData(null, "X")).toBeUndefined();
    expect(testFieldData({ questions: [{ type: "CITY" }] }, "X")).toBeUndefined();
    const s = setup();
    const imported = await importForm(actor(), PAGE, FAKE_FORM_ID, s.deps);
    const r = await sendTestLead(actor(), imported.id, s.deps);
    expect(s.fake.leads.get(r.testLeadId)?.fieldData).toEqual([
      { name: "full_name", values: ["Edwyz test lead ABC123"] },
      { name: "phone_number", values: [TEST_LEAD_PHONE] },
    ]);
  });

  it("the 11th test lead in an hour gets 429, per form", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    for (let i = 0; i < 10; i++) await sendTestLead(actor(), form.id, s.deps);
    await expect(sendTestLead(actor(), form.id, s.deps)).rejects.toMatchObject({ status: 429, message: LEAD_FORM_COPY.testLimit });
    expect(s.posts(/\/test_leads$/)).toHaveLength(10);
    const other = await buildForm(actor(), PAGE, spec({ name: "Other form" }), s.deps);
    await expect(sendTestLead(actor(), other.id, s.deps)).resolves.toMatchObject({ formId: other.id });
  });

  it("refuses another workspace's form without sending anything", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    await expect(sendTestLead(actor("admin", "t2"), form.id, s.deps)).rejects.toMatchObject({ status: 404 });
    expect(s.posts(/\/test_leads$/)).toEqual([]);
  });

  it("answers 409 and sends nothing while lead ingest doesn't mark test leads yet, so none is handled as a real lead", async () => {
    const s = setup();
    const form = await buildForm(actor(), PAGE, spec(), s.deps);
    const closed = { ...s.deps, testLeadsReady: false };
    await expect(sendTestLead(actor(), form.id, closed)).rejects.toMatchObject({ status: 409, message: "Test leads aren't available yet." });
    expect(LEAD_FORM_COPY.testLeadsNotReady).toBe("Test leads aren't available yet.");
    expect(s.posts(/\/test_leads$/)).toEqual([]);
    expect(settingRow(testLeadsKey(FAKE_PAGE_ID))).toBeUndefined();
    expect(formRow(form.id).testLeadUntil).toBeNull();
    expect(audits()).not.toContain("lead.test_lead_sent");
    // Left to the default, the gate follows TEST_LEADS_MARKED_ON_INGEST.
    const byDefault = sendTestLead(actor(), form.id, { ...s.deps, testLeadsReady: undefined });
    if (TEST_LEADS_MARKED_ON_INGEST) await expect(byDefault).resolves.toMatchObject({ formId: form.id });
    else await expect(byDefault).rejects.toMatchObject({ status: 409 });
  });

  it("the gate opens only together with lead ingest marking test leads (D33: isTestLead and Lead.isTest in leads/ingest.ts)", () => {
    const ingest = readFileSync(path.resolve(__dirname, "../src/lib/leads/ingest.ts"), "utf8");
    const marks = /\bisTestLead\s*\(/.test(ingest) && /\bisTest\b/.test(ingest);
    expect(TEST_LEADS_MARKED_ON_INGEST, "Set TEST_LEADS_MARKED_ON_INGEST in src/lib/promote/test-leads.ts to whether src/lib/leads/ingest.ts marks test leads.").toBe(marks);
  });

  it("recognises Edwyz's dummy phone and email as test answers, so a form with no free-text question is caught too", () => {
    for (const v of [TEST_LEAD_PHONE, "+1 202-555-0142", "12025550142", "(202) 555-0142", "test.lead.abc123@example.com", " TEST.LEAD.ABC123@EXAMPLE.COM ", "Edwyz test lead ABC123", "<test lead: dummy data for email>"]) {
      expect(looksLikeTestAnswer(v), v).toBe(true);
    }
    for (const v of ["+91 98765 43210", "+12025550143", "someone@example.com", "test.lead@example.org", "Call 12025550142 later", "", null, 12025550142]) {
      expect(looksLikeTestAnswer(v), String(v)).toBe(false);
    }
    const contactOnly = testFieldData({ questions: [{ type: "EMAIL" }, { type: "PHONE" }] }, "ABC123")!;
    expect(contactOnly).toEqual([
      { name: "email", values: ["test.lead.abc123@example.com"] },
      { name: "phone_number", values: [TEST_LEAD_PHONE] },
    ]);
    expect(hasTestAnswers(contactOnly)).toBe(true);
    expect(hasTestAnswers({ phone_number: "+12025550142" })).toBe(true);
    expect(hasTestAnswers({ phone_number: "+919876543210", email: "asha@fakeshop.example", full_name: "Asha" })).toBe(false);
  });
});

describe("ensureDraftForm (one form per draft, 3.5)", () => {
  it("creates the draft's form once, named with the draft id, and reuses it on every retry", async () => {
    const s = setup();
    const first = await ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps);
    expect(first).toMatchObject({ reused: false, specMatches: true });
    expect(first.form.name).toBe("Salon leads [draft1]");
    expect(draftFormName("x".repeat(200), "draft1")).toHaveLength(120);
    const again = await ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps);
    expect(again).toMatchObject({ reused: true, specMatches: true, form: { id: first.form.id } });
    const edited = await ensureDraftForm(actor(), "draft1", PAGE, spec({ formType: "higher_intent" }), s.deps);
    expect(edited).toMatchObject({ reused: true, specMatches: false, form: { id: first.form.id } });
    expect(s.posts()).toHaveLength(1);
    expect([...s.fake.forms.values()].filter((f) => f.name === "Salon leads [draft1]")).toHaveLength(1);
  });

  it("reuses a created form linked from one of the draft's ads", async () => {
    const s = setup();
    const built = await buildForm(actor(), PAGE, spec({ name: "Linked" }), s.deps);
    mem.seed("adSet", [{ id: "as4", tenantId: T, campaignId: "draft4" }]);
    mem.seed("ad", [{ id: "ad4", tenantId: T, adSetId: "as4", creative: { leadFormId: built.metaFormId } }]);
    const r = await ensureDraftForm(actor(), "draft4", PAGE, spec(), s.deps);
    expect(r).toMatchObject({ reused: true, form: { id: built.id } });
    expect(s.posts()).toHaveLength(1);
  });

  it("settles an ambiguous POST by the exact name before anything else, with exactly one form", async () => {
    const s = setup();
    s.fake.failNextCreate({ match: /leadgen_forms$/ });
    const r = await ensureDraftForm(actor(), "draft2", PAGE, spec(), s.deps);
    const named = [...s.fake.forms.values()].filter((f) => f.name === "Salon leads [draft2]");
    expect(named).toHaveLength(1);
    expect(r).toMatchObject({ reused: false, form: { metaFormId: named[0].id, origin: "created" } });
    expect(formRows().filter((f) => f.metaFormId === named[0].id)).toHaveLength(1);
    expect(s.posts()).toHaveLength(1);
    const seq = s.fake.calls.map((c) => `${c.method} ${c.path}`);
    const post = seq.indexOf(`POST ${FAKE_PAGE_ID}/leadgen_forms`);
    expect(seq.slice(0, post)).toEqual([`GET ${FAKE_PAGE_ID}`, `GET ${FAKE_PAGE_ID}/leadgen_forms`]);
    expect(seq[post + 1]).toBe(`GET ${FAKE_PAGE_ID}/leadgen_forms`);
    expect(seq).toHaveLength(post + 2);
  });

  it("an unconfirmed POST that Meta never applied is not sent again; a later try finds a form Meta saved late by its name", async () => {
    const s = setup();
    s.fake.failNextCreate({ match: /leadgen_forms$/, apply: false });
    await expect(ensureDraftForm(actor(), "draft3", PAGE, spec(), s.deps)).rejects.toMatchObject({ status: 504, message: LEAD_FORM_COPY.ambiguous });
    expect(s.posts()).toHaveLength(1);
    expect(formRows()).toEqual([]);
    // Meta saved it after all: the next try registers it instead of posting a second form.
    s.fake.forms.set("424242424242", { id: "424242424242", pageId: FAKE_PAGE_ID, name: "Salon leads [draft3]", status: "ACTIVE", locale: "en_US", questions: [{ type: "FULL_NAME" }], privacyPolicyUrl: PRIVACY, createdTime: "2026-10-31T10:00:00+0000" });
    const r = await ensureDraftForm(actor(), "draft3", PAGE, spec(), s.deps);
    expect(r).toMatchObject({ reused: true, form: { metaFormId: "424242424242", origin: "created" } });
    expect(s.posts()).toHaveLength(1);
  });

  it("refuses another workspace's draft, and Lead Gen terms are checked before any POST", async () => {
    const s = setup();
    await expect(ensureDraftForm(actor("admin", "t2"), "draft1", "other_page", spec(), s.deps)).rejects.toMatchObject({ status: 404, message: LEAD_FORM_COPY.draftNotFound });
    s.fake.scenario("leadgen_terms_missing");
    await expect(ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps)).rejects.toBeInstanceOf(LeadgenTermsRefusal);
    expect(s.fake.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("after an edit makes a copy, the copy is the draft's form: the next Start makes no new form (D13)", async () => {
    const s = setup();
    const first = await ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps);
    const edited = spec({ formType: "higher_intent" });
    expect(await ensureDraftForm(actor(), "draft1", PAGE, edited, s.deps)).toMatchObject({ reused: true, specMatches: false, form: { id: first.form.id } });
    const copy = await copyForm(actor(), first.form.id, edited, s.deps);
    expect(copy).toMatchObject({ name: "Salon leads [draft1]", copiedFromId: first.form.id, formType: "higher_intent" });
    expect(draftIdOfName(copy.name)).toBe("draft1");
    expect(s.posts()).toHaveLength(2);
    const again = await ensureDraftForm(actor(), "draft1", PAGE, edited, s.deps);
    expect(again).toMatchObject({ reused: true, specMatches: true, form: { id: copy.id } });
    expect(s.posts()).toHaveLength(2);
    // A second edit copies the copy, and the newest copy is the draft's form. Retries send nothing.
    const edited2 = spec({ formType: "higher_intent", privacyLinkText: "Our privacy policy" });
    const copy2 = await copyForm(actor(), again.form.id, edited2, s.deps);
    for (let i = 0; i < 2; i++) expect(await ensureDraftForm(actor(), "draft1", PAGE, edited2, s.deps)).toMatchObject({ specMatches: true, form: { id: copy2.id } });
    expect(s.posts()).toHaveLength(3);
    // A copy with no name of its own keeps the suffix after "(copy)".
    const unnamed = await copyForm(actor(), copy2.id, spec({ name: undefined, formType: "higher_intent" }), s.deps);
    expect(unnamed.name).toBe("Salon leads (copy) [draft1]");
    expect(draftIdOfName("Salon leads")).toBeNull();
  });

  it("an unnamed draft's form reads the same on another day: the dated default name is not an edit", async () => {
    const s = setup();
    const unnamed = spec({ name: undefined });
    const day1 = await ensureDraftForm(actor(), "draft1", PAGE, unnamed, s.deps);
    expect(day1.form.name).toBe("Instant form 2026-10-31 [draft1]");
    const nextDay = new Date(T0.getTime() + 86_400_000);
    const day2 = await ensureDraftForm(actor(), "draft1", PAGE, unnamed, { ...s.deps, now: () => nextDay });
    expect(day2).toMatchObject({ reused: true, specMatches: true, form: { id: day1.form.id } });
    expect(s.posts()).toHaveLength(1);
    const a = validateSpec(unnamed, CTX).spec!;
    const b = validateSpec(unnamed, { ...CTX, now: nextDay }).spec!;
    expect(a.name).not.toBe(b.name);
    expect(formSpecHash(a)).toBe(formSpecHash(b));
    expect(formSpecHash(validateSpec(spec({ name: undefined, formType: "higher_intent" }), CTX).spec!)).not.toBe(formSpecHash(a));
  });

  it("a form Meta saved late from an earlier try keeps the spec only when its questions and privacy link match it", async () => {
    const s = setup();
    const saved = (id: string, name: string, questions: unknown[]) =>
      s.fake.forms.set(id, { id, pageId: FAKE_PAGE_ID, name, status: "ACTIVE", locale: "EN_US", questions, privacyPolicyUrl: PRIVACY, createdTime: "2026-10-30T10:00:00+0000" });
    // Saved with the same questions: registered with the spec.
    const named = { ...validateSpec(spec(), CTX).spec!, name: "Salon leads [draft1]" };
    saved("515151515151", named.name, toMetaSpec(named).questions);
    const same = await ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps);
    expect(same).toMatchObject({ reused: true, specMatches: true, form: { metaFormId: "515151515151", origin: "created" } });
    expect(formRow(same.form.id).spec).toEqual(named);
    expect(formRow(same.form.id).consentText).toBe(CONSENT_TEXT);
    // The owner changed the questions before the retry, and the unnamed draft's dated name is from the day before: the row says
    // what Meta saved, and the caller is told to make a copy.
    saved("525252525252", "Instant form 2026-10-30 [draft2]", [{ type: "FULL_NAME" }, { type: "PHONE" }]);
    const changed = await ensureDraftForm(actor(), "draft2", PAGE, spec({ name: undefined }), s.deps);
    expect(changed).toMatchObject({ reused: true, specMatches: false, form: { metaFormId: "525252525252", origin: "created", name: "Instant form 2026-10-30 [draft2]", locale: "en_US" } });
    expect(formRow(changed.form.id)).toMatchObject({ spec: { source: "meta", questions: [{ type: "FULL_NAME" }, { type: "PHONE" }], privacyUrl: PRIVACY, locale: "en_US" }, formType: null, consentText: null });
    expect(await ensureDraftForm(actor(), "draft2", PAGE, spec({ name: undefined }), s.deps)).toMatchObject({ specMatches: false, form: { id: changed.form.id } });
    // A different privacy link is a different form too.
    saved("535353535353", "Salon leads [draft3]", toMetaSpec({ ...named, name: "Salon leads [draft3]" }).questions);
    s.fake.forms.set("535353535353", { ...s.fake.forms.get("535353535353")!, privacyPolicyUrl: "https://fakeshop.example/old-privacy" });
    expect(await ensureDraftForm(actor(), "draft3", PAGE, spec(), s.deps)).toMatchObject({ specMatches: false, form: { metaFormId: "535353535353" } });
    expect(s.posts()).toEqual([]);
  });

  it("takes the form the draft's ad uses before the newest form named for the draft", async () => {
    const s = setup();
    const used = await buildForm(actor(), PAGE, spec({ name: "Used by the ad" }), s.deps);
    const own = await ensureDraftForm(actor(), "draft4", PAGE, spec(), s.deps);
    expect(own.form.id).not.toBe(used.id);
    mem.seed("adSet", [{ id: "as4", tenantId: T, campaignId: "draft4" }]);
    mem.seed("ad", [{ id: "ad4", tenantId: T, adSetId: "as4", creative: { leadFormId: used.id } }]);
    expect(await ensureDraftForm(actor(), "draft4", PAGE, spec(), s.deps)).toMatchObject({ reused: true, form: { id: used.id } });
    expect(s.posts()).toHaveLength(2);
  });
});

describe("listMetaForms (list_lead_forms)", () => {
  it("lists local and Meta forms without registering any", async () => {
    const s = setup();
    const built = await buildForm(actor(), PAGE, spec(), s.deps);
    const rowsBefore = formRows().length;
    const r = await listMetaForms(actor(), PAGE, s.deps);
    expect(r.local.map((f) => f.id)).toEqual([built.id]);
    expect(r.meta.map((f) => f.metaFormId).sort()).toEqual([FAKE_FORM_ID, built.metaFormId].sort());
    expect(r.meta.find((f) => f.metaFormId === built.metaFormId)).toMatchObject({ localId: built.id, origin: "created", hidden: false });
    expect(r.meta.find((f) => f.metaFormId === FAKE_FORM_ID)).toMatchObject({ localId: null, name: "Diwali offer" });
    expect(formRows()).toHaveLength(rowsBefore);
  });
});

describe("dry run", () => {
  it("makes zero fetches: build, copy, test lead, the draft's form, import and the list answer with fake ids", async () => {
    const s = setup({ dryRun: true });
    const built = await buildForm(actor(), PAGE, spec(), s.deps);
    expect(built.metaFormId).toMatch(/^dryrun_leadform_/);
    expect(formRow(built.id)).toMatchObject({ origin: "created" });
    const copy = await copyForm(actor(), built.id, spec({ name: "Salon leads v2" }), s.deps);
    expect(copy).toMatchObject({ copiedFromId: built.id });
    const test = await sendTestLead(actor(), built.id, s.deps);
    expect(test.testLeadId).toMatch(/^dryrun_testlead_/);
    const draft = await ensureDraftForm(actor(), "draft1", PAGE, spec(), s.deps);
    expect(draft.form.metaFormId).toMatch(/^dryrun_leadform_/);
    const imported = await importForm(actor(), PAGE, "556677", s.deps);
    expect(imported).toMatchObject({ origin: "imported", metaFormId: "556677" });
    expect(await listMetaForms(actor(), PAGE, s.deps)).toMatchObject({ meta: [], dryRun: true });
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
  });
});

// =====================================================================================================================

describe("routes (4.8: promote guard, admin, same origin, fake ids under dry run)", () => {
  const post = (path: string, body?: unknown, origin: string | null = ORIGIN) =>
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (path: string) => new Request(`${ORIGIN}${path}`);

  function wireFake(): { fake: FakeMetaPromote; fetch: ReturnType<typeof vi.fn> } {
    const fake = createFakeMetaPromote();
    const fetch = vi.fn(fake.fetch);
    vi.stubGlobal("fetch", fetch);
    h.access.mockImplementation(async (_t: string, assetId: string) => {
      if (assetId !== PAGE) throw new HttpError(404, "Asset not found.");
      return { assetId: PAGE, type: "page", externalId: FAKE_PAGE_ID, name: "Fake Shop", token: fake.pageToken() } satisfies AssetAccess;
    });
    return { fake, fetch };
  }

  const all = (id: string) => [
    () => buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }), {}),
    () => metaRoute(get(`/api/leads/forms/meta?pageAssetId=${PAGE}`), {}),
    () => copyRoute(post(`/api/leads/forms/${id}/copy`, { spec: spec() }), ctx(id)),
    () => testLeadRoute(post(`/api/leads/forms/${id}/test-lead`), ctx(id)),
    () => hideRoute(post(`/api/leads/forms/${id}/hide`, {}), ctx(id)),
  ];

  it("answer 404 while PROMOTE_ENABLED is off, before looking up the caller", async () => {
    const { fetch } = wireFake();
    for (const call of all("form_x")) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: PROMOTE_NOT_FOUND });
    }
    expect(h.getActor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("give 403 to agents (the list too) and refuse cross-origin or origin-less writes", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const { fetch } = wireFake();
    h.getActor.mockResolvedValue(actor("agent"));
    for (const call of all("form_x")) expect((await call()).status).toBe(403);
    const write = await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }), {});
    expect(await write.json()).toEqual({ error: PROMOTE_WRITERS_ONLY });
    h.getActor.mockResolvedValue(actor("admin"));
    for (const origin of ["https://evil.example", null]) {
      expect((await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }, origin), {})).status).toBe(403);
      expect((await testLeadRoute(post("/api/leads/forms/form_x/test-lead", undefined, origin), ctx("form_x"))).status).toBe(403);
      expect((await hideRoute(post("/api/leads/forms/form_x/hide", {}, origin), ctx("form_x"))).status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(formRows()).toEqual([]);
  });

  it("work end to end under SPEND_DRY_RUN with fake ids and zero fetches; test leads wait for lead ingest (409), then the 11th in an hour gets 429", async () => {
    process.env.PROMOTE_ENABLED = "on";
    process.env.SPEND_DRY_RUN = "1";
    const { fetch } = wireFake();
    const built = await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }), {});
    expect(built.status).toBe(201);
    const { form, dryRun } = (await built.json()) as { form: { id: string; metaFormId: string; origin: string }; dryRun: boolean };
    expect(dryRun).toBe(true);
    expect(form).toMatchObject({ origin: "created" });
    expect(form.metaFormId).toMatch(/^dryrun_leadform_/);

    const listed = await metaRoute(get(`/api/leads/forms/meta?pageAssetId=${PAGE}`), {});
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toMatchObject({ local: [{ id: form.id }], meta: [], dryRun: true });

    const copied = await copyRoute(post(`/api/leads/forms/${form.id}/copy`, { spec: spec({ name: "Copy" }) }), ctx(form.id));
    expect(copied.status).toBe(201);
    expect(((await copied.json()) as { form: { copiedFromId: string } }).form.copiedFromId).toBe(form.id);

    if (TEST_LEADS_MARKED_ON_INGEST) {
      for (let i = 0; i < 10; i++) {
        const sent = await testLeadRoute(post(`/api/leads/forms/${form.id}/test-lead`), ctx(form.id));
        expect(sent.status, `test lead ${i + 1}`).toBe(200);
      }
      const eleventh = await testLeadRoute(post(`/api/leads/forms/${form.id}/test-lead`), ctx(form.id));
      expect(eleventh.status).toBe(429);
      expect(await eleventh.json()).toEqual({ error: LEAD_FORM_COPY.testLimit });
    } else {
      const refused = await testLeadRoute(post(`/api/leads/forms/${form.id}/test-lead`), ctx(form.id));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: LEAD_FORM_COPY.testLeadsNotReady });
      expect(formRow(form.id).testLeadUntil).toBeNull();
    }

    expect(await (await hideRoute(post(`/api/leads/forms/${form.id}/hide`), ctx(form.id))).json()).toEqual({ id: form.id, hidden: true });
    expect(await (await hideRoute(post(`/api/leads/forms/${form.id}/hide`, { undo: true }), ctx(form.id))).json()).toEqual({ id: form.id, hidden: false });
    expect((await hideRoute(post(`/api/leads/forms/${form.id}/hide`, { undo: "yes" }), ctx(form.id))).status).toBe(400);
    expect((await hideRoute(post(`/api/leads/forms/nope/hide`), ctx("nope"))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POST /api/leads/forms imports the Page's form while Promote is open (E-R7: origin imported, name, status, questions), and registers by id while it is off", async () => {
    const { fake, fetch } = wireFake();
    const register = (body: Row, origin: string | null = ORIGIN) => registerRoute(post("/api/leads/forms", body, origin));
    // Promote off: registered by its id, nothing read from Meta.
    const plain = await register({ pageAssetId: PAGE, metaFormId: FAKE_FORM_ID });
    expect(plain.status).toBe(201);
    expect(formRows()).toEqual([expect.objectContaining({ metaFormId: FAKE_FORM_ID, origin: "registered", name: null, spec: null })]);
    expect(fetch).not.toHaveBeenCalled();

    process.env.PROMOTE_ENABLED = "on";
    const res = await register({ pageAssetId: PAGE, metaFormId: FAKE_FORM_ID, consentText: "I agree to get WhatsApp updates" });
    expect(res.status).toBe(201);
    const { form } = (await res.json()) as { form: Row & { id: string } };
    expect(form).toMatchObject({ origin: "imported", name: "Diwali offer", metaStatus: "ACTIVE", locale: "en_US", consentText: "I agree to get WhatsApp updates", consentDefinitionRead: true });
    expect(formRows()).toHaveLength(1);
    expect(formRow(form.id)).toMatchObject({ origin: "imported", name: "Diwali offer", metaStatus: "ACTIVE", spec: { source: "meta", questions: [{ type: "FULL_NAME" }, { type: "PHONE" }] } });
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(audits()).toContain("lead.form_imported");

    // A bad setting is refused before Meta is read, and so is a form that isn't on the Page.
    const calls = fake.calls.length;
    const bad = await register({ pageAssetId: PAGE, metaFormId: FAKE_FORM_ID, consentAssumed: "yes" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "consentAssumed must be true or false." });
    expect(fake.calls.length).toBe(calls);
    const missing = await register({ pageAssetId: PAGE, metaFormId: "123456789" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: LEAD_FORM_COPY.notOnPage });

    // A form built in Edwyz never assumes consent, imported or not (D35).
    const built = (await (await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }), {})).json()) as { form: { metaFormId: string } };
    const before = fake.calls.length;
    const assumed = await register({ pageAssetId: PAGE, metaFormId: built.form.metaFormId, consentAssumed: true });
    expect(assumed.status).toBe(400);
    expect(await assumed.json()).toEqual({ error: CREATED_FORM_CONSENT });
    expect(fake.calls.length).toBe(before);

    // Still admin only and same-origin only.
    expect((await register({ pageAssetId: PAGE, metaFormId: FAKE_FORM_ID }, "https://evil.example")).status).toBe(403);
    h.getActor.mockResolvedValue(actor("agent"));
    expect((await register({ pageAssetId: PAGE, metaFormId: FAKE_FORM_ID })).status).toBe(403);
  });

  it("build answers 409 with the Opens Meta fix when the terms are missing, and 400 with every problem for a bad spec", async () => {
    process.env.PROMOTE_ENABLED = "on";
    const { fake } = wireFake();
    fake.scenario("leadgen_terms_missing");
    const refused = await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec() }), {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "leadgen_tos", fix: { kind: "opens_meta", key: "leadgen_tos" } });
    expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);
    const bad = await buildRoute(post("/api/leads/forms/build", { pageAssetId: PAGE, spec: spec({ privacyUrl: "http://x.example", formType: "best" }) }), {});
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: LEAD_FORM_COPY.formType,
      problems: [
        { field: "formType", message: LEAD_FORM_COPY.formType },
        { field: "privacyUrl", message: "The link must start with https://" },
      ],
    });
    expect(formRows()).toEqual([]);
  });
});
