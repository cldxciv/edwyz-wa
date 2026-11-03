import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
vi.mock("@/lib/crypto/tokens", () => ({ encrypt: () => ({ ciphertext: "c", iv: "i", authTag: "a" }), decrypt: () => "s" }));
vi.mock("@/lib/integrations/ssrf", () => ({ assertPublicUrl: vi.fn(async () => ({})) }));

import { GET as getContacts, POST as postContact } from "@/app/api/ext/v3/contacts/route";
import { GET as getContact } from "@/app/api/ext/v3/contacts/[target]/route";
import { PUT as putContactRoute } from "@/app/api/ext/v3/contacts/[target]/route";
import { PUT as putAttributesRoute } from "@/app/api/ext/v3/contacts/[target]/attributes/route";
import { POST as postTags } from "@/app/api/ext/v3/contacts/[target]/tags/route";
import { POST as postText } from "@/app/api/ext/v3/conversations/[target]/messages/text/route";
import { POST as postTemplate } from "@/app/api/ext/v3/messageTemplates/send/route";
import { GET as getBroadcast } from "@/app/api/ext/v3/broadcasts/[id]/route";
import { GET as getWebhooks, POST as postWebhook } from "@/app/api/ext/v3/webhooks/route";
import { HANDLERS } from "@/lib/compat/handlers";
import { resetCompatLimits } from "@/lib/compat/runtime";
import { ENDPOINTS, RATE_LIMIT_REQUESTS, routeFilePath } from "@/lib/compat/spec";
import { generateApiKey } from "@/lib/integrations/apikeys";

const KEY = generateApiKey();
const ALL = ["messages:write", "contacts:read", "contacts:write", "templates:read", "conversations:read", "broadcasts:read", "webhooks:manage"];
let scopes = ALL;
let tenantId = "t1";

const req = (p: string, init: { method?: string; body?: unknown; key?: string | null } = {}) =>
  new Request(`https://wa.edwyz.com/api/ext/v3${p}`, {
    method: init.method ?? "GET",
    headers: { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY.key}` }), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

const contactRow = (over: Record<string, unknown> = {}) => ({
  id: "c1", tenantId: "t1", phone: "+919876543210", name: "Asha", tags: ["vip"], attributes: { external_id: "crm-7", city: "Pune" },
  optIn: true, optInSource: "form", optInAt: null, optedOutAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCompatLimits();
  scopes = ALL;
  tenantId = "t1";
  db.apiKey.findUnique.mockImplementation(async ({ where }) =>
    where.keyHash === KEY.hash ? { id: "k1", tenantId, keyHash: KEY.hash, scopes, revokedAt: null, lastUsedAt: new Date(), createdByUserId: "u1" } : null,
  );
  billing.assertTenantCanWrite.mockResolvedValue(undefined);
  billing.assertWithinLimit.mockResolvedValue(undefined);
  db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "active" } });
  installIdempotencyStore();
});

type Row = { value: unknown; updatedAt: Date };
let store = new Map<string, Row>();
function installIdempotencyStore() {
  store = new Map();
  db.platformSetting.create.mockImplementation(async ({ data }) => {
    if (store.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
    store.set(data.key, { value: data.value, updatedAt: new Date() });
    return { key: data.key };
  });
  db.platformSetting.findUnique.mockImplementation(async ({ where }) => (store.has(where.key) ? { key: where.key, ...store.get(where.key)! } : null));
  db.platformSetting.update.mockImplementation(async ({ where, data }) => {
    store.set(where.key, { value: data.value, updatedAt: new Date() });
    return {};
  });
  db.platformSetting.deleteMany.mockImplementation(async ({ where }) => {
    const row = store.get(where.key);
    if (!row || (where.updatedAt?.lt && !(row.updatedAt < where.updatedAt.lt))) return { count: 0 };
    store.delete(where.key);
    return { count: 1 };
  });
}

describe("spec and routes", () => {
  const root = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  it("registers exactly the routes and methods in the spec table", () => {
    const files = walk(path.join(root, "src/app/api/ext/v3")).map((f) => path.relative(root, f).split(path.sep).join("/"));
    const expectedFiles = [...new Set(ENDPOINTS.map((e) => routeFilePath(e.path)))].sort();
    expect(files.sort()).toEqual(expectedFiles);
    for (const file of expectedFiles) {
      const src = readFileSync(path.join(root, file), "utf8");
      const declared = [...src.matchAll(/export const (GET|POST|PUT|DELETE) = route\("([^"]+)"\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
      const wanted = ENDPOINTS.filter((e) => routeFilePath(e.path) === file).map((e) => `${e.method} ${e.id}`).sort();
      expect(declared).toEqual(wanted);
    }
  });

  it("has a handler for every endpoint id and unique ids and method+path pairs", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(ENDPOINTS.map((e) => e.id).sort());
    expect(new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`)).size).toBe(ENDPOINTS.length);
  });

  it("documentation pages read from the table and name no third-party product", () => {
    const docs = walk(path.join(root, "src/app/(site)/docs")).concat(walk(path.join(root, "src/lib/compat")));
    const text = docs.map((f) => readFileSync(f, "utf8")).join("\n").toLowerCase();
    expect(readFileSync(path.join(root, "src/app/(site)/docs/endpoints/page.tsx"), "utf8")).toContain("ENDPOINTS");
    expect(text).not.toContain("wati");
  });
});

