import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() });
  return { conversionEvent: model(), lead: model(), contact: model(), conversation: model(), platformSetting: model(), auditLog: { create: vi.fn() } };
});
const graph = vi.hoisted(() => ({ graphFetchAs: vi.fn() }));
const connect = vi.hoisted(() => ({ listAssets: vi.fn(), getAssetAccess: vi.fn() }));
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
const auth = vi.hoisted(() => ({ tenantId: "t1", role: "admin" }));

vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", async () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false) {
      super(message);
    }
  }
  return { GraphError, graphFetchAs: graph.graphFetchAs };
});
vi.mock("@/lib/meta-connect", () => connect);
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: auth.tenantId, role: auth.role }) }));

import { GraphError } from "@/lib/graph";
import { buildConversionPayload, conversionEventId, hashEmail, hashPhone } from "@/lib/conversions/payload";
import { parseReferral, captureReferral, listConversationsByAdSource } from "@/lib/conversions/referral";
import { queueConversion } from "@/lib/conversions";
import { deliverConversion } from "@/lib/conversions/worker";
import { POST as requeue } from "@/app/api/conversions/[id]/requeue/route";
import { GET as list } from "@/app/api/conversions/route";
import { PUT as putSettings } from "@/app/api/conversions/settings/route";

const ORIGIN = "https://wa.edwyz.com";
const EMAIL = "Jane.Doe@Example.com ";
const PHONE = "+91 98765-43210";
const baseEvent = { id: "e1", tenantId: "t1", leadId: "l1", contactId: null, datasetId: "", eventName: "QualifiedLead", eventTime: new Date("2026-10-01T00:00:00Z"), status: "pending", attempts: 0, response: null };

function setupDelivery(overrides: { optedOut?: boolean; datasets?: unknown[]; ctwa?: string | null } = {}) {
  db.conversionEvent.findFirst.mockResolvedValue({ ...baseEvent });
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.lead.findFirst.mockResolvedValue({ id: "l1", contactId: "c1", fields: { email: EMAIL } });
  db.contact.findFirst.mockResolvedValue({ id: "c1", phone: PHONE, attributes: {}, optedOutAt: overrides.optedOut ? new Date() : null });
  db.conversation.findFirst.mockResolvedValue(overrides.ctwa === null ? null : { referral: { ctwaClid: overrides.ctwa ?? "clid-123" } });
  connect.listAssets.mockResolvedValue(overrides.datasets ?? [{ id: "a1", type: "dataset", externalId: "ds-9", name: "DS", status: "active", meta: {} }]);
  connect.getAssetAccess.mockResolvedValue({ assetId: "a1", type: "dataset", externalId: "ds-9", name: "DS", token: "tok" });
  graph.graphFetchAs.mockResolvedValue({ events_received: 1 });
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.tenantId = "t1";
  auth.role = "admin";
});

describe("hashing", () => {
  it("matches known SHA-256 vectors", () => {
    expect(hashEmail("test@example.com")).toBe("973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b");
    expect(hashPhone("+1 (650) 555-1212")).toBe("e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176");
  });
  it("normalises case and whitespace for email and digits for phone", () => {
    expect(hashEmail("  TEST@Example.COM ")).toBe(hashEmail("test@example.com"));
    expect(hashPhone("+91 98765-43210")).toBe(hashPhone("919876543210"));
    expect(hashEmail("not-an-email")).toBeNull();
    expect(hashPhone("12")).toBeNull();
  });
  it("hashes the empty-ish known vector for phone digits", () => {
    expect(hashPhone("1234567")).toBe("8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414");
  });
});

describe("payload", () => {
  const payload = buildConversionPayload({ tenantId: "t1", subjectId: "l1", eventName: "QualifiedLead", eventTime: new Date("2026-10-01T00:00:00Z"), email: EMAIL, phone: PHONE, ctwaClid: "clid-123" });
  it("contains no raw PII", () => {
    const json = JSON.stringify(payload);
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("9876543210");
    expect(json).not.toContain("919876543210");
    expect(payload.data[0].user_data).toMatchObject({ em: [hashEmail(EMAIL)], ph: [hashPhone(PHONE)], ctwa_clid: "clid-123" });
    expect(payload.data[0]).toMatchObject({ action_source: "business_messaging", messaging_channel: "whatsapp", event_name: "QualifiedLead", event_time: 1790812800 });
  });
  it("uses system_generated without a click id", () => {
    const p = buildConversionPayload({ tenantId: "t1", subjectId: "l1", eventName: "Lead", eventTime: new Date(), email: EMAIL });
    expect(p.data[0].action_source).toBe("system_generated");
    expect(p.data[0]).not.toHaveProperty("messaging_channel");
  });
  it("derives a stable event id per subject and event, distinct across tenants", () => {
    expect(conversionEventId("t1", "l1", "Lead")).toBe(conversionEventId("t1", "l1", "Lead"));
    expect(conversionEventId("t1", "l1", "Lead")).not.toBe(conversionEventId("t1", "l1", "Purchase"));
    expect(conversionEventId("t1", "l1", "Lead")).not.toBe(conversionEventId("t2", "l1", "Lead"));
  });
});

