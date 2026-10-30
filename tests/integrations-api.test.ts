import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), upsert: vi.fn() });
  return { membership: model(), apiKey: model(), phoneNumber: model(), contact: model(), conversation: model(), message: model(), template: model() };
});
const billing = vi.hoisted(() => ({ assertTenantCanWrite: vi.fn(), assertWithinLimit: vi.fn() }));
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/billing", () => billing);
vi.mock("@/lib/queue", () => ({ enqueue }));

import { GET as getContacts, POST as postContact } from "@/app/api/v1/contacts/route";
import { POST as postMessage } from "@/app/api/v1/messages/route";
import { GET as getTemplates } from "@/app/api/v1/templates/route";
import { createApiKey, generateApiKey, hashApiKey, listApiKeys, resetRateLimits, revokeApiKey, revokeKeysForUser, authenticateApiKey } from "@/lib/integrations/apikeys";
import { HttpError } from "@/lib/tenancy";

const KEY = generateApiKey();
const keyRow = (over: Record<string, unknown> = {}) => ({
  id: "k1",
  tenantId: "t1",
  keyHash: KEY.hash,
  prefix: KEY.prefix,
  scopes: ["messages:write", "contacts:read", "contacts:write", "templates:read"],
  revokedAt: null,
  lastUsedAt: null,
  createdByUserId: "u1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});
const liveMembership = (over: { createdAt?: Date; user?: Record<string, unknown> | null; tenant?: Record<string, unknown> | null } = {}) => ({
  createdAt: over.createdAt ?? new Date("2025-01-01T00:00:00Z"),
  user: { disabledAt: null, ...over.user },
  tenant: { deletedAt: null, status: "active", ...over.tenant },
});
const req = (path: string, init: { method?: string; body?: unknown; key?: string | null } = {}) =>
  new Request(`https://wa.edwyz.com${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY.key}` }), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  db.apiKey.findUnique.mockImplementation(async ({ where }) => (where.keyHash === KEY.hash ? keyRow() : null));
  db.apiKey.updateMany.mockResolvedValue({ count: 1 });
  db.membership.findUnique.mockResolvedValue(liveMembership());
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  billing.assertWithinLimit.mockResolvedValue(undefined);
});

