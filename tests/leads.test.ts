import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const m = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() });
  const names = ["metaAsset", "lead", "leadForm", "contact", "leadSequence", "leadSequenceRun", "conversation", "phoneNumber", "template", "membership", "chatbot", "auditLog", "platformSetting"];
  return Object.fromEntries(names.map((n) => [n, m()])) as Record<string, ReturnType<typeof m>>;
});
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  graph: vi.fn(),
  access: vi.fn(),
  convert: vi.fn(),
  send: vi.fn(),
  assign: vi.fn(),
  chatbot: vi.fn(),
  role: "admin" as "agent" | "admin" | "owner",
}));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/graph", () => ({ graphFetchAs: mocks.graph }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: mocks.access }));
vi.mock("@/lib/conversions", () => ({ queueConversion: mocks.convert }));
vi.mock("@/lib/inbox/service", () => ({ sendTemplateMessage: mocks.send }));
vi.mock("@/lib/routing", () => ({ assignConversation: mocks.assign }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: mocks.chatbot }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: mocks.role }) }));

import { GET as hook, POST as hookPost } from "@/app/webhooks/leads/route";
import { GET as listRoute } from "@/app/api/leads/route";
import { PATCH as patchLead } from "@/app/api/leads/[id]/route";
import { GET as exportRoute } from "@/app/api/leads/export/route";
import { PATCH as patchForm } from "@/app/api/leads/forms/[id]/route";
import { POST as postForm } from "@/app/api/leads/forms/route";
import { POST as postSequence } from "@/app/api/leads/sequences/route";
import { detectConsent, extractIdentity, hasConsentField, isAffirmative, isConsentKey, mapFieldData, mapFieldNames } from "@/lib/leads/fields";
import { handleLeadJob } from "@/lib/leads/ingest";
import { fetchFormDefinitionKeys } from "@/lib/leads/form-definition";
import { onInboundFromContact, processRun } from "@/lib/leads/runner";

const ORIGIN = "https://wa.edwyz.com";
const SECRET = "app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
const payload = (ids: string[]) => JSON.stringify({ object: "page", entry: [{ changes: ids.map((id) => ({ field: "leadgen", value: { leadgen_id: id, page_id: "p1", form_id: "f1" } })) }] });
const post = (body: string, sig: string | null) => new Request(`${ORIGIN}/webhooks/leads`, { method: "POST", headers: sig ? { "x-hub-signature-256": sig } : {}, body });
const json = (path: string, method: string, body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const graphLead = (fieldData: unknown[]) => ({ id: "L1", created_time: "2026-10-01T10:00:00+0000", ad_id: "ad1", campaign_id: "c1", form_id: "f1", field_data: fieldData });
const phoneField = { name: "phone_number", values: ["+91 98765 43210"] };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.META_APP_SECRET = SECRET;
  process.env.META_VERIFY_TOKEN = "vt";
  mocks.role = "admin";
  db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "t1" }]);
  db.lead.findFirst.mockResolvedValue(null);
  db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: null });
  db.contact.findFirst.mockResolvedValue(null);
  db.contact.create.mockResolvedValue({ id: "c1" });
  db.lead.create.mockResolvedValue({ id: "lead1", tenantId: "t1", contactId: "c1", fields: {}, status: "new", assignedToId: null, leadFormId: "form1", campaignMetaId: "c1" });
  db.leadSequence.findMany.mockResolvedValue([]);
  mocks.access.mockResolvedValue({ token: "tok" });
});