describe("referral", () => {
  it("parses and caps the webhook referral, keeping only known string fields", () => {
    const ref = parseReferral({ referral: { source_type: "ad", source_id: "123", source_url: "https://fb.me/x", headline: "h".repeat(999), ctwa_clid: "abc", evil: "x", body: 5 } });
    expect(ref).toEqual({ sourceType: "ad", sourceId: "123", sourceUrl: "https://fb.me/x", headline: "h".repeat(300), ctwaClid: "abc" });
  });
  it("rejects missing, empty and javascript-url referrals", () => {
    expect(parseReferral({})).toBeNull();
    expect(parseReferral({ referral: {} })).toBeNull();
    expect(parseReferral({ referral: { source_url: "javascript:alert(1)" } })).toBeNull();
    expect(parseReferral(null)).toBeNull();
  });
  it("stores once, scoped to the tenant, without overwriting", async () => {
    db.conversation.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await captureReferral("t1", "cv1", { source_id: "9" })).toBe(true);
    expect(await captureReferral("t1", "cv1", { source_id: "10" })).toBe(false);
    const where = db.conversation.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "cv1", tenantId: "t1" });
    expect(where.referral).toBeDefined();
    expect(await captureReferral("t1", "cv1", { nothing: true })).toBe(false);
    expect(db.conversation.updateMany).toHaveBeenCalledTimes(2);
  });
  it("lists by ad source filtered on the tenant", async () => {
    db.conversation.findMany.mockResolvedValue([]);
    await listConversationsByAdSource("t1", { sourceId: "9" });
    expect(db.conversation.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });
});