describe("api keys", () => {
  it("generates wak_ keys, stores only the sha256 and an 8 character prefix", async () => {
    expect(KEY.key).toMatch(/^wak_[A-Za-z0-9_-]{40,}$/);
    expect(KEY.prefix).toBe(KEY.key.slice(0, 8));
    expect(KEY.prefix).toHaveLength(8);
    expect(KEY.hash).toBe(hashApiKey(KEY.key));
    expect(KEY.hash).toMatch(/^[0-9a-f]{64}$/);

    db.apiKey.count.mockResolvedValue(0);
    db.apiKey.create.mockImplementation(async ({ data }) => ({ id: "k", name: data.name, prefix: data.prefix, scopes: data.scopes, createdAt: new Date() }));
    const { key, apiKey } = await createApiKey({ userId: "u1", tenantId: "t1", role: "admin" }, { name: "CRM", scopes: ["messages:write"] });
    const stored = db.apiKey.create.mock.calls[0][0].data;
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(stored).toMatchObject({ tenantId: "t1", keyHash: hashApiKey(key), prefix: key.slice(0, 8), createdByUserId: "u1" });
    expect(JSON.stringify(apiKey)).not.toContain(key);
  });

  it("rejects unknown scopes and missing names", async () => {
    const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };
    await expect(createApiKey(actor, { name: "x", scopes: ["admin:all"] })).rejects.toMatchObject({ status: 400 });
    await expect(createApiKey(actor, { name: "x", scopes: [] })).rejects.toMatchObject({ status: 400 });
    await expect(createApiKey(actor, { name: " ", scopes: ["messages:write"] })).rejects.toMatchObject({ status: 400 });
  });

  it("revokes only within the tenant", async () => {
    db.apiKey.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(revokeApiKey("t1", "foreign")).rejects.toMatchObject({ status: 404 });
    expect(db.apiKey.updateMany.mock.calls[0][0].where).toEqual({ id: "foreign", tenantId: "t1", revokedAt: null });
  });

  describe("authenticateApiKey", () => {
    const actorOf = async (r: Request) => (await authenticateApiKey(r))?.actor ?? null;
    it("returns an agent actor for the creating user and checks that user's membership in the key's tenant", async () => {
      expect(await actorOf(req("/x"))).toEqual({ userId: "u1", tenantId: "t1", role: "agent" });
      expect(db.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: KEY.hash } });
      expect(db.membership.findUnique.mock.calls[0][0].where).toEqual({ tenantId_userId: { tenantId: "t1", userId: "u1" } });
    });
    it("returns null for non-key credentials, unknown keys and revoked keys", async () => {
      expect(await actorOf(req("/x", { key: null }))).toBeNull();
      expect(await actorOf(req("/x", { key: "eyJhbGciOi.jwt.token" }))).toBeNull();
      expect(await actorOf(req("/x", { key: "wak_unknownunknownunknown" }))).toBeNull();
      db.apiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: new Date() }));
      expect(await actorOf(req("/x"))).toBeNull();
    });
    it("touches lastUsedAt at most once a minute", async () => {
      await actorOf(req("/x"));
      expect(db.apiKey.updateMany).toHaveBeenCalledTimes(1);
      db.apiKey.updateMany.mockClear();
      db.apiKey.findUnique.mockResolvedValue(keyRow({ lastUsedAt: new Date(Date.now() - 10_000) }));
      await actorOf(req("/x"));
      expect(db.apiKey.updateMany).not.toHaveBeenCalled();
      db.apiKey.findUnique.mockResolvedValue(keyRow({ lastUsedAt: new Date(Date.now() - 61_000) }));
      await actorOf(req("/x"));
      expect(db.apiKey.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("a key dies with its creator's access (P3-07)", () => {
    it("rejects the key when the creator no longer has a membership", async () => {
      db.membership.findUnique.mockResolvedValue(null);
      expect(await authenticateApiKey(req("/x"))).toBeNull();
      expect((await getTemplates(req("/api/v1/templates"))).status).toBe(401);
    });
    it("rejects the key when the creator is disabled", async () => {
      db.membership.findUnique.mockResolvedValue(liveMembership({ user: { disabledAt: new Date() } }));
      expect(await authenticateApiKey(req("/x"))).toBeNull();
    });
    it("rejects the key when the workspace is deleted (401) and keeps the key row", async () => {
      db.membership.findUnique.mockResolvedValue(liveMembership({ tenant: { deletedAt: new Date() } }));
      expect(await authenticateApiKey(req("/x"))).toBeNull();
      expect(db.apiKey.updateMany).not.toHaveBeenCalled();
    });
    it("answers 403 with a clear message while the workspace is suspended, and keeps the key so it works after reinstatement", async () => {
      db.membership.findUnique.mockResolvedValue(liveMembership({ tenant: { status: "suspended" } }));
      await expect(authenticateApiKey(req("/x"))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/suspended/) });
      expect((await getTemplates(req("/api/v1/templates"))).status).toBe(403);
      expect(db.apiKey.updateMany).not.toHaveBeenCalled();
    });
    it("revokes the creator's keys for good the first time a removed member's key is used, so a re-invite cannot revive it", async () => {
      db.membership.findUnique.mockResolvedValue(null);
      expect(await authenticateApiKey(req("/x"))).toBeNull();
      expect(db.apiKey.updateMany).toHaveBeenCalledTimes(1);
      expect(db.apiKey.updateMany.mock.calls[0][0]).toMatchObject({ where: { createdByUserId: "u1", tenantId: "t1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    });
    it("revokes for good when the creator is disabled, so re-enabling the user does not revive the key", async () => {
      db.membership.findUnique.mockResolvedValue(liveMembership({ user: { disabledAt: new Date() } }));
      expect(await authenticateApiKey(req("/x"))).toBeNull();
      expect(db.apiKey.updateMany.mock.calls[0][0].data).toEqual({ revokedAt: expect.any(Date) });
    });
    it("does not honour a key made before the creator's current membership began (removed, then re-invited)", async () => {
      db.membership.findUnique.mockResolvedValue(liveMembership({ createdAt: new Date("2026-06-01T00:00:00Z") }));
      expect(await authenticateApiKey(req("/x"))).toBeNull();
      expect(db.apiKey.updateMany.mock.calls[0][0].where).toMatchObject({ createdByUserId: "u1", tenantId: "t1" });
    });
    it("a key made after the membership began works", async () => {
      expect(await authenticateApiKey(req("/x"))).toMatchObject({ keyId: "k1" });
    });
    it("a failing revoke write still refuses the key", async () => {
      db.membership.findUnique.mockResolvedValue(null);
      db.apiKey.updateMany.mockRejectedValue(new Error("db"));
      expect(await authenticateApiKey(req("/x"))).toBeNull();
    });
    it("listApiKeys shows keys of members who are gone as revoked and revokes them in the database", async () => {
      const at = new Date("2026-01-01T00:00:00Z");
      const row = (id: string, userId: string) => ({ id, name: id, prefix: `wak_${id}`, scopes: ["messages:write"], lastUsedAt: null, revokedAt: null, createdAt: at, createdByUserId: userId });
      db.apiKey.findMany.mockResolvedValue([row("k1", "u1"), row("k2", "u2"), row("k3", "u3")]);
      db.membership.findMany.mockResolvedValue([
        { userId: "u1", createdAt: new Date("2025-01-01T00:00:00Z"), user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } },
        { userId: "u3", createdAt: new Date("2025-01-01T00:00:00Z"), user: { disabledAt: new Date() }, tenant: { deletedAt: null, status: "active" } },
      ]);
      const list = await listApiKeys("t1");
      expect(list.map((k) => [k.id, k.revokedAt !== null])).toEqual([["k1", false], ["k2", true], ["k3", true]]);
      expect(list[0]).not.toHaveProperty("createdByUserId");
      expect(db.apiKey.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["k2", "k3"] }, tenantId: "t1" } });
    });
    it("revokeKeysForUser revokes only that user's active keys, optionally for one workspace", async () => {
      db.apiKey.updateMany.mockResolvedValue({ count: 2 });
      expect(await revokeKeysForUser("u1", "t1")).toBe(2);
      expect(db.apiKey.updateMany.mock.calls[0][0].where).toEqual({ createdByUserId: "u1", revokedAt: null, tenantId: "t1" });
      await revokeKeysForUser("u1");
      expect(db.apiKey.updateMany.mock.calls[1][0].where).toEqual({ createdByUserId: "u1", revokedAt: null });
    });
  });
});