describe("webhook route", () => {
  it("answers the handshake", async () => {
    const res = hook(new Request(`${ORIGIN}/webhooks/leads?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`));
    expect(await res.text()).toBe("42");
    expect(hook(new Request(`${ORIGIN}/webhooks/leads?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=42`)).status).toBe(403);
  });
  it("rejects a missing or wrong signature and enqueues nothing", async () => {
    const body = payload(["1"]);
    expect((await hookPost(post(body, null))).status).toBe(401);
    expect((await hookPost(post(body, "sha256=" + "0".repeat(64)))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("enqueues one job per distinct leadgen id and only ids", async () => {
    const body = payload(["1", "2", "1"]);
    expect((await hookPost(post(body, sign(body)))).status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls[0]).toEqual(["lead-fetch", { leadgenId: "1", pageId: "p1", formId: "f1" }]);
  });
  it("ignores other objects and fields, and asks Meta to retry when the queue fails", async () => {
    const other = JSON.stringify({ object: "page", entry: [{ changes: [{ field: "feed", value: {} }] }] });
    expect((await hookPost(post(other, sign(other)))).status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    mocks.enqueue.mockRejectedValue(new Error("db"));
    const body = payload(["9"]);
    expect((await hookPost(post(body, sign(body)))).status).toBe(500);
  });
});

describe("field mapping", () => {
  it("maps names, normalises the phone and detects consent evidence", () => {
    const fields = mapFieldData([{ name: "Full_Name", values: ["A B"] }, phoneField, { name: "email", values: ["a@b.co"] }]);
    expect(extractIdentity(fields)).toEqual({ phone: "+919876543210", name: "A B", email: "a@b.co" });
    expect(detectConsent(fields, null)).toEqual({ given: false, text: null });
    expect(detectConsent({ consent_whatsapp: "yes" }, null).given).toBe(true);
    expect(detectConsent({ consent_whatsapp: "No" }, "stored text").given).toBe(false);
  });

  it("treats only explicit affirmatives as consent", () => {
    for (const v of ["yes", "Yes", "TRUE", "1", "on", "checked", "agree", "Agreed", "accept", "accepted", "I agree", " i  agree. "]) {
      expect(isAffirmative(v), v).toBe(true);
      expect(detectConsent({ consent_whatsapp: v }, null).given, v).toBe(true);
    }
    for (const v of ["no", "not now", "never", "No thanks, do not contact me", "maybe", "do not agree", "disagree", "0", "false", "off", "unchecked", "n", "y", "yes but not whatsapp", ""]) {
      expect(isAffirmative(v), v).toBe(false);
      expect(detectConsent({ consent_whatsapp: v }, "I agree", { consentAssumed: true, formHasConsentField: false }).given, v).toBe(false);
    }
  });

  it("accepts Spanish, French and German affirmatives and decorated yes answers, and still rejects their negatives", () => {
    for (const v of ["Sí", "si", "Acepto", "De acuerdo", "Oui", "J'accepte", "Je suis d'accord", "Ja", "Einverstanden", "Ich stimme zu", "yes please", "Yes, I agree", "I consent", "I agree to receive WhatsApp messages", "Sí, acepto", "Oui, merci", "Ja, bitte"]) {
      expect(isAffirmative(v), v).toBe(true);
    }
    for (const v of ["No", "Nein", "Non", "pas d'accord", "No acepto", "Ich stimme nicht zu", "I agree not to be contacted", "yes but never whatsapp", "I do not consent", "Nunca", "maybe later", "ok"]) {
      expect(isAffirmative(v), v).toBe(false);
    }
  });

  it("does not count the form consent text as consent on its own", () => {
    expect(detectConsent({}, "I agree to WhatsApp messages")).toEqual({ given: false, text: null });
    expect(detectConsent({}, "I agree to WhatsApp messages", { consentAssumed: false, formHasConsentField: false }).given).toBe(false);
  });

  it("counts the consent text only when the tenant set consentAssumed, there is text and the form definition shows no consent field", () => {
    const on = { consentAssumed: true, formHasConsentField: false };
    expect(detectConsent({}, "I agree to WhatsApp messages", on)).toEqual({ given: true, text: "I agree to WhatsApp messages" });
    expect(detectConsent({}, null, on).given).toBe(false);
    expect(detectConsent({}, "  ", on).given).toBe(false);
    expect(detectConsent({}, "I agree", { consentAssumed: true }).given).toBe(false);
    expect(detectConsent({}, "I agree", { consentAssumed: true, formHasConsentField: true }).given).toBe(false);
  });

  it("lets a non-affirmative answer to any consent field outweigh the others", () => {
    expect(detectConsent({ consent_a: "yes", opt_in_b: "not now" }, "t").given).toBe(false);
    expect(detectConsent({ consent_a: "yes", opt_in_b: "agree" }, "t").given).toBe(true);
  });

  it("treats an optional consent checkbox sent empty, or defined by the form but omitted, as not consenting even with consentAssumed", () => {
    const fieldData = [phoneField, { name: "consent_whatsapp", values: [] }];
    const fields = mapFieldData(fieldData);
    expect(fields.consent_whatsapp).toBeUndefined();
    expect(mapFieldNames(fieldData)).toEqual(["phone_number", "consent_whatsapp"]);
    expect(detectConsent(fields, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(true);
    expect(detectConsent(fields, "I agree", { consentAssumed: true, formHasConsentField: false, presentKeys: mapFieldNames(fieldData) }).given).toBe(false);
    expect(detectConsent({}, "I agree", { consentAssumed: true, formHasConsentField: true, formConsentKeys: ["marketing_box"] }).given).toBe(false);
    expect(hasConsentField({}, { formConsentKeys: ["marketing_box"] })).toBe(true);
  });

  it("does not treat terms, permission_level or disagree fields as marketing consent, but does for messaging-style agree and permission fields", () => {
    for (const k of ["agree_terms", "i_agree_to_the_privacy_policy", "permission_level", "disagree", "agreement_signed"]) expect(isConsentKey(k), k).toBe(false);
    for (const k of ["consent_whatsapp", "opt_in", "optin", "opt-in_marketing", "i_agree_to_receive_whatsapp_messages", "permission_to_contact_me", "marketing_consent"]) expect(isConsentKey(k), k).toBe(true);
    expect(detectConsent({ agree_terms: "yes" }, "I agree", { consentAssumed: false }).given).toBe(false);
    expect(detectConsent({ agree_terms: "yes", permission_level: "admin" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(true);
    expect(detectConsent({ agree_terms: "yes", consent_whatsapp: "yes" }, null).given).toBe(true);
  });

  it("lets an explicit no in a marketing-style field veto consent even when the name is not a consent name", () => {
    expect(detectConsent({ marketing_whatsapp: "No" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(false);
    expect(detectConsent({ consent_a: "yes", whatsapp_updates: "no" }, "t").given).toBe(false);
    expect(detectConsent({ marketing_budget: "5000" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(true);
    expect(detectConsent({ whatsapp: "no" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(true);
  });
});

describe("lead ingestion", () => {
  const run = () => handleLeadJob({ leadgenId: "L1", pageId: "p1", formId: "f1" });

  it("creates an opted-in contact when the lead answered a consent field affirmatively", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "consent_whatsapp", values: ["Yes"] }]));
    await run();
    const data = db.contact.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", phone: "+919876543210", optIn: true, optInSource: "lead_form" });
    expect(data.optInAt).toBeInstanceOf(Date);
    expect(data.tags).toContain("lead");
    expect(db.lead.create.mock.calls[0][0].data).toMatchObject({ consentText: "I agree", leadgenId: "L1", campaignMetaId: "c1" });
  });

  it("does not opt a lead in on the form consent text alone", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    mocks.graph.mockResolvedValue(graphLead([phoneField]));
    await run();
    const data = db.contact.create.mock.calls[0][0].data;
    expect(data.optIn).toBeUndefined();
    expect(data.tags).toContain("needs_opt_in");
    expect(db.lead.create.mock.calls[0][0].data).toMatchObject({ consentText: null, consentAt: null });
  });

  const definition = (questions: unknown[], checkboxes: unknown[] = []) => ({ questions, legal_content: { custom_disclaimer: { checkboxes } } });
  const withDefinition = (lead: unknown, def: unknown) =>
    mocks.graph.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "f1") {
        if (def instanceof Error) throw def;
        return def;
      }
      return lead;
    });

  it("opts a lead in on the consent text when the tenant set consentAssumed and the form definition shows no consent field", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }, { key: "full_name" }]));
    await run();
    expect(mocks.graph.mock.calls.some((c) => c[1].path === "f1" && c[1].query.fields === "questions,legal_content")).toBe(true);
    expect(db.platformSetting.findUnique.mock.calls[0][0].where.key).toBe("leads:form-settings:t1:form1");
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "lead_form" });
    expect(db.lead.create.mock.calls[0][0].data.consentText).toBe("I agree");
  });

  it("does not assume consent when the form defines a consent checkbox that the lead left out", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }], [{ key: "whatsapp_ok", text: "Send me WhatsApp offers" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
    expect(db.lead.create.mock.calls[0][0].data.consentAt).toBeNull();
  });

  it("does not assume consent when the form definition cannot be read", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    for (const def of [new Error("boom"), {}, null]) {
      db.contact.create.mockClear();
      withDefinition(graphLead([phoneField]), def);
      await run();
      expect(db.contact.create.mock.calls[0][0].data.optIn, String(def)).toBeUndefined();
    }
  });

  it("does not assume consent when the lead sent its consent checkbox empty", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    withDefinition(graphLead([phoneField, { name: "consent_whatsapp", values: [] }]), definition([{ key: "phone_number" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
  });

  it("opts in a lead who answered a consent question in Spanish", async () => {
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "consent_whatsapp", values: ["Sí, acepto"] }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "lead_form" });
  });

  it("reads the form definition even when consentAssumed is off, because a consent question can have an opaque key that only its label identifies", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    withDefinition(graphLead([phoneField, { name: "question_1", values: ["Yes"] }]), definition([{ key: "phone_number" }, { key: "question_1", label: "Receive WhatsApp updates?" }]));
    await run();
    expect(mocks.graph.mock.calls.some((c) => c[1].path === "f1")).toBe(true);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "lead_form" });
    expect(db.platformSetting.upsert.mock.calls.at(-1)?.[0].create.value).toMatchObject({ consentKeys: [], channelKeys: ["question_1"], definedAt: expect.any(Number) });
  });

  it("does not opt in a lead who answered no, even with consentAssumed", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "consent_whatsapp", values: ["No thanks, do not contact me"] }]));
    await run();
    const data = db.contact.create.mock.calls[0][0].data;
    expect(data.optIn).toBeUndefined();
    expect(data.tags).toContain("needs_opt_in");
    expect(db.lead.create.mock.calls[0][0].data.consentAt).toBeNull();
  });

  it("leaves opt-in off and tags needs_opt_in without consent evidence", async () => {
    mocks.graph.mockResolvedValue(graphLead([phoneField]));
    await run();
    const data = db.contact.create.mock.calls[0][0].data;
    expect(data.optIn).toBeUndefined();
    expect(data.tags).toContain("needs_opt_in");
    expect(db.lead.create.mock.calls[0][0].data.consentAt).toBeNull();
  });

  it("does not re-opt-in a contact who opted out", async () => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
    db.contact.findFirst.mockResolvedValue({ id: "c9", tags: [], optIn: false, optedOutAt: new Date(), name: "X", attributes: {} });
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }]));
    await run();
    expect(db.contact.updateMany.mock.calls[0][0].data.optIn).toBeUndefined();
  });

  it("skips a duplicate leadgen id before calling Meta", async () => {
    db.lead.findFirst.mockResolvedValue({ id: "existing" });
    await run();
    expect(mocks.graph).not.toHaveBeenCalled();
    expect(db.lead.create).not.toHaveBeenCalled();
  });

  it("survives a lost race on the unique key", async () => {
    mocks.graph.mockResolvedValue(graphLead([phoneField]));
    db.lead.create.mockRejectedValue(new Error("P2002"));
    await expect(run()).resolves.toBeUndefined();
    expect(db.leadSequence.findMany).not.toHaveBeenCalled();
  });

  it("scopes every lookup to the tenant that owns the page and uses its token", async () => {
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "t1" }, { id: "a2", tenantId: "t2" }]);
    mocks.graph.mockResolvedValue(graphLead([phoneField]));
    await run();
    expect(db.metaAsset.findMany.mock.calls[0][0].where).toMatchObject({ type: "page", externalId: "p1" });
    expect(mocks.access.mock.calls.map((c) => c.slice(0, 2))).toEqual([["t1", "a1"], ["t2", "a2"]]);
    expect(db.lead.findFirst.mock.calls.map((c) => c[0].where.tenantId)).toEqual(["t1", "t2"]);
    expect(db.lead.create.mock.calls.map((c) => c[0].data.tenantId)).toEqual(["t1", "t2"]);
    expect(db.contact.findFirst.mock.calls.every((c) => ["t1", "t2"].includes(c[0].where.tenantId))).toBe(true);
  });

  it("stores a lead without a contact when there is no usable phone", async () => {
    mocks.graph.mockResolvedValue(graphLead([{ name: "email", values: ["a@b.co"] }]));
    await run();
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.lead.create.mock.calls[0][0].data.contactId).toBeNull();
  });
});