describe("queueConversion", () => {
  it("records a pending event and enqueues delivery", async () => {
    db.lead.findFirst.mockResolvedValue({ id: "l1" });
    db.conversionEvent.findFirst.mockResolvedValue(null);
    db.conversionEvent.create.mockResolvedValue({ id: "e1" });
    await queueConversion("t1", { leadId: "l1", eventName: "Lead" });
    expect(db.lead.findFirst.mock.calls[0][0].where).toEqual({ id: "l1", tenantId: "t1" });
    expect(db.conversionEvent.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", status: "pending", leadId: "l1" });
    expect(queue.enqueue).toHaveBeenCalledWith("conversions", { tenantId: "t1", conversionEventId: "e1" }, expect.anything());
  });
  it("is idempotent for an existing pending or sent event", async () => {
    db.lead.findFirst.mockResolvedValue({ id: "l1" });
    db.conversionEvent.findFirst.mockResolvedValue({ id: "e1" });
    await queueConversion("t1", { leadId: "l1", eventName: "Lead" });
    expect(db.conversionEvent.create).not.toHaveBeenCalled();
  });
  it("ignores another tenant's lead and never throws", async () => {
    db.lead.findFirst.mockResolvedValue(null);
    await queueConversion("t2", { leadId: "l1", eventName: "Lead" });
    expect(db.conversionEvent.create).not.toHaveBeenCalled();
    db.lead.findFirst.mockRejectedValue(new Error("db down"));
    await expect(queueConversion("t1", { leadId: "l1", eventName: "Lead" })).resolves.toBeUndefined();
  });
});

describe("delivery worker", () => {
  it("sends a hashed payload to the dataset and marks sent", async () => {
    setupDelivery();
    await deliverConversion("t1", "e1", false);
    const [token, req] = graph.graphFetchAs.mock.calls[0];
    expect(token).toBe("tok");
    expect(req).toMatchObject({ path: "ds-9/events", method: "POST" });
    const json = JSON.stringify(req.body);
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("9876543210");
    expect(req.body.data[0].user_data.ctwa_clid).toBe("clid-123");
    expect(req.body.data[0].event_id).toBe(conversionEventId("t1", "l1", "QualifiedLead"));
    expect(db.conversionEvent.update.mock.calls[0][0].data).toMatchObject({ status: "sent", attempts: 1, datasetId: "ds-9" });
  });
  it("skips with a reason when no dataset is connected", async () => {
    setupDelivery({ datasets: [] });
    await deliverConversion("t1", "e1", false);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
    expect(db.conversionEvent.update.mock.calls[0][0].data).toMatchObject({ status: "skipped", response: { reason: "no_dataset" } });
  });
  it("skips when the workspace switch is off or the contact opted out", async () => {
    setupDelivery();
    db.platformSetting.findUnique.mockResolvedValue({ value: { enabled: false } });
    await deliverConversion("t1", "e1", false);
    expect(db.conversionEvent.update.mock.calls[0][0].data.response).toEqual({ reason: "disabled" });
    setupDelivery({ optedOut: true });
    await deliverConversion("t1", "e1", false);
    expect(db.conversionEvent.update.mock.calls[1][0].data.response).toEqual({ reason: "opted_out" });
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });
  it("throws on retryable errors until the last attempt, then marks failed", async () => {
    setupDelivery();
    graph.graphFetchAs.mockRejectedValue(new GraphError("busy", 503, undefined, undefined, true));
    await expect(deliverConversion("t1", "e1", false)).rejects.toThrow();
    expect(db.conversionEvent.update.mock.calls[0][0].data).toMatchObject({ attempts: 1 });
    await deliverConversion("t1", "e1", true);
    expect(db.conversionEvent.update.mock.calls[1][0].data.status).toBe("failed");
  });
  it("fails immediately on non-retryable errors", async () => {
    setupDelivery();
    graph.graphFetchAs.mockRejectedValue(new GraphError("bad param", 400, 100));
    await deliverConversion("t1", "e1", false);
    expect(db.conversionEvent.update.mock.calls[0][0].data.status).toBe("failed");
  });
  it("loads the event only within the job's tenant", async () => {
    db.conversionEvent.findFirst.mockResolvedValue(null);
    await deliverConversion("t2", "e1", false);
    expect(db.conversionEvent.findFirst.mock.calls[0][0].where).toEqual({ id: "e1", tenantId: "t2" });
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });
  it("does not resend sent events", async () => {
    db.conversionEvent.findFirst.mockResolvedValue({ ...baseEvent, status: "sent" });
    await deliverConversion("t1", "e1", false);
    expect(graph.graphFetchAs).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  const post = (path: string, origin: string | null = ORIGIN) => new Request(`${ORIGIN}${path}`, { method: "POST", headers: origin ? { origin } : {} });
  const ctx = { params: Promise.resolve({ id: "e1" }) };

  it("requeues only the tenant's failed events", async () => {
    db.conversionEvent.findFirst.mockResolvedValue({ id: "e1", status: "failed" });
    db.conversionEvent.updateMany.mockResolvedValue({ count: 1 });
    expect((await requeue(post("/api/conversions/e1/requeue"), ctx)).status).toBe(200);
    expect(db.conversionEvent.findFirst.mock.calls[0][0].where).toEqual({ id: "e1", tenantId: "t1" });
    expect(queue.enqueue).toHaveBeenCalled();
    db.conversionEvent.findFirst.mockResolvedValue({ id: "e1", status: "sent" });
    expect((await requeue(post("/api/conversions/e1/requeue"), ctx)).status).toBe(409);
    db.conversionEvent.findFirst.mockResolvedValue(null);
    expect((await requeue(post("/api/conversions/e1/requeue"), ctx)).status).toBe(404);
  });
  it("requires admin and same origin", async () => {
    auth.role = "agent";
    expect((await requeue(post("/api/conversions/e1/requeue"), ctx)).status).toBe(403);
    auth.role = "admin";
    expect((await requeue(post("/api/conversions/e1/requeue", "https://evil.example"), ctx)).status).toBe(403);
    auth.role = "agent";
    expect((await list(new Request(`${ORIGIN}/api/conversions`))).status).toBe(403);
  });
  it("lists events scoped to the tenant", async () => {
    db.conversionEvent.findMany.mockResolvedValue([{ id: "e1", eventName: "Lead", status: "skipped", response: { reason: "no_dataset" }, attempts: 0 }]);
    db.conversionEvent.groupBy.mockResolvedValue([{ status: "skipped", _count: { _all: 1 } }]);
    db.platformSetting.findUnique.mockResolvedValue(null);
    const body = await (await list(new Request(`${ORIGIN}/api/conversions?status=skipped`))).json();
    expect(db.conversionEvent.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "skipped" });
    expect(body.events[0].reason).toBe("no_dataset");
    expect(body.counts).toEqual({ skipped: 1 });
  });
  it("only accepts datasets connected to the tenant", async () => {
    connect.listAssets.mockResolvedValue([{ id: "a1", type: "dataset", externalId: "ds", name: null, status: "active", meta: {} }]);
    const put = (body: unknown) => putSettings(new Request(`${ORIGIN}/api/conversions/settings`, { method: "PUT", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await put({ enabled: true, datasetAssetId: "other-tenant-asset" })).status).toBe(400);
    expect((await put({ enabled: true, datasetAssetId: "a1" })).status).toBe(200);
    expect(db.platformSetting.upsert.mock.calls[0][0].where).toEqual({ key: "conversions:t1" });
  });
});