describe("v1 authentication, scopes and limits", () => {
  it("401 without a key, and cookies alone do not authenticate", async () => {
    const res = await getTemplates(new Request("https://wa.edwyz.com/api/v1/templates", { headers: { cookie: "wa_access=abc" } }));
    expect(res.status).toBe(401);
    expect((await getTemplates(req("/api/v1/templates", { key: "wak_wrongwrongwrongwrong" }))).status).toBe(401);
  });
  it("401 for a revoked key", async () => {
    db.apiKey.findUnique.mockResolvedValue(keyRow({ revokedAt: new Date() }));
    expect((await getTemplates(req("/api/v1/templates"))).status).toBe(401);
  });
  it("403 when the scope is missing", async () => {
    db.apiKey.findUnique.mockResolvedValue(keyRow({ scopes: ["templates:read"] }));
    expect((await getContacts(req("/api/v1/contacts"))).status).toBe(403);
    expect((await postMessage(req("/api/v1/messages", { method: "POST", body: {} }))).status).toBe(403);
    db.template.findMany.mockResolvedValue([]);
    expect((await getTemplates(req("/api/v1/templates"))).status).toBe(200);
  });
  it("429 after 60 requests in a minute, with Retry-After", async () => {
    db.template.findMany.mockResolvedValue([]);
    for (let i = 0; i < 60; i++) expect((await getTemplates(req("/api/v1/templates"))).status).toBe(200);
    const res = await getTemplates(req("/api/v1/templates"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
  it("rate limits per key, not globally", async () => {
    db.template.findMany.mockResolvedValue([]);
    for (let i = 0; i < 61; i++) await getTemplates(req("/api/v1/templates"));
    const other = generateApiKey();
    db.apiKey.findUnique.mockImplementation(async ({ where }) => (where.keyHash === other.hash ? keyRow({ id: "k2", keyHash: other.hash }) : null));
    expect((await getTemplates(req("/api/v1/templates", { key: other.key }))).status).toBe(200);
  });
  it("applies the billing paywall to writes only", async () => {
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(402, "Your subscription has lapsed."));
    expect((await postContact(req("/api/v1/contacts", { method: "POST", body: { phone: "+919876543210" } }))).status).toBe(402);
    expect((await postMessage(req("/api/v1/messages", { method: "POST", body: { to: "+919876543210", type: "text", text: "x" } }))).status).toBe(402);
    db.contact.findMany.mockResolvedValue([]);
    expect((await getContacts(req("/api/v1/contacts"))).status).toBe(200);
    expect(billing.assertTenantCanWrite).toHaveBeenCalledWith("t1");
  });
  it("errors are JSON without stack traces", async () => {
    db.template.findMany.mockRejectedValue(new Error("connection string postgres://user:pw@host leaked"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await getTemplates(req("/api/v1/templates"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong." });
  });
});

describe("v1 data routes are tenant scoped", () => {
  it("lists templates and contacts for the key's tenant only, with a trimmed shape", async () => {
    db.template.findMany.mockResolvedValue([{ id: "x", tenantId: "t1", wabaRefId: "w", name: "promo", language: "en", category: "MARKETING", status: "approved", components: [], metaTemplateId: "9" }]);
    const t = await (await getTemplates(req("/api/v1/templates"))).json();
    expect(t.templates).toEqual([{ name: "promo", language: "en", category: "MARKETING", status: "approved", components: [] }]);
    expect(db.template.findMany.mock.calls[0][0].where.tenantId).toBe("t1");

    db.contact.findMany.mockResolvedValue([{ id: "c1", tenantId: "t1", phone: "+919876543210", name: "A", tags: [], attributes: {}, optIn: true, optInAt: null, optedOutAt: null, createdAt: new Date(), optInSource: "form" }]);
    const c = await (await getContacts(req("/api/v1/contacts?limit=5"))).json();
    expect(c.contacts[0]).not.toHaveProperty("tenantId");
    expect(db.contact.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });
});

describe("POST /api/v1/contacts", () => {
  const post = (body: unknown) => postContact(req("/api/v1/contacts", { method: "POST", body }));
  it("requires optInSource when optIn is true", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    expect((await post({ phone: "+919876543210", optIn: true })).status).toBe(400);
    expect(db.contact.create).not.toHaveBeenCalled();
  });
  it("creates with opt-in details and answers 201", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockImplementation(async ({ data }) => ({ id: "c1", name: null, tags: [], attributes: {}, optInAt: data.optInAt, optedOutAt: null, createdAt: new Date(), ...data }));
    const res = await post({ phone: "98765 43210", name: "Asha", optIn: true, optInSource: "website_form" });
    expect(res.status).toBe(201);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", phone: "+919876543210", optIn: true, optInSource: "website_form" });
    expect(billing.assertWithinLimit).toHaveBeenCalledWith("t1", "contacts", 1);
  });
  it("updates an existing contact (200) scoped by tenant", async () => {
    const existing = { id: "c1", tenantId: "t1", phone: "+919876543210", name: "Old", tags: [], attributes: {}, optIn: false, optInAt: null, optedOutAt: null, createdAt: new Date() };
    db.contact.findFirst.mockResolvedValue(existing);
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    const res = await post({ phone: "+919876543210", name: "New" });
    expect(res.status).toBe(200);
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { name: "New" } });
  });
  it("refuses to re-opt-in a contact who sent STOP (422)", async () => {
    db.contact.findFirst.mockResolvedValue({ id: "c1", optedOutAt: new Date() });
    expect((await post({ phone: "+919876543210", optIn: true, optInSource: "form" })).status).toBe(422);
  });
  it("rejects invalid phones", async () => {
    expect((await post({ phone: "abc" })).status).toBe(400);
  });
});

describe("POST /api/v1/messages", () => {
  const send = (body: unknown) => postMessage(req("/api/v1/messages", { method: "POST", body }));
  const contact = { id: "c1", tenantId: "t1", phone: "+919876543210", optedOutAt: null };
  beforeEach(() => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue(contact);
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.message.create.mockImplementation(async ({ data }) => ({ id: "m1", ...data }));
  });

  it("422 for an opted-out contact, for text and templates", async () => {
    db.contact.findFirst.mockResolvedValue({ ...contact, optedOutAt: new Date() });
    expect((await send({ to: "+919876543210", type: "text", text: "hi" })).status).toBe(422);
    expect((await send({ to: "+919876543210", type: "template", template: { name: "t", language: "en" } })).status).toBe(422);
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("409 for text when the 24-hour window is closed or never opened", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 25 * 3600_000) });
    const closed = await send({ to: "+919876543210", type: "text", text: "hi" });
    expect(closed.status).toBe(409);
    expect((await closed.json()).error).toMatch(/24-hour/);
    db.conversation.findFirst.mockResolvedValue(null);
    expect((await send({ to: "+919876543210", type: "text", text: "hi" })).status).toBe(409);
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("202 for text inside the window and queues a send job", async () => {
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date(Date.now() - 3600_000) });
    const res = await send({ to: "+919876543210", type: "text", text: "hi" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id: "m1", conversationId: "cv1", status: "queued" });
    expect(enqueue).toHaveBeenCalledWith("send", expect.objectContaining({ messageId: "m1", tenantId: "t1" }));
  });

  it("202 for a template at any time, scoped to the key's tenant", async () => {
    db.conversation.upsert.mockResolvedValue({ id: "cv2" });
    const res = await send({ to: "+919876543210", type: "template", template: { name: "promo", language: "en", components: [] } });
    expect(res.status).toBe(202);
    expect(db.phoneNumber.findFirst.mock.calls[0][0].where.tenantId).toBe("t1");
    expect(enqueue).toHaveBeenCalledWith("send", expect.objectContaining({ tenantId: "t1", template: { name: "promo", language: "en", components: [] } }));
  });

  describe("template gate (P3-06)", () => {
    const tpl = { to: "+919876543210", type: "template", template: { name: "promo", language: "en", components: [] } };
    beforeEach(() => db.conversation.upsert.mockResolvedValue({ id: "cv2" }));

    it("loads the template for the key's tenant and the sending number's WABA and requires status approved", async () => {
      await send(tpl);
      // Approved, or flagged by Meta (spend spec 6.3: only marketing broadcasts and assistants stop using a flagged template).
      expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", wabaRefId: "w1", name: "promo", language: "en", status: { in: ["approved", "flagged"] } });
    });
    it("404 when the template is not approved or does not exist, and nothing is created or queued", async () => {
      db.template.findFirst.mockResolvedValue(null);
      db.contact.findFirst.mockResolvedValue(null);
      expect((await send(tpl)).status).toBe(404);
      expect(db.contact.create).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
    });
    it("422 for a marketing template to a contact without opt-in", async () => {
      db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
      db.contact.findFirst.mockResolvedValue({ ...contact, optIn: false });
      const res = await send(tpl);
      expect(res.status).toBe(422);
      expect(db.message.create).not.toHaveBeenCalled();
    });
    it("never creates a contact as a side effect of a marketing send", async () => {
      db.template.findFirst.mockResolvedValue({ category: "marketing" });
      db.contact.findFirst.mockResolvedValue(null);
      expect((await send(tpl)).status).toBe(422);
      expect(db.contact.create).not.toHaveBeenCalled();
      expect(billing.assertWithinLimit).not.toHaveBeenCalled();
      expect(db.message.create).not.toHaveBeenCalled();
    });
    it("sends a marketing template to an opted-in contact", async () => {
      db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
      db.contact.findFirst.mockResolvedValue({ ...contact, optIn: true });
      expect((await send(tpl)).status).toBe(202);
      expect(enqueue).toHaveBeenCalledWith("send", expect.objectContaining({ tenantId: "t1" }));
    });
    it("still lets a utility template reach a new number, creating the contact", async () => {
      db.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ ...contact, id: "c9" });
      db.contact.create.mockResolvedValue({ ...contact, id: "c9", optedOutAt: null });
      expect((await send(tpl)).status).toBe(202);
      expect(db.contact.create).toHaveBeenCalledTimes(1);
    });
    it("a text send never creates a contact", async () => {
      db.contact.findFirst.mockResolvedValue(null);
      expect((await send({ to: "+919876543210", type: "text", text: "hi" })).status).toBe(409);
      expect(db.contact.create).not.toHaveBeenCalled();
    });
  });

  it("validates input", async () => {
    expect((await send({ to: "nope", type: "text", text: "x" })).status).toBe(400);
    expect((await send({ to: "+919876543210", type: "image" })).status).toBe(400);
    expect((await send({ to: "+919876543210", type: "template" })).status).toBe(400);
    db.conversation.findFirst.mockResolvedValue({ id: "cv1", lastInboundAt: new Date() });
    expect((await send({ to: "+919876543210", type: "text", text: "" })).status).toBe(400);
  });

  it("409 when the tenant has no connected number", async () => {
    db.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await send({ to: "+919876543210", type: "text", text: "x" })).status).toBe(409);
  });
});