describe("sequence runner", () => {
  const baseRun = (over: object = {}) => ({
    id: "r1", tenantId: "t1", leadId: "lead1", stepIndex: 0, status: "active", createdAt: new Date("2026-10-01"),
    sequence: { enabled: true, steps: [{ delayMinutes: 0, templateId: "tp1", stopOnReply: true }, { delayMinutes: 60, templateId: "tp1", stopOnReply: true }] },
    ...over,
  });
  const setup = (run: object, contact: object = {}, template: object = {}) => {
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 1 });
    db.leadSequenceRun.findUnique.mockResolvedValue(run);
    db.lead.findFirst.mockResolvedValue({ id: "lead1", tenantId: "t1", contactId: "c1", fields: {}, status: "new" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", name: "Asha", phone: "+919876543210", optIn: true, optedOutAt: null, ...contact });
    db.conversation.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1" });
    db.template.findFirst.mockResolvedValue({ name: "welcome", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}" }], ...template });
    mocks.send.mockResolvedValue({ conversationId: "cv1" });
    db.conversation.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ assignedToId: "u9" });
  };

  it("sends step 0, sets firstResponseAt, assigns and schedules the next step", async () => {
    setup(baseRun());
    expect(await processRun("r1", new Date("2026-10-01T10:00:00Z"))).toBe(true);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ tenantId: "t1", templateName: "welcome", components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }] }] });
    expect(db.lead.updateMany.mock.calls.some((c) => c[0].data.firstResponseAt instanceof Date)).toBe(true);
    expect(mocks.assign).toHaveBeenCalledWith("t1", "cv1");
    const advance = db.leadSequenceRun.updateMany.mock.calls.at(-1)![0];
    expect(advance.data.stepIndex).toBe(1);
    expect(advance.data.nextRunAt.getTime()).toBe(new Date("2026-10-01T11:00:00Z").getTime());
  });

  it("does nothing when another worker already claimed the run", async () => {
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 0 });
    expect(await processRun("r1")).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not send a marketing template without opt-in", async () => {
    setup(baseRun(), { optIn: false }, { category: "MARKETING" });
    await processRun("r1");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("stops the run for an opted-out contact", async () => {
    setup(baseRun(), { optedOutAt: new Date() });
    await processRun("r1");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.leadSequenceRun.updateMany.mock.calls.at(-1)![0].data.status).toBe("stopped");
  });

  it("stops before a later step when the contact has replied", async () => {
    setup(baseRun({ stepIndex: 1 }));
    db.conversation.findFirst.mockReset();
    db.conversation.findFirst.mockResolvedValue({ id: "cv1" });
    await processRun("r1");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(db.leadSequenceRun.updateMany.mock.calls.at(-1)![0].data.status).toBe("stopped");
  });

  it("onInboundFromContact stops only runs whose pending step stops on reply, scoped to the tenant", async () => {
    db.leadSequenceRun.findMany.mockResolvedValue([
      { id: "a", stepIndex: 1, sequence: { steps: [{ delayMinutes: 0, templateId: "t", stopOnReply: true }, { delayMinutes: 5, templateId: "t", stopOnReply: true }] } },
      { id: "b", stepIndex: 1, sequence: { steps: [{ delayMinutes: 0, templateId: "t", stopOnReply: true }, { delayMinutes: 5, templateId: "t", stopOnReply: false }] } },
    ]);
    db.leadSequenceRun.updateMany.mockResolvedValue({ count: 1 });
    expect(await onInboundFromContact("t1", "c1")).toBe(1);
    expect(db.leadSequenceRun.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", status: "active", lead: { contactId: "c1", tenantId: "t1" } });
    expect(db.leadSequenceRun.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "a", tenantId: "t1", status: "active" }, data: { status: "stopped" } });
  });
});

