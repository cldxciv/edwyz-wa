import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    count: vi.fn(), upsert: vi.fn(), groupBy: vi.fn(), findFirstOrThrow: vi.fn(),
  });
  return {
    apiKey: model(), phoneNumber: model(), contact: model(), conversation: model(), message: model(), template: model(), broadcast: model(),
    broadcastRecipient: model(), webhookEndpoint: model(), webhookDelivery: model(), auditLog: model(), membership: model(), platformSetting: model(),
  };
});
const billing = vi.hoisted(() => ({ assertTenantCanWrite: vi.fn(), assertWithinLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: vi.fn() }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: vi.fn(), emitAttributeChanges: vi.fn(), emitAutomationEvent: vi.fn() }));
vi.mock("@/lib/routing", () => ({ onConversationAssigned: vi.fn() }));

import { GET as getContact } from "@/app/api/ext/v3/contacts/[target]/route";
import { GET as getContacts } from "@/app/api/ext/v3/contacts/route";
import { POST as postText } from "@/app/api/ext/v3/conversations/[target]/messages/text/route";
import { POST as postTemplate } from "@/app/api/ext/v3/messageTemplates/send/route";
import { resetCompatLimits } from "@/lib/compat/runtime";
import { generateApiKey } from "@/lib/integrations/apikeys";
import { sendMessageV1 } from "@/lib/integrations/v1-service";
import { contactOptedOutPayload, contactRef, EVENT_CATALOG } from "@/lib/integrations/payloads";

const BSUID = "IN.13491208655302741918";
const KEY = generateApiKey();
const ALL = ["messages:write", "contacts:read", "contacts:write", "templates:read", "conversations:read"];