describe("shape, pagination and errors", () => {
  it("lists contacts with the pagination envelope and snake_case fields", async () => {
    db.contact.findMany.mockResolvedValue([contactRow()]);
    db.contact.count.mockResolvedValue(45);
    const res = await getContacts(req("/contacts?page_number=2&page_size=20"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, page_number: 2, page_size: 20, total: 45, has_more: true });
    expect(json.contact_list[0]).toMatchObject({ id: "c1", phone_number: "+919876543210", external_id: "crm-7", opt_in: true });
    expect(json.contact_list[0].custom_params).toContainEqual({ name: "city", value: "Pune" });
    expect(db.contact.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" }, skip: 20, take: 20 });
  });

  it("has_more is false at the end of the 10000-row window and window_exhausted tells the caller to narrow the list", async () => {
    db.contact.findMany.mockResolvedValue([contactRow()]);
    db.contact.count.mockResolvedValue(20_000);
    const last = await (await getContacts(req("/contacts?page_number=100&page_size=100"))).json();
    expect(last).toMatchObject({ has_more: false, window_exhausted: true });
    const before = await (await getContacts(req("/contacts?page_number=99&page_size=100"))).json();
    expect(before).toMatchObject({ has_more: true, window_exhausted: false });
    db.contact.count.mockResolvedValue(1);
    expect(await (await getContacts(req("/contacts?page_number=1&page_size=100"))).json()).toMatchObject({ has_more: false, window_exhausted: false });
  });

  it("caps offset pagination at page_number x page_size <= 10000 (P3-16)", async () => {
    for (const q of ["page_number=1000000&page_size=100", "page_number=101&page_size=100", "page_number=501&page_size=20"]) {
      const res = await getContacts(req(`/contacts?${q}`));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/10000/);
    }
    expect(db.contact.findMany).not.toHaveBeenCalled();
    db.contact.findMany.mockResolvedValue([]);
    db.contact.count.mockResolvedValue(0);
    expect((await getContacts(req("/contacts?page_number=100&page_size=100"))).status).toBe(200);
    expect((await getContacts(req("/contacts?page_number=500&page_size=20"))).status).toBe(200);
  });

  it("rejects page_size above 100 with the standard error shape", async () => {
    const res = await getContacts(req("/contacts?page_size=101"));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(typeof json.error.message).toBe("string");
  });

  it("returns a null phone_number for contacts without one", async () => {
    db.contact.findFirst.mockResolvedValue(contactRow({ phone: null }));
    const json = await (await getContact(req("/contacts/external_id:crm-7"), ctx({ target: "external_id:crm-7" }))).json();
    expect(json.contact.phone_number).toBeNull();
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", attributes: { path: ["external_id"], equals: "crm-7" } });
  });

  it("refuses to message a contact that has no phone number", async () => {
    db.contact.findFirst.mockResolvedValue(contactRow({ phone: null }));
    const res = await postText(req("/x", { method: "POST", body: { text: "hi" } }), ctx({ target: "external_id:crm-7" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("unprocessable");
  });

  it("treats bare digits in a path as a full international number", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    const res = await getContact(req("/contacts/14155550123"), ctx({ target: "14155550123" }));
    expect(res.status).toBe(404);
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", phone: "+14155550123" });
  });

  it("creates a contact (201) and answers 409 for a duplicate", async () => {
    db.contact.findFirst.mockResolvedValue(null);
    db.contact.create.mockImplementation(async ({ data }) => contactRow({ ...data, id: "new" }));
    const ok = await postContact(req("/contacts", { method: "POST", body: { phone_number: "919876543210", name: "A", external_id: "e1", tags: ["x"] } }));
    expect(ok.status).toBe(201);
    expect(db.contact.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", phone: "+919876543210", tags: ["x"], attributes: { external_id: "e1" } });

    db.contact.findFirst.mockResolvedValue(contactRow());
    const dup = await postContact(req("/contacts", { method: "POST", body: { phone_number: "919876543210" } }));
    expect(dup.status).toBe(409);
  });

  describe("external_id stays unique inside a workspace, however it arrives", () => {
    const owner = contactRow({ id: "c1", attributes: { external_id: "crm-7" } });
    const other = contactRow({ id: "c2", phone: "+919876500000", attributes: { external_id: "crm-9" } });
    // contact lookups by external_id:<value> answer with whoever holds it; lookups by id answer with the contact in the path.
    beforeEach(() => {
      db.contact.findFirst.mockImplementation(async ({ where }) => {
        const ext = where?.attributes?.equals;
        if (ext) return [owner, other].find((c) => c.attributes.external_id === ext) ?? null;
        return where?.id === "c2" ? other : owner;
      });
      db.contact.updateMany.mockResolvedValue({ count: 1 });
      db.contact.findFirstOrThrow.mockResolvedValue(other);
    });

    it("refuses custom_params that give a contact an external_id another contact already has (update and attributes)", async () => {
      const body = { custom_params: [{ name: "external_id", value: "crm-7" }] };
      const put = await putContactRoute(req("/x", { method: "PUT", body }), ctx({ target: "c2" }));
      expect(put.status).toBe(409);
      const attrs = await putAttributesRoute(req("/x", { method: "PUT", body }), ctx({ target: "c2" }));
      expect(attrs.status).toBe(409);
      expect(db.contact.updateMany).not.toHaveBeenCalled();
    });

    it("refuses it on create when only custom_params carries it", async () => {
      const res = await postContact(req("/contacts", { method: "POST", body: { phone_number: "919876543299", custom_params: [{ name: "external_id", value: "crm-7" }] } }));
      expect(res.status).toBe(409);
      expect(db.contact.create).not.toHaveBeenCalled();
    });

    it("allows a contact to keep its own external_id, to take a free one, and to drop it with null", async () => {
      for (const value of ["crm-9", "crm-new", null]) {
        const res = await putAttributesRoute(req("/x", { method: "PUT", body: { custom_params: [{ name: "external_id", value }] } }), ctx({ target: "c2" }));
        expect(res.status, String(value)).toBe(200);
      }
    });

    it("refuses an external_id that is not text", async () => {
      const res = await putAttributesRoute(req("/x", { method: "PUT", body: { custom_params: [{ name: "external_id", value: "" }] } }), ctx({ target: "c2" }));
      expect(res.status).toBe(400);
    });
  });

  it("adds tags without losing existing ones", async () => {
    db.contact.findFirst.mockResolvedValue(contactRow());
    db.contact.updateMany.mockResolvedValue({ count: 1 });
    db.contact.findFirstOrThrow.mockResolvedValue(contactRow({ tags: ["vip", "new"] }));
    const res = await postTags(req("/x", { method: "POST", body: { tags: ["new"] } }), ctx({ target: "c1" }));
    expect((await res.json()).contact.tags).toEqual(["vip", "new"]);
    expect(db.contact.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "c1", tenantId: "t1" }, data: { tags: ["vip", "new"] } });
  });
});

describe("auth, scope, rate limit and tenancy", () => {
  it("answers 401 without a valid token", async () => {
    expect((await getContacts(req("/contacts", { key: null }))).status).toBe(401);
    expect((await getContacts(req("/contacts", { key: "wak_nope" }))).status).toBe(401);
  });

  it("answers 403 when the scope is missing and never reaches the database", async () => {
    scopes = ["contacts:read"];
    const res = await postContact(req("/contacts", { method: "POST", body: { phone_number: "919876543210" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("contacts:write");
    expect(db.contact.create).not.toHaveBeenCalled();
    scopes = ["contacts:write"];
    expect((await getWebhooks(req("/webhooks"))).status).toBe(403);
  });

  it("rate limits per key per 10 seconds with Retry-After", async () => {
    db.contact.findMany.mockResolvedValue([]);
    db.contact.count.mockResolvedValue(0);
    for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) expect((await getContacts(req("/contacts"))).status).toBe(200);
    const res = await getContacts(req("/contacts"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect((await res.json()).error.code).toBe("rate_limited");
  });

  it("filters every query by the token's workspace, whatever the path says", async () => {
    tenantId = "t2";
    db.broadcast.findFirst.mockResolvedValue(null);
    const res = await getBroadcast(req("/broadcasts/b-of-t1"), ctx({ id: "b-of-t1" }));
    expect(res.status).toBe(404);
    expect(db.broadcast.findFirst.mock.calls[0][0].where).toMatchObject({ id: "b-of-t1", tenantId: "t2" });
    db.contact.findFirst.mockResolvedValue(null);
    await getContact(req("/contacts/c1"), ctx({ target: "c1" }));
    expect(db.contact.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t2" });
  });

  it("blocks writes when billing refuses", async () => {
    const { HttpError } = await import("@/lib/tenancy");
    billing.assertTenantCanWrite.mockRejectedValue(new HttpError(403, "Subscription inactive."));
    expect((await postContact(req("/contacts", { method: "POST", body: { phone_number: "919876543210" } }))).status).toBe(403);
  });
});

describe("compat key liveness (P3-07)", () => {
  it("401 when the key creator has left or is disabled, 403 while the workspace is suspended", async () => {
    db.contact.findMany.mockResolvedValue([]);
    db.contact.count.mockResolvedValue(0);
    expect((await getContacts(req("/contacts"))).status).toBe(200);
    db.membership.findUnique.mockResolvedValue(null);
    expect((await getContacts(req("/contacts"))).status).toBe(401);
    db.membership.findUnique.mockResolvedValue({ user: { disabledAt: new Date() }, tenant: { deletedAt: null, status: "active" } });
    expect((await getContacts(req("/contacts"))).status).toBe(401);
    db.membership.findUnique.mockResolvedValue({ user: { disabledAt: null }, tenant: { deletedAt: null, status: "suspended" } });
    const suspended = await getContacts(req("/contacts"));
    expect(suspended.status).toBe(403);
    expect((await suspended.json()).error.message).toMatch(/suspended/);
  });
});

describe("sending and idempotency", () => {
  const approved = { id: "tp1", name: "hello", language: "en", status: "approved", components: [{ type: "BODY", text: "Hi {{1}}" }] };

  beforeEach(() => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "pn1" });
    db.contact.findFirst.mockResolvedValue(contactRow());
    db.template.findMany.mockResolvedValue([approved]);
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.message.create.mockImplementation(async () => ({ id: "m1", conversationId: "cv1", status: "queued" }));
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
  });

  const send = (recipients: unknown[]) => postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "hello", broadcast_name: "b", recipients } }));

  it("sends a template with ordered parameters and reports per recipient", async () => {
    const res = await send([{ phone_number: "919876543210", local_message_id: "L1", custom_params: [{ name: "name", value: "Asha" }] }]);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, success: true, broadcast_name: "b", recipients: [{ local_message_id: "L1", phone_number: "+919876543210", message_id: "m1", errors: null, deduplicated: false }] });
    expect(db.message.create).toHaveBeenCalledTimes(1);
  });

  it("every recipient in the response conforms to the published OpenAPI schema, accepted and rejected alike", async () => {
    const { buildOpenApi } = await import("@/lib/compat/openapi");
    type PropSchema = { type: string | string[] };
    const item = ((buildOpenApi("https://wa.test") as any).components.schemas as Record<string, any>).TemplateSendResult.properties.recipients.items as { properties: Record<string, PropSchema>; required: string[] };
    const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
    const json = await (await send([{ phone_number: "919876543210", local_message_id: "L1", custom_params: [{ name: "name", value: "Asha" }] }, { phone_number: "919876543211", custom_params: [] }])).json();
    expect(json.recipients).toHaveLength(2);
    for (const r of json.recipients as Record<string, unknown>[]) {
      for (const key of item.required) expect(Object.keys(r), key).toContain(key);
      for (const [key, value] of Object.entries(r)) {
        const types = ([] as string[]).concat(item.properties[key]?.type ?? []);
        expect(types, `${key} is documented`).not.toHaveLength(0);
        expect(types, `${key} (${kindOf(value)})`).toContain(kindOf(value));
      }
    }
  });

  it("reports a wrong parameter count for that recipient only", async () => {
    const json = await (await send([{ phone_number: "919876543210", custom_params: [] }, { phone_number: "919876543211", custom_params: [{ name: "1", value: "B" }] }])).json();
    expect(json.success).toBe(false);
    expect(json.recipients[0].errors[0]).toContain("1 parameter");
    expect(json.recipients[1].errors).toBeNull();
  });

  it("does not send again for the same local_message_id within 24 hours", async () => {
    const item = { phone_number: "919876543210", local_message_id: "L2", custom_params: [{ name: "1", value: "A" }] };
    await send([item]);
    const [key, row] = [...store.entries()][0];
    expect(key).toMatch(/^compat:idem:t1:[0-9a-f]{40}$/);
    expect(row.value).toMatchObject({ state: "done", result: { message_id: "m1", conversation_id: "cv1" } });
    expect(JSON.stringify([key, row.value])).not.toContain("9876543210");

    const json = await (await send([item])).json();
    expect(json.recipients[0]).toMatchObject({ message_id: "m1", deduplicated: true });
    expect(db.message.create).toHaveBeenCalledTimes(1);
  });

  it("creates the idempotency row before the send and completes it afterwards (P3-22)", async () => {
    let seenDuringSend: unknown;
    db.message.create.mockImplementation(async () => {
      seenDuringSend = [...store.values()][0]?.value;
      return { id: "m1", conversationId: "cv1", status: "queued" };
    });
    await send([{ phone_number: "919876543210", local_message_id: "L5", custom_params: [{ name: "1", value: "A" }] }]);
    expect(seenDuringSend).toMatchObject({ state: "pending" });
    expect([...store.values()][0].value).toMatchObject({ state: "done" });
  });

  it("a retry after the completion write was lost does not send twice (pending claim answers 409)", async () => {
    db.platformSetting.update.mockRejectedValue(new Error("db down"));
    const item = { phone_number: "919876543210", local_message_id: "L6", custom_params: [{ name: "1", value: "A" }] };
    expect((await (await send([item])).json()).recipients[0].message_id).toBe("m1");
    const retry = await (await send([item])).json();
    expect(retry.recipients[0].errors[0]).toMatch(/in progress|unknown/);
    expect(db.message.create).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("another process holding a finished claim wins: no send, original result returned", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    const fingerprint = { type: "text", text: "hi" };
    store.set(idempotencyKey("t1", "+919876543210", "L7"), {
      value: { state: "done", bodyHash: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"), result: { message_id: "m0", conversation_id: "cv0", status: "sent" } },
      updatedAt: new Date(),
    });
    const sender = vi.fn();
    expect(await sendOnce("t1", "+919876543210", "L7", fingerprint, sender)).toMatchObject({ id: "m0", duplicate: true });
    expect(sender).not.toHaveBeenCalled();
  });

  it("422 when the same local_message_id arrives with a different body (P3-22)", async () => {
    await send([{ phone_number: "919876543210", local_message_id: "L8", custom_params: [{ name: "1", value: "A" }] }]);
    const json = await (await send([{ phone_number: "919876543210", local_message_id: "L8", custom_params: [{ name: "1", value: "DIFFERENT" }] }])).json();
    expect(json.recipients[0].message_id).toBeNull();
    expect(json.recipients[0].errors[0]).toMatch(/different message/);
    expect(db.message.create).toHaveBeenCalledTimes(1);

    const { sendOnce } = await import("@/lib/compat/idempotency");
    await expect(sendOnce("t1", "+919876543210", "L8", { type: "text", text: "other" }, vi.fn())).rejects.toMatchObject({ status: 422 });
  });

  it("releases the claim when the send fails so the caller can retry", async () => {
    db.contact.findFirst.mockResolvedValue(contactRow({ optIn: false }));
    db.template.findMany.mockResolvedValue([{ ...approved, category: "MARKETING" }]);
    db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
    const item = { phone_number: "919876543210", local_message_id: "L9", custom_params: [{ name: "1", value: "A" }] };
    expect((await (await send([item])).json()).recipients[0].errors[0]).toMatch(/opt-in/);
    expect(store.size).toBe(0);
    db.contact.findFirst.mockResolvedValue(contactRow({ optIn: true }));
    expect((await (await send([item])).json()).recipients[0].message_id).toBe("m1");
  });

  it("an expired claim (older than 24 hours) can be replaced", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    store.set(idempotencyKey("t1", "+919876543210", "OLD"), {
      value: { state: "done", bodyHash: "x", result: { message_id: "m0", conversation_id: "cv0", status: "sent" } },
      updatedAt: new Date(Date.now() - 25 * 3600_000),
    });
    const sender = vi.fn(async () => ({ id: "m2", conversationId: "cv2", status: "queued" }));
    expect(await sendOnce("t1", "+919876543210", "OLD", { type: "text", text: "hi" }, sender)).toMatchObject({ id: "m2", duplicate: false });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("a pending claim older than 60 seconds is abandoned: replaced and sent once, with no 3 s poll (was a 409 after 90 s)", async () => {
    const { sendOnce, idempotencyKey, PENDING_STALE_MS } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    expect(PENDING_STALE_MS).toBe(60_000);
    const fingerprint = { type: "text", text: "hi" };
    const key = idempotencyKey("t1", "+919876543210", "STALE");
    store.set(key, {
      value: { state: "pending", bodyHash: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex") },
      updatedAt: new Date(Date.now() - 61_000),
    });
    const sender = vi.fn(async () => ({ id: "m9", conversationId: "cv9", status: "queued" }));
    const started = Date.now();
    expect(await sendOnce("t1", "+919876543210", "STALE", fingerprint, sender)).toMatchObject({ id: "m9", duplicate: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(store.get(key)?.value).toMatchObject({ state: "done", result: { message_id: "m9" } });
  });

  it("many recipients with stale claims each take over without polling (no 3 s per recipient)", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    const fingerprint = { type: "text", text: "hi" };
    const bodyHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    for (let i = 0; i < 5; i++) store.set(idempotencyKey("t1", `+9198765432${10 + i}`, "S"), { value: { state: "pending", bodyHash }, updatedAt: new Date(Date.now() - 120_000) });
    const sender = vi.fn(async () => ({ id: "mm", conversationId: "cv", status: "queued" }));
    const started = Date.now();
    for (let i = 0; i < 5; i++) await sendOnce("t1", `+9198765432${10 + i}`, "S", fingerprint, sender);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sender).toHaveBeenCalledTimes(5);
  });

  it("a claim at 50 seconds is still in flight: no takeover, the caller waits for the sender's result", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    const fingerprint = { type: "text", text: "hi" };
    const key = idempotencyKey("t1", "+919876543210", "YOUNG");
    const bodyHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    store.set(key, { value: { state: "pending", bodyHash }, updatedAt: new Date(Date.now() - 50_000) });
    setTimeout(() => store.set(key, { value: { state: "done", bodyHash, result: { message_id: "mx", conversation_id: "cx", status: "sent" } }, updatedAt: new Date() }), 300);
    const sender = vi.fn();
    expect(await sendOnce("t1", "+919876543210", "YOUNG", fingerprint, sender)).toMatchObject({ id: "mx", duplicate: true });
    expect(sender).not.toHaveBeenCalled();
  });

  it("when two callers race to replace the same stale claim only one sends; the loser waits for the winner's result", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    const fingerprint = { type: "text", text: "hi" };
    const key = idempotencyKey("t1", "+919876543210", "RACE");
    const bodyHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    store.set(key, { value: { state: "pending", bodyHash }, updatedAt: new Date(Date.now() - 120_000) });
    const sender = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { id: "mw", conversationId: "cw", status: "queued" };
    });
    // distinct fingerprints objects with equal content avoid the in-process dedupe, as two server processes would
    const results = await Promise.all([
      sendOnce("t1", "+919876543210", "RACE", { ...fingerprint }, sender, new Date(Date.now() + 1)),
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return sendOnce("t1", "+919876543210", "RACE", { ...fingerprint }, vi.fn(), new Date());
      })(),
    ]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.id)).toEqual(["mw", "mw"]);
  });

  it("a fresh pending claim still waits for the other sender and returns its result", async () => {
    const { sendOnce, idempotencyKey } = await import("@/lib/compat/idempotency");
    const { createHash } = await import("node:crypto");
    const fingerprint = { type: "text", text: "hi" };
    const key = idempotencyKey("t1", "+919876543210", "FRESH");
    const bodyHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    store.set(key, { value: { state: "pending", bodyHash }, updatedAt: new Date() });
    setTimeout(() => store.set(key, { value: { state: "done", bodyHash, result: { message_id: "mx", conversation_id: "cx", status: "sent" } }, updatedAt: new Date() }), 300);
    const sender = vi.fn();
    expect(await sendOnce("t1", "+919876543210", "FRESH", fingerprint, sender)).toMatchObject({ id: "mx", duplicate: true });
    expect(sender).not.toHaveBeenCalled();
  });

  it("prunes expired claims in bulk, at most once per interval per process (P3-22)", async () => {
    const { sendOnce, resetIdempotencySweep } = await import("@/lib/compat/idempotency");
    resetIdempotencySweep();
    const ok = async () => ({ id: "m1", conversationId: "cv1", status: "queued" });
    await sendOnce("t1", "+919876543210", "S1", { a: 1 }, ok);
    const sweeps = () => db.platformSetting.deleteMany.mock.calls.filter(([a]) => typeof a.where.key === "object");
    expect(sweeps()).toHaveLength(1);
    expect(sweeps()[0][0].where).toMatchObject({ key: { startsWith: "compat:idem:" }, updatedAt: { lt: expect.any(Date) } });
    await sendOnce("t1", "+919876543210", "S2", { a: 1 }, ok);
    expect(sweeps()).toHaveLength(1);
  });

  it("writes a compat.send audit row without personal data for sends with and without a local_message_id", async () => {
    const { sendOnce } = await import("@/lib/compat/idempotency");
    const ok = async () => ({ id: "m7", conversationId: "cv1", status: "queued" });
    await sendOnce("t1", "+919876543210", "A1", { a: 1 }, ok);
    await sendOnce("t1", "+919876543210", undefined, { a: 1 }, ok);
    const rows = db.auditLog.create.mock.calls.map(([a]) => a.data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenantId: "t1", action: "compat.send", target: "m7" });
    expect(JSON.stringify(rows)).not.toContain("9876543210");
  });

  it("refuses a marketing template for a contact without opt-in and creates no contact (P3-06)", async () => {
    db.template.findMany.mockResolvedValue([{ ...approved, category: "MARKETING" }]);
    db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
    db.contact.findFirst.mockResolvedValue(null);
    const json = await (await send([{ phone_number: "919876543210", custom_params: [{ name: "1", value: "A" }] }])).json();
    expect(json.success).toBe(false);
    expect(json.recipients[0].errors[0]).toMatch(/opt-in/);
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("collapses concurrent duplicates into one send", async () => {
    const item = { phone_number: "919876543210", local_message_id: "L3", custom_params: [{ name: "1", value: "A" }] };
    const [a, b] = await Promise.all([send([item]), send([item])]);
    const flags = [(await a.json()).recipients[0].deduplicated, (await b.json()).recipients[0].deduplicated].sort();
    expect(flags).toEqual([false, true]);
    expect(db.message.create).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown or unapproved template and validates the recipient list", async () => {
    db.template.findMany.mockResolvedValue([]);
    expect((await send([{ phone_number: "919876543210" }])).status).toBe(404);
    expect((await send([])).status).toBe(400);
  });

  describe("templates with a media header, a header placeholder or a link button", () => {
    const rich = {
      ...approved,
      name: "promo",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Hi {{1}}, offer {{2}}" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", text: "Open", url: "https://shop.test/{{1}}" }] },
      ],
    };
    const sendRich = (recipient: Record<string, unknown>) =>
      postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "promo", recipients: [{ phone_number: "919876543210", ...recipient }] } }));
    const params = [{ name: "1", value: "Asha" }, { name: "2", value: "Diwali" }];

    beforeEach(() => db.template.findMany.mockResolvedValue([rich]));

    it("builds header, body and button components from the recipient's values", async () => {
      const json = await (await sendRich({ custom_params: params, header_param: "https://cdn.test/a.jpg", button_params: [{ index: 1, value: "diwali 10" }] })).json();
      expect(json.success).toBe(true);
      const { enqueue } = await import("@/lib/queue");
      const queued = JSON.stringify(vi.mocked(enqueue).mock.calls);
      expect(queued).toContain("https://cdn.test/a.jpg");
      expect(queued).toContain("diwali%2010");
      expect(queued).toContain("Diwali");
    });

    it("tells the caller which value is missing instead of sending a broken message", async () => {
      const noHeader = await (await sendRich({ custom_params: params, button_params: [{ index: 1, value: "x" }] })).json();
      expect(noHeader.recipients[0].errors[0]).toMatch(/image header; send header_param/);
      const noButton = await (await sendRich({ custom_params: params, header_param: "https://cdn.test/a.jpg" })).json();
      expect(noButton.recipients[0].errors[0]).toMatch(/link button at position 1/);
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it("refuses a header link that is not https and parameters the template does not have", async () => {
      const http = await (await sendRich({ custom_params: params, header_param: "http://cdn.test/a.jpg", button_params: [{ index: 1, value: "x" }] })).json();
      expect(http.recipients[0].errors[0]).toMatch(/https link/);
      const stray = await (await sendRich({ custom_params: params, header_param: "https://cdn.test/a.jpg", button_params: [{ index: 0, value: "x" }, { index: 1, value: "x" }] })).json();
      expect(stray.recipients[0].errors[0]).toMatch(/no link placeholder on button 0/);
      const badShape = await (await sendRich({ custom_params: params, button_params: "x" })).json();
      expect(badShape.recipients[0].errors[0]).toMatch(/button_params/);
      expect(db.message.create).not.toHaveBeenCalled();
    });

    it("rejects header_param for a template with a plain header-less layout", async () => {
      db.template.findMany.mockResolvedValue([approved]);
      const json = await (await send([{ phone_number: "919876543210", custom_params: [{ name: "1", value: "A" }], header_param: "https://cdn.test/a.jpg" }])).json();
      expect(json.recipients[0].errors[0]).toMatch(/no header placeholder/);
    });

    it("fills named placeholders by name (sent with parameter_name) and a coupon-code button from button_params", async () => {
      const named = {
        ...approved,
        name: "promo",
        components: [{ type: "BODY", text: "Hi {{first_name}}, use {{code_hint}}" }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copy code" }] }],
      };
      db.template.findMany.mockResolvedValue([named]);
      const ok = await (await sendRich({ custom_params: [{ name: "code_hint", value: "the code below" }, { name: "first_name", value: "Asha" }], button_params: [{ index: 0, value: "SAVE20" }] })).json();
      expect(ok.success).toBe(true);
      const { enqueue } = await import("@/lib/queue");
      const queued = JSON.stringify(vi.mocked(enqueue).mock.calls);
      expect(queued).toContain('"parameter_name":"first_name"');
      expect(queued).toContain('"coupon_code":"SAVE20"');
      const unknown = await (await sendRich({ custom_params: [{ name: "first", value: "A" }, { name: "code_hint", value: "x" }], button_params: [{ index: 0, value: "SAVE20" }] })).json();
      expect(unknown.recipients[0].errors[0]).toMatch(/no placeholder named first/);
      const noCoupon = await (await sendRich({ custom_params: [{ name: "first_name", value: "A" }, { name: "code_hint", value: "x" }] })).json();
      expect(noCoupon.recipients[0].errors[0]).toMatch(/coupon-code button at position 0/);
      const badCoupon = await (await sendRich({ custom_params: [{ name: "first_name", value: "A" }, { name: "code_hint", value: "x" }], button_params: [{ index: 0, value: "50% off" }] })).json();
      expect(badCoupon.recipients[0].errors[0]).toMatch(/coupon code is up to 15 letters and numbers/);
    });

    it("sends a login-code template: the code fills the body and the copy-code button, synced from Meta or saved here", async () => {
      const { enqueue } = await import("@/lib/queue");
      const sentComponents = () => JSON.stringify(vi.mocked(enqueue).mock.calls.at(-1));
      const bodyParam = '{"type":"body","parameters":[{"type":"text","text":"482913"}]}';
      const buttonParam = '{"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"482913"}]}';
      const synced = {
        ...approved,
        name: "promo",
        category: "AUTHENTICATION",
        components: [
          { type: "BODY", text: "{{1}} is your verification code.", add_security_recommendation: true },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Copy code", url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}" }] },
        ],
      };
      db.template.findMany.mockResolvedValue([synced]);
      const ok = await (await sendRich({ custom_params: [{ name: "1", value: "482913" }], button_params: [{ index: 0, value: "482913" }] })).json();
      expect(ok.success).toBe(true);
      expect(sentComponents()).toContain(bodyParam);
      expect(sentComponents()).toContain(buttonParam);
      // The button carries the same code as the body, so button_params may be left out.
      const bodyOnly = await (await sendRich({ custom_params: [{ name: "1", value: "482913" }] })).json();
      expect(bodyOnly.success).toBe(true);
      expect(sentComponents()).toContain(buttonParam);

      const local = { ...synced, components: [{ type: "BODY", add_security_recommendation: true }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }] };
      db.template.findMany.mockResolvedValue([local]);
      const fromLocal = await (await sendRich({ custom_params: [{ name: "1", value: "482913" }] })).json();
      expect(fromLocal.success).toBe(true);
      expect(sentComponents()).toContain(bodyParam);
      expect(sentComponents()).toContain(buttonParam);
      expect(sentComponents()).not.toContain("whatsapp.com/otp");
      const noCode = await (await sendRich({})).json();
      expect(noCode.recipients[0].errors[0]).toMatch(/takes 1 parameter\(s\); got 0/);
    });
  });

  it("sends session text through the 24-hour window rules", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    const closed = await postText(req("/x", { method: "POST", body: { text: "hi" } }), ctx({ target: "c1" }));
    expect(closed.status).toBe(409);

    db.conversation.findFirst.mockImplementation(async ({ where }) => (where.id === "c1" ? null : { id: "cv1", lastInboundAt: new Date() }));
    const ok = await postText(req("/x", { method: "POST", body: { text: "hi", local_message_id: "T1" } }), ctx({ target: "c1" }));
    const json = await ok.json();
    expect(ok.status).toBe(202);
    expect(json.message).toMatchObject({ id: "m1", conversation_id: "cv1", local_message_id: "T1", deduplicated: false });
  });

  it("sends in the named conversation, on the number it belongs to, when the workspace has two numbers", async () => {
    // cvB belongs to number B; number A (the oldest) has no open chat with this contact.
    const chatB = { id: "cvB", tenantId: "t1", contactId: "c1", contact: contactRow(), lastInboundAt: new Date(), phoneNumber: { id: "pnB", phoneNumberId: "meta-B", wabaRefId: "w1" } };
    db.conversation.findFirst.mockImplementation(async ({ where }) => (where.id === "cvB" ? chatB : null));
    const ok = await postText(req("/x", { method: "POST", body: { text: "hi" } }), ctx({ target: "cvB" }));
    expect(ok.status).toBe(202);
    expect((await ok.json()).message).toMatchObject({ conversation_id: "cvB" });
    expect(db.phoneNumber.findFirst).not.toHaveBeenCalled();
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ conversationId: "cvB" });
    expect(db.conversation.findFirst.mock.calls.every(([a]) => a.where.tenantId === "t1")).toBe(true);
  });

  it("refuses a channel that is not the number of the named conversation", async () => {
    const chatB = { id: "cvB", tenantId: "t1", contactId: "c1", contact: contactRow(), lastInboundAt: new Date(), phoneNumber: { id: "pnB", phoneNumberId: "meta-B", wabaRefId: "w1" } };
    db.conversation.findFirst.mockImplementation(async ({ where }) => (where.id === "cvB" ? chatB : null));
    const res = await postText(req("/x", { method: "POST", body: { text: "hi", channel: "meta-A" } }), ctx({ target: "cvB" }));
    expect(res.status).toBe(400);
    expect(db.message.create).not.toHaveBeenCalled();
  });
});