describe("api routes", () => {
  it("queues a conversion on qualified and won transitions only", async () => {
    db.lead.findFirst.mockResolvedValue({ id: "l1", tenantId: "t1", contactId: "c1", status: "new", fields: {}, createdAt: new Date() });
    db.contact.findMany.mockResolvedValue([]);
    db.leadSequenceRun.findMany.mockResolvedValue([]);
    expect((await patchLead(json("/api/leads/l1", "PATCH", { status: "qualified" }), ctx("l1"))).status).toBe(200);
    expect(mocks.convert).toHaveBeenCalledWith("t1", { leadId: "l1", contactId: "c1", eventName: "QualifiedLead" });
    await patchLead(json("/api/leads/l1", "PATCH", { status: "won" }), ctx("l1"));
    expect(mocks.convert).toHaveBeenLastCalledWith("t1", { leadId: "l1", contactId: "c1", eventName: "Purchase" });
    mocks.convert.mockClear();
    await patchLead(json("/api/leads/l1", "PATCH", { status: "lost" }), ctx("l1"));
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(db.lead.updateMany.mock.calls[0][0].where).toEqual({ id: "l1", tenantId: "t1" });
  });

  it("validates status, cross-origin, and blocks agents from reassigning", async () => {
    db.lead.findFirst.mockResolvedValue({ id: "l1", tenantId: "t1", contactId: null, status: "new", fields: {}, createdAt: new Date() });
    expect((await patchLead(json("/api/leads/l1", "PATCH", { status: "bogus" }), ctx("l1"))).status).toBe(400);
    expect((await patchLead(json("/api/leads/l1", "PATCH", { status: "won" }, "https://evil.example"), ctx("l1"))).status).toBe(403);
    mocks.role = "agent";
    expect((await patchLead(json("/api/leads/l1", "PATCH", { assignedToId: "u2" }), ctx("l1"))).status).toBe(403);
  });

  it("returns 404 for a lead of another tenant", async () => {
    db.lead.findFirst.mockResolvedValue(null);
    expect((await patchLead(json("/api/leads/x", "PATCH", { status: "won" }), ctx("x"))).status).toBe(404);
    expect(db.lead.findFirst.mock.calls[0][0].where).toEqual({ id: "x", tenantId: "t1" });
  });

  it("lists with filters and a cursor, always scoped to the tenant", async () => {
    const rows = [1, 2, 3].map((n) => ({ id: `l${n}`, tenantId: "t1", contactId: null, leadFormId: null, fields: {}, status: "new", createdAt: new Date(), firstResponseAt: null }));
    db.lead.findMany.mockResolvedValue(rows);
    const res = await listRoute(new Request(`${ORIGIN}/api/leads?status=new&limit=2&cursor=l0`));
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBe("l2");
    expect(db.lead.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", status: "new" }, cursor: { id: "l0" }, skip: 1, take: 3 });
    expect((await listRoute(new Request(`${ORIGIN}/api/leads?status=zzz`))).status).toBe(400);
  });

  it("exports CSV for admins only and neutralises formulas", async () => {
    db.lead.findMany.mockResolvedValue([{ id: "l1", contactId: null, leadFormId: null, fields: { full_name: "=HYPERLINK(\"x\")", email: "+a@b.co" }, status: "new", createdAt: new Date(), firstResponseAt: null }]);
    const res = await exportRoute(new Request(`${ORIGIN}/api/leads/export`));
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("'+a@b.co");
    mocks.role = "agent";
    expect((await exportRoute(new Request(`${ORIGIN}/api/leads/export`))).status).toBe(403);
  });

  it("saves form consent text for admins in the tenant", async () => {
    db.leadForm.findFirst.mockResolvedValue({ id: "f1" });
    db.leadForm.updateMany.mockResolvedValue({ count: 1 });
    db.leadForm.findMany.mockResolvedValue([{ id: "f1", metaFormId: "m", name: null, consentText: "ok", status: "active", createdAt: new Date() }]);
    expect((await patchForm(json("/api/leads/forms/f1", "PATCH", { consentText: "ok" }), ctx("f1"))).status).toBe(200);
    expect(db.leadForm.findFirst.mock.calls[0][0].where).toEqual({ id: "f1", tenantId: "t1" });
    expect(db.leadForm.updateMany.mock.calls[0][0].where).toEqual({ id: "f1", tenantId: "t1" });
    db.leadForm.findFirst.mockResolvedValue(null);
    expect((await patchForm(json("/api/leads/forms/zz", "PATCH", { consentText: "ok" }), ctx("zz"))).status).toBe(404);
  });

  it("stores consentAssumed per form for admins, defaulting to false, and rejects non-booleans", async () => {
    db.leadForm.findFirst.mockResolvedValue({ id: "f1" });
    db.leadForm.findMany.mockResolvedValue([{ id: "f1", metaFormId: "m", name: null, consentText: "ok", status: "active", createdAt: new Date() }]);
    db.platformSetting.findMany.mockResolvedValue([]);
    const res = await patchForm(json("/api/leads/forms/f1", "PATCH", { consentAssumed: true }), ctx("f1"));
    expect(res.status).toBe(200);
    expect(db.platformSetting.upsert.mock.calls[0][0]).toMatchObject({ where: { key: "leads:form-settings:t1:f1" }, create: { value: { consentAssumed: true } } });
    expect(db.leadForm.updateMany).not.toHaveBeenCalled();
    expect((await patchForm(json("/api/leads/forms/f1", "PATCH", { consentAssumed: "yes" }), ctx("f1"))).status).toBe(400);
    mocks.role = "agent";
    expect((await patchForm(json("/api/leads/forms/f1", "PATCH", { consentAssumed: true }), ctx("f1"))).status).toBe(403);
  });

  it("returns the saved form even when it is not among the 200 most recent", async () => {
    db.leadForm.findFirst.mockResolvedValue({ id: "old", metaFormId: "m", name: null, consentText: "ok", status: "active", createdAt: new Date(0) });
    db.leadForm.updateMany.mockResolvedValue({ count: 1 });
    db.leadForm.findMany.mockResolvedValue([]);
    db.platformSetting.findMany.mockResolvedValue([]);
    const res = await patchForm(json("/api/leads/forms/old", "PATCH", { consentText: "ok" }), ctx("old"));
    expect(res.status).toBe(200);
    expect((await res.json()).form).toMatchObject({ id: "old", consentText: "ok", consentAssumed: false, consentTextNotUsed: true });
  });

  it("registers a form before its first lead so consentAssumed applies to that lead, for admins and own pages only", async () => {
    db.metaAsset.findFirst.mockResolvedValue({ id: "a1" });
    db.leadForm.upsert.mockResolvedValue({ id: "form9" });
    db.leadForm.findFirst.mockResolvedValue({ id: "form9", metaFormId: "m9", name: null, consentText: "I agree", status: "active", createdAt: new Date() });
    db.leadForm.updateMany.mockResolvedValue({ count: 1 });
    db.platformSetting.findMany.mockResolvedValue([{ key: "leads:form-settings:t1:form9", value: { consentAssumed: true } }]);
    const res = await postForm(json("/api/leads/forms", "POST", { metaFormId: "m9", pageAssetId: "a1", consentText: "I agree", consentAssumed: true }));
    expect(res.status).toBe(201);
    expect(db.metaAsset.findFirst.mock.calls[0][0].where).toEqual({ id: "a1", tenantId: "t1", type: "page" });
    expect(db.leadForm.upsert.mock.calls[0][0]).toMatchObject({ where: { tenantId_metaFormId: { tenantId: "t1", metaFormId: "m9" } }, create: { tenantId: "t1", pageAssetId: "a1", metaFormId: "m9" }, update: {} });
    expect(db.platformSetting.upsert.mock.calls[0][0]).toMatchObject({ where: { key: "leads:form-settings:t1:form9" } });
    expect((await res.json()).form).toMatchObject({ id: "form9", consentAssumed: true });
    db.metaAsset.findFirst.mockResolvedValue(null);
    expect((await postForm(json("/api/leads/forms", "POST", { metaFormId: "m9", pageAssetId: "other" }))).status).toBe(404);
    expect((await postForm(json("/api/leads/forms", "POST", { metaFormId: "bad id!", pageAssetId: "a1" }))).status).toBe(400);
    expect((await postForm(json("/api/leads/forms", "POST", { metaFormId: "m9", pageAssetId: "a1" }, null))).status).toBe(403);
    mocks.role = "agent";
    expect((await postForm(json("/api/leads/forms", "POST", { metaFormId: "m9", pageAssetId: "a1" }))).status).toBe(403);
  });

  it("does not set consentAssumed on a form of another tenant", async () => {
    db.leadForm.findFirst.mockResolvedValue(null);
    expect((await patchForm(json("/api/leads/forms/other", "PATCH", { consentAssumed: true }), ctx("other"))).status).toBe(404);
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("validates sequences and rejects templates of other tenants", async () => {
    expect((await postSequence(json("/api/leads/sequences", "POST", { name: "s", steps: [] }))).status).toBe(400);
    db.template.findFirst.mockResolvedValue(null);
    expect((await postSequence(json("/api/leads/sequences", "POST", { name: "s", steps: [{ delayMinutes: 0, templateId: "foreign" }] }))).status).toBe(400);
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ id: "foreign", tenantId: "t1" });
    db.template.findFirst.mockResolvedValue({ id: "tp1" });
    db.leadSequence.create.mockResolvedValue({ id: "s1" });
    expect((await postSequence(json("/api/leads/sequences", "POST", { name: "s", steps: [{ delayMinutes: 0, templateId: "tp1" }] }))).status).toBe(201);
    mocks.role = "agent";
    expect((await postSequence(json("/api/leads/sequences", "POST", { name: "s", steps: [] }))).status).toBe(403);
  });
});

describe("precise marketing consent", () => {
  it("accepts case-insensitive affirmatives with punctuation stripped, including si, sí, oui, ja, haan, ha, yes please, i consent and i agree", () => {
    for (const v of ["YES!", "  Yes. ", "(yes)", "Sí", "SI", "oui", "OUI!", "Ja.", "JA", "haan", "Haan!", "ha", "Ha.", "yes please", "Yes please!", "I consent", "I CONSENT.", "i agree", "I Agree!"]) {
      expect(isAffirmative(v), v).toBe(true);
    }
    for (const v of ["nahi", "Nahi, mat bhejo", "haan but nahi", "ha ha", "hahaha", "maybe", "later", "yes no", "ok", "sure", "agree not", "n/a"]) {
      expect(isAffirmative(v), v).toBe(false);
    }
  });

  it("treats an omitted or empty optional consent checkbox as not consent, however the form is configured", () => {
    const fieldData = [phoneField, { name: "whatsapp_updates_consent", values: [] }];
    const fields = mapFieldData(fieldData);
    const presentKeys = mapFieldNames(fieldData);
    expect(detectConsent(fields, "I agree", { consentAssumed: true, formHasConsentField: false, presentKeys }).given).toBe(false);
    expect(detectConsent({}, "I agree", { consentAssumed: true, formHasConsentField: false, presentKeys }).given).toBe(false);
    expect(detectConsent({ whatsapp_updates_consent: "" }, null, { presentKeys }).given).toBe(false);
  });

  it("recognises a consent field by its name or its label, and excludes terms, privacy, data processing and generic agree_terms", () => {
    for (const k of ["marketing_opt_in", "opt_in_offers", "agree_to_receive_updates", "contact_permission", "whatsapp_consent", "send_me_messages_consent"]) expect(isConsentKey(k), k).toBe(true);
    for (const k of ["agree_terms", "terms_and_conditions", "agree_to_terms_and_conditions", "privacy_policy", "accept_privacy", "data_processing_consent", "consent_to_data_storage", "permission_level", "agree", "disagree"]) {
      expect(isConsentKey(k), k).toBe(false);
    }
    expect(isConsentKey("checkbox_1", "I agree to receive WhatsApp updates and offers")).toBe(true);
    expect(isConsentKey("checkbox_1", "Consent to receive WhatsApp updates and offers")).toBe(true);
    expect(isConsentKey("agree", "I agree to receive WhatsApp offers")).toBe(true);
    expect(isConsentKey("agree", "I agree to the terms and conditions")).toBe(false);
    expect(isConsentKey("agree_terms", "Send me marketing messages on WhatsApp")).toBe(true);
  });

  it("records a Hindi-style refusal as a refusal", () => {
    expect(detectConsent({ consent_whatsapp: "Nahi" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(false);
    expect(detectConsent({ consent_whatsapp: "Haan" }, null).given).toBe(true);
    expect(detectConsent({ marketing_whatsapp: "nahin" }, "I agree", { consentAssumed: true, formHasConsentField: false }).given).toBe(false);
  });
});

describe("form question keys and consentAssumed", () => {
  const run = () => handleLeadJob({ leadgenId: "L1", pageId: "p1", formId: "f1" });
  const questionKey = "leads:form-questions:t1:form1";
  const definition = (questions: unknown[]) => ({ questions, legal_content: { custom_disclaimer: { checkboxes: [] } } });
  const withDefinition = (lead: unknown, def: unknown) =>
    mocks.graph.mockImplementation(async (_t: string, req: { path: string }) => (req.path === "f1" ? def : lead));
  const storedKeys = (keys: string[]) => db.platformSetting.findMany.mockResolvedValue([{ key: questionKey, value: { keys } }]);

  beforeEach(() => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });
  });

  it("stores the form's question names from the first lead, including an empty consent answer, and does not rewrite them when unchanged", async () => {
    db.platformSetting.findMany.mockResolvedValue([]);
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "Full_Name", values: ["A B"] }, { name: "whatsapp_consent", values: [] }]));
    await run();
    expect(db.platformSetting.upsert).toHaveBeenCalledTimes(1);
    expect(db.platformSetting.upsert.mock.calls[0][0]).toMatchObject({ where: { key: questionKey }, create: { value: { keys: ["phone_number", "full_name", "whatsapp_consent"] } } });

    db.platformSetting.upsert.mockClear();
    db.lead.findFirst.mockResolvedValue(null);
    storedKeys(["phone_number", "full_name", "whatsapp_consent"]);
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "full_name", values: ["C D"] }]));
    await run();
    expect(db.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it("adds question names that appear later to the stored list", async () => {
    storedKeys(["phone_number"]);
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "city", values: ["Pune"] }]));
    await run();
    expect(db.platformSetting.upsert.mock.calls[0][0].update).toEqual({ value: { keys: ["phone_number", "city"] } });
  });

  it("does not honour consentAssumed when the stored questions include a consent question the lead left out, even if the live definition shows none", async () => {
    storedKeys(["phone_number", "whatsapp_updates_consent"]);
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
    expect(db.lead.create.mock.calls[0][0].data.consentAt).toBeNull();
  });

  it("honours consentAssumed when neither the stored questions nor the form definition has a consent question", async () => {
    storedKeys(["phone_number", "full_name"]);
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }, { key: "full_name" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "lead_form" });
  });

  it("does not honour consentAssumed when a definition question is a consent question by its label", async () => {
    storedKeys(["phone_number"]);
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }, { key: "q7", label: "Consent to receive WhatsApp offers" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
  });

  it("still ingests the lead when the question names cannot be stored", async () => {
    db.platformSetting.findMany.mockRejectedValue(new Error("db down"));
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "consent_whatsapp", values: ["Yes"] }]));
    await run();
    expect(db.lead.create).toHaveBeenCalled();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBe(true);
  });

  it("documents in the form data when consentAssumed applies, with the stored question names", async () => {
    db.leadForm.findMany.mockResolvedValue([
      { id: "fa", metaFormId: "ma", name: null, consentText: "I agree", status: "active", createdAt: new Date() },
      { id: "fb", metaFormId: "mb", name: null, consentText: "I agree", status: "active", createdAt: new Date() },
      { id: "fc", metaFormId: "mc", name: null, consentText: "I agree", status: "active", createdAt: new Date() },
      { id: "fd", metaFormId: "md", name: null, consentText: "I agree", status: "active", createdAt: new Date() },
    ]);
    db.platformSetting.findMany.mockResolvedValue([
      { key: "leads:form-settings:t1:fa", value: { consentAssumed: true } },
      { key: "leads:form-settings:t1:fb", value: { consentAssumed: true } },
      { key: "leads:form-settings:t1:fc", value: { consentAssumed: true } },
      { key: "leads:form-settings:t1:fd", value: { consentAssumed: true } },
      { key: "leads:form-questions:t1:fa", value: { keys: ["phone_number"], consentKeys: [], channelKeys: [], definedAt: 1 } },
      { key: "leads:form-questions:t1:fb", value: { keys: ["phone_number", "whatsapp_consent"] } },
      { key: "leads:form-questions:t1:fd", value: { keys: ["phone_number"] } },
    ]);
    const res = await (await import("@/app/api/leads/forms/route")).GET(new Request(`${ORIGIN}/api/leads/forms`));
    const items = (await res.json()).items as { id: string; consentAssumedApplies: boolean; consentQuestionKeys: string[]; consentDefinitionRead: boolean; questionKeys: string[]; consentAssumedNote: string }[];
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.fa).toMatchObject({ consentAssumedApplies: true, consentQuestionKeys: [], questionKeys: ["phone_number"] });
    expect(by.fb).toMatchObject({ consentAssumedApplies: false, consentQuestionKeys: ["whatsapp_consent"] });
    expect(by.fc).toMatchObject({ consentAssumedApplies: false, questionKeys: [] });
    // Names alone are not enough: the runtime assumes consent only after the form definition (with labels) has been read.
    expect(by.fd).toMatchObject({ consentAssumedApplies: false, consentDefinitionRead: false, questionKeys: ["phone_number"] });
    expect(by.fa.consentDefinitionRead).toBe(true);
    expect(by.fa.consentAssumedNote).toMatch(/only to a form that has no consent question/);
  });
});