const req = (p: string, init: { method?: string; body?: unknown } = {}) =>
  new Request(`https://wa.edwyz.com/api/ext/v3${p}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${KEY.key}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

const bsuidContact = (over: Record<string, unknown> = {}) => ({
  id: "cb", tenantId: "t1", phone: null, bsuid: BSUID, username: "asha.bakes", waId: null, name: "Asha", tags: [], attributes: {},
  optIn: true, optInSource: "form", optInAt: null, optedOutAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCompatLimits();
  db.apiKey.findUnique.mockImplementation(async ({ where }) =>
    where.keyHash === KEY.hash ? { id: "k1", tenantId: "t1", keyHash: KEY.hash, scopes: ALL, revokedAt: null, lastUsedAt: new Date(), createdByUserId: "u1" } : null,
  );
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  billing.assertWithinLimit.mockResolvedValue(undefined);
  db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } });
  db.platformSetting.create.mockResolvedValue({});
  db.platformSetting.update.mockResolvedValue({});
  db.phoneNumber.findFirst.mockResolvedValue({ id: "pn1", wabaRefId: "w1" });
  db.message.create.mockImplementation(async () => ({ id: "m1", conversationId: "cv1", status: "queued" }));
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
});

describe("ext v3 contacts", () => {
  it("returns bsuid, username, wa_id and a null phone_number", async () => {
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    const json = await (await getContact(req(`/contacts/bsuid:${BSUID}`), ctx({ target: `bsuid:${BSUID}` }))).json();
    expect(json.contact).toMatchObject({ id: "cb", phone_number: null, bsuid: BSUID, username: "asha.bakes", wa_id: null });
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", bsuid: BSUID });
  });

  it("accepts a bare BSUID as the {target}", async () => {
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    const res = await getContact(req(`/contacts/${BSUID}`), ctx({ target: BSUID }));
    expect(res.status).toBe(200);
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", bsuid: BSUID });
  });

  it("searches by username and BSUID as well as name and phone", async () => {
    db.contact.findMany.mockResolvedValue([]);
    db.contact.count.mockResolvedValue(0);
    await getContacts(req("/contacts?search=asha.bakes"));
    const where = db.contact.findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ username: { contains: "asha.bakes", mode: "insensitive" } });
    expect(where.OR).toContainEqual({ bsuid: { contains: "asha.bakes", mode: "insensitive" } });
  });
});

describe("ext v3 sending to a BSUID contact", () => {
  it("sends a session message to a contact that has only a BSUID", async () => {
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    const res = await postText(req("/x", { method: "POST", body: { text: "hi" } }), ctx({ target: `bsuid:${BSUID}` }));
    expect(res.status).toBe(202);
    expect(db.contact.findFirst.mock.calls.every((c) => c[0].where.bsuid === BSUID)).toBe(true);
    expect(db.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: "cv1", direction: "outbound", status: "queued" }) }));
  });

  it("sends a template to a recipient named by bsuid and echoes it back", async () => {
    db.template.findMany.mockResolvedValue([{ id: "tp1", name: "hello", language: "en", status: "approved", components: [{ type: "BODY", text: "Hi {{1}}" }] }]);
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    const res = await postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "hello", recipients: [{ bsuid: BSUID, custom_params: [{ name: "1", value: "Asha" }] }] } }));
    const json = await res.json();
    expect(json.recipients[0]).toMatchObject({ bsuid: BSUID, phone_number: null, accepted: true, message_id: "m1", errors: null });
  });

  it("rejects a recipient with neither phone_number nor a valid bsuid", async () => {
    db.template.findMany.mockResolvedValue([{ id: "tp1", name: "hello", language: "en", status: "approved", components: [] }]);
    const res = await postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "hello", recipients: [{ custom_params: [] }, { bsuid: "nope" }] } }));
    const json = await res.json();
    expect(json.recipients[0].errors[0]).toMatch(/phone_number or bsuid/);
    expect(json.recipients[1].errors[0]).toMatch(/valid WhatsApp user id/);
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("refuses a login-code template for a BSUID-only recipient", async () => {
    db.template.findMany.mockResolvedValue([{ id: "tp1", name: "otp", language: "en", status: "approved", components: [] }]);
    db.template.findFirst.mockResolvedValue({ category: "AUTHENTICATION" });
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    const json = await (await postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "otp", recipients: [{ bsuid: BSUID }] } }))).json();
    expect(json.recipients[0].errors[0]).toMatch(/phone number/);
    expect(db.message.create).not.toHaveBeenCalled();
  });
});

describe("v1 sendMessageV1 with a BSUID", () => {
  const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

  it("looks the contact up by BSUID in this workspace only", async () => {
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    await sendMessageV1(actor, { bsuid: BSUID, type: "text", text: "hello" });
    expect(db.contact.findFirst).toHaveBeenCalledWith({ where: { tenantId: "t1", bsuid: BSUID } });
  });

  it("accepts the BSUID in `to` too, with or without the bsuid: prefix", async () => {
    db.contact.findFirst.mockResolvedValue(bsuidContact());
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    await sendMessageV1(actor, { to: `bsuid:${BSUID}`, type: "text", text: "hello" });
    await sendMessageV1(actor, { to: BSUID, type: "text", text: "hello" });
    expect(db.contact.findFirst.mock.calls.map((c) => c[0].where)).toEqual([{ tenantId: "t1", bsuid: BSUID }, { tenantId: "t1", bsuid: BSUID }]);
  });

  it("never creates a contact from a BSUID: a template to an unknown BSUID is a 404", async () => {
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.contact.findFirst.mockResolvedValue(null);
    await expect(sendMessageV1(actor, { bsuid: BSUID, type: "template", template: { name: "hello", language: "en" } })).rejects.toMatchObject({ status: 404 });
    expect(db.contact.create).not.toHaveBeenCalled();
  });

  it("still needs a valid phone when no BSUID is given", async () => {
    await expect(sendMessageV1(actor, { to: "not a phone", type: "text", text: "x" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("webhook payload shapes", () => {
  it("every contact reference carries bsuid and waId, null when unknown", () => {
    expect(contactRef({ id: "c1", phone: null, bsuid: BSUID, waId: null, username: "asha" })).toEqual({ id: "c1", phone: null, bsuid: BSUID, waId: null, username: "asha", name: null });
    expect(contactRef({ id: "c1", phone: "+919876543210" })).toEqual({ id: "c1", phone: "+919876543210", bsuid: null, waId: null, username: null, name: null });
    expect(contactOptedOutPayload({ contact: { id: "c1", phone: null, bsuid: BSUID }, optedOutAt: new Date(0), source: "stop_keyword" })).toMatchObject({ contact: { bsuid: BSUID, phone: null }, phone: null });
  });

  it("documents bsuid and waId on every event that names a contact", () => {
    const withContact = EVENT_CATALOG.filter((e) => JSON.stringify(e.sample).includes('"bsuid"'));
    expect(withContact.length).toBeGreaterThanOrEqual(3);
    for (const e of withContact) {
      const names = e.fields.map((f) => f.name);
      expect(names.some((n) => n.endsWith(".bsuid"))).toBe(true);
      expect(names.some((n) => n.endsWith(".waId"))).toBe(true);
    }
  });
});