describe("webhooks", () => {
  it("creates a subscription, returns the secret once and maps to snake_case", async () => {
    db.webhookEndpoint.count.mockResolvedValue(0);
    db.webhookEndpoint.create.mockImplementation(async ({ data }) => ({ id: "w1", url: data.url, events: data.events, enabled: true, failureCount: 0, createdAt: new Date() }));
    const res = await postWebhook(req("/webhooks", { method: "POST", body: { url: "https://example.com/h", event_types: ["message.received"] } }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json.signing_secret).toMatch(/^whsec_/);
    expect(json.webhook).toMatchObject({ id: "w1", event_types: ["message.received"], status: "enabled" });
    expect(JSON.stringify(json.webhook)).not.toContain("whsec_");
    expect(db.webhookEndpoint.create.mock.calls[0][0].data.tenantId).toBe("t1");
  });

  it("lists with the envelope and rejects unknown events", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "w1", url: "https://e.com", events: ["message.status"], enabled: false, failureCount: 20, createdAt: new Date() }]);
    const json = await (await getWebhooks(req("/webhooks"))).json();
    expect(json).toMatchObject({ webhook_list: [{ status: "disabled", failure_count: 20 }], total: 1, has_more: false });
    expect(db.webhookEndpoint.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    const bad = await postWebhook(req("/webhooks", { method: "POST", body: { url: "https://example.com/h", event_types: ["nope"] } }));
    expect(bad.status).toBe(400);
  });
});