describe("consent field detection: review gaps", () => {
  const assumed = { consentAssumed: true, formHasConsentField: false };

  it("does not treat a bare consent or data-sharing field as marketing consent", () => {
    for (const k of ["data_consent", "consent", "consent_a", "agree", "permission"]) expect(isConsentKey(k), k).toBe(false);
    expect(detectConsent({ data_consent: "Yes" }, null).given).toBe(false);
    expect(detectConsent({ consent: "Yes" }, "I agree", { consentAssumed: false }).given).toBe(false);
    // A vague "consent" field still means the form has some consent question, so the form text is not assumed to cover it.
    expect(detectConsent({ data_consent: "Yes" }, "I agree", assumed).given).toBe(false);
    expect(hasConsentField({ data_consent: "Yes" })).toBe(true);
  });

  it("recognises messaging-style consent names that carry no word like consent or agree", () => {
    for (const k of ["whatsapp_updates", "receive_updates", "accept_marketing", "allow_whatsapp", "ok_to_contact", "receive_offers", "allow_messages", "subscribe_to_offers", "offers_updates", "updates"]) {
      expect(isConsentKey(k), k).toBe(true);
    }
    for (const k of ["message", "contact", "call_me_back", "preferred_contact_time", "whatsapp_number", "phone_number", "marketing_budget", "full_name", "city"]) {
      expect(isConsentKey(k), k).toBe(false);
    }
    expect(isConsentKey("question_1", "Receive WhatsApp updates?")).toBe(true);
    expect(isConsentKey("question_2", "I agree to the terms and conditions")).toBe(false);
  });

  it("counts a Yes or a No on such a field", () => {
    for (const k of ["whatsapp_updates", "receive_updates", "accept_marketing", "allow_whatsapp", "ok_to_contact"]) {
      expect(detectConsent({ [k]: "Yes" }, null).given, k).toBe(true);
      expect(detectConsent({ [k]: "No" }, "I agree", assumed).given, k).toBe(false);
    }
  });

  it("does not let a free-text message or contact answer cancel a valid consent", () => {
    expect(detectConsent({ marketing_consent: "Yes", message: "No, call me tomorrow" }, null).given).toBe(true);
    expect(detectConsent({ marketing_consent: "Yes", contact_notes: "no calls before 10" }, null).given).toBe(true);
    expect(detectConsent({ message: "No, call me tomorrow" }, "I agree", assumed)).toEqual({ given: true, text: "I agree" });
    // A real refusal on a consent-style field still wins.
    expect(detectConsent({ marketing_consent: "Yes", whatsapp_updates: "No" }, null).given).toBe(false);
  });

  it("does not assume consent when the only consent question is a messaging-style checkbox that was left empty or omitted", () => {
    for (const key of ["whatsapp_updates", "receive_updates", "offers_updates", "updates"]) {
      expect(detectConsent({}, "I agree", { ...assumed, presentKeys: [key] }).given, `${key} omitted`).toBe(false);
      expect(detectConsent({}, "I agree", { ...assumed, formChannelKeys: [key] }).given, `${key} from the definition`).toBe(false);
      expect(detectConsent({ [key]: "Yes" }, "I agree", assumed).given, `${key} answered`).toBe(true);
    }
  });

  it("ignores a messaging-word question that is free text, unless it is the only consent-style question and was left empty", () => {
    expect(detectConsent({ offers_interested_in: "Shoes" }, "I agree", assumed).given).toBe(true);
    expect(detectConsent({ marketing_consent: "Yes" }, null, { presentKeys: ["marketing_consent", "offers_interested_in"] }).given).toBe(true);
  });

  it("accepts the multilingual affirmatives in any case with surrounding punctuation and rejects everything else", () => {
    for (const v of ["Si", "SÍ", "oui!", "Ja.", "haan", "Ha", "yes please", "I consent", "I agree", "  YES!!  ", "'sí'", "(yes)"]) expect(isAffirmative(v), v).toBe(true);
    for (const v of ["", "   ", "sure", "tal vez", "vielleicht", "nein", "non merci", "not really", "yes but not whatsapp"]) expect(isAffirmative(v), v).toBe(false);
  });
});

describe("form definition keys", () => {
  const def = {
    questions: [
      { key: "Phone_Number", label: "Phone" },
      { key: "question_1", label: "Receive WhatsApp updates?" },
      { key: "question_2", label: "Consent to receive marketing messages" },
      { key: "question_3", label: "What is your marketing budget?" },
      { key: "message", label: "Your message" },
    ],
    legal_content: {
      custom_disclaimer: {
        checkboxes: [
          { key: "terms_ok", text: "I accept the terms and conditions" },
          { key: "privacy_ok", text: "I have read the privacy policy" },
          { text: "I agree to receive WhatsApp offers" },
          { key: "box_wa", text: "I agree to be contacted on WhatsApp" },
          { key: "box_plain", text: "I agree" },
          { key: "data_box", text: "I consent to the processing of my data" },
        ],
      },
    },
  };

  it("sorts questions and disclaimer checkboxes by key and label, and skips terms, privacy and keyless checkboxes", async () => {
    mocks.graph.mockResolvedValue(def);
    const keys = await fetchFormDefinitionKeys("tok", "f1");
    expect(keys?.consentKeys.sort()).toEqual(["box_wa", "question_2"]);
    expect(keys?.channelKeys.sort()).toEqual(["box_plain", "question_1"]);
    expect(keys?.questionKeys).toContain("phone_number");
    for (const excluded of ["terms_ok", "privacy_ok", "data_box", "message", "question_3", "checkbox_0", "checkbox_2"]) {
      expect([...(keys?.consentKeys ?? []), ...(keys?.channelKeys ?? [])], excluded).not.toContain(excluded);
    }
  });

  it("returns null when Meta fails or answers without a question list", async () => {
    mocks.graph.mockRejectedValue(new Error("down"));
    expect(await fetchFormDefinitionKeys("tok", "f1")).toBeNull();
    mocks.graph.mockResolvedValue({});
    expect(await fetchFormDefinitionKeys("tok", "f1")).toBeNull();
  });
});