describe("origins of API sends (docs/SPEND-CONTROLS-SPEC.md 4.9)", () => {
  const approved = { id: "tp1", name: "hello", language: "en", status: "approved", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}" }] };

  beforeEach(() => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "pn1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue(contactRow());
    db.template.findMany.mockResolvedValue([approved]);
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.message.create.mockImplementation(async ({ data }) => ({ id: "m1", conversationId: "cv1", status: "queued", ...data }));
    db.conversation.upsert.mockResolvedValue({ id: "cv1" });
    db.conversation.updateMany.mockResolvedValue({ count: 1 });
  });

  it("messageTemplates/send queues its messages as origin api", async () => {
    const res = await postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "hello", recipients: [{ phone_number: "919876543210", custom_params: [{ name: "1", value: "A" }] }] } }));
    expect(res.status).toBe(200);
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ origin: "api", type: "template", pricingCategory: "UTILITY" });
  });

  it("a template Meta flagged may still be sent through the API; any other status is refused", async () => {
    expect(db.template.findMany).not.toHaveBeenCalled();
    await postTemplate(req("/messageTemplates/send", { method: "POST", body: { template_name: "hello", recipients: [{ phone_number: "919876543210", custom_params: [{ name: "1", value: "A" }] }] } }));
    expect(db.template.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", name: "hello", status: { in: ["approved", "flagged"] } });
  });

  it("a text reply in an open chat is queued as origin api", async () => {
    const chat = { id: "cv1", tenantId: "t1", contactId: "c1", contact: contactRow(), lastInboundAt: new Date(), referral: null, createdAt: new Date(), phoneNumber: { id: "pn1", phoneNumberId: "meta-A", wabaRefId: "w1" } };
    db.conversation.findFirst.mockResolvedValue(chat);
    db.contact.findFirst.mockResolvedValue(contactRow());
    const res = await postText(req("/x", { method: "POST", body: { text: "hi" } }), ctx({ target: "919876543210" }));
    expect(res.status).toBe(202);
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ origin: "api", type: "text", body: "hi" });
  });
});