describe("lead ingestion with the form definition", () => {
  const run = () => handleLeadJob({ leadgenId: "L1", pageId: "p1", formId: "f1" });
  const questionKey = "leads:form-questions:t1:form1";
  const definition = (questions: unknown[], checkboxes: unknown[] = []) => ({ questions, legal_content: { custom_disclaimer: { checkboxes } } });
  const withDefinition = (lead: unknown, def: unknown) =>
    mocks.graph.mockImplementation(async (_t: string, req: { path: string }) => {
      if (req.path === "f1") {
        if (def instanceof Error) throw def;
        return def;
      }
      return lead;
    });
  const assumeOn = () => db.platformSetting.findUnique.mockResolvedValue({ key: "k", value: { consentAssumed: true } });

  beforeEach(() => {
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
  });

  it("does not count a terms or privacy checkbox as the consent evidence, and still lets consentAssumed apply to a form that has no real consent question", async () => {
    const lead = graphLead([phoneField, { name: "terms_ok", values: ["Yes"] }]);
    const def = definition([{ key: "phone_number" }], [{ key: "terms_ok", text: "I accept the terms and conditions" }]);
    withDefinition(lead, def);
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
    expect(db.lead.create.mock.calls[0][0].data.consentAt).toBeNull();

    vi.clearAllMocks();
    db.lead.findFirst.mockResolvedValue(null);
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "t1" }]);
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1" });
    db.lead.create.mockResolvedValue({ id: "lead1", tenantId: "t1", contactId: "c1", fields: {}, status: "new", leadFormId: "form1" });
    db.leadSequence.findMany.mockResolvedValue([]);
    mocks.access.mockResolvedValue({ token: "tok" });
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    assumeOn();
    withDefinition(lead, def);
    await run();
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true, optInSource: "lead_form" });
  });

  it("ignores a disclaimer checkbox that has no key of its own instead of inventing a checkbox_N key nobody can answer", async () => {
    assumeOn();
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }], [{ text: "Some legal text" }]));
    await run();
    const stored = db.platformSetting.upsert.mock.calls.at(-1)?.[0].create.value;
    expect(stored.consentKeys).toEqual([]);
    expect(stored.channelKeys).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("checkbox_");
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true });
  });

  it("does not assume consent when the definition has a consent question with an opaque key, found by its label", async () => {
    assumeOn();
    withDefinition(graphLead([phoneField]), definition([{ key: "phone_number" }, { key: "question_1", label: "Receive WhatsApp updates?" }]));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
  });

  it("reads the definition once, stores it, and trusts the stored copy for 24 hours", async () => {
    db.platformSetting.findMany.mockResolvedValue([{ key: questionKey, value: { keys: ["phone_number", "question_1"], consentKeys: ["question_1"], channelKeys: [], definedAt: Date.now() - 3_600_000 } }]);
    mocks.graph.mockResolvedValue(graphLead([phoneField, { name: "question_1", values: ["Yes"] }]));
    await run();
    expect(mocks.graph.mock.calls.some((c) => c[1].path === "f1")).toBe(false);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ optIn: true });

    vi.clearAllMocks();
    db.lead.findFirst.mockResolvedValue(null);
    db.metaAsset.findMany.mockResolvedValue([{ id: "a1", tenantId: "t1" }]);
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockResolvedValue({ id: "c1" });
    db.lead.create.mockResolvedValue({ id: "lead1", tenantId: "t1", contactId: "c1", fields: {}, status: "new", leadFormId: "form1" });
    db.leadSequence.findMany.mockResolvedValue([]);
    mocks.access.mockResolvedValue({ token: "tok" });
    db.leadForm.upsert.mockResolvedValue({ id: "form1", consentText: "I agree" });
    db.platformSetting.findMany.mockResolvedValue([{ key: questionKey, value: { keys: ["phone_number", "question_1"], consentKeys: ["question_1"], channelKeys: [], definedAt: Date.now() - 25 * 3_600_000 } }]);
    withDefinition(graphLead([phoneField, { name: "question_1", values: ["Yes"] }]), definition([{ key: "phone_number" }, { key: "question_1", label: "Receive WhatsApp updates?" }]));
    await run();
    expect(mocks.graph.mock.calls.some((c) => c[1].path === "f1")).toBe(true);
  });

  it("falls back to the stored definition when Meta cannot be read, so a left-out consent checkbox still blocks consentAssumed", async () => {
    assumeOn();
    db.platformSetting.findMany.mockResolvedValue([{ key: questionKey, value: { keys: ["phone_number", "question_1"], consentKeys: ["question_1"], channelKeys: [], definedAt: Date.now() - 30 * 3_600_000 } }]);
    withDefinition(graphLead([phoneField]), new Error("down"));
    await run();
    expect(db.contact.create.mock.calls[0][0].data.optIn).toBeUndefined();
  });
});
