import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() });
  return { webhookEndpoint: model(), webhookDelivery: model() };
});
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue }));

import { decrypt, encrypt } from "@/lib/crypto/tokens";
import { DISABLE_AFTER_FAILURES, processDelivery } from "@/lib/integrations/deliver";
import { createEndpoint, listEndpoints, rotateSecret, sendTestEvent } from "@/lib/integrations/endpoints";
import { emitEvent, MAX_DELIVERY_ATTEMPTS } from "@/lib/integrations/events";
import { signPayload, verifySignature } from "@/lib/integrations/signing";

const publicResolver = async () => ["93.184.216.34"];

describe("signing", () => {
  it("matches the documented test vector", () => {
    expect(signPayload("whsec_test", "1700000000", '{"a":1}')).toBe("sha256=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789");
  });
  it("verifies, and rejects tampering, wrong secrets and stale timestamps", () => {
    const sig = signPayload("s", "1700000000", "body");
    const now = 1700000000 * 1000;
    expect(verifySignature("s", "1700000000", "body", sig, 300, now)).toBe(true);
    expect(verifySignature("s", "1700000000", "body!", sig, 300, now)).toBe(false);
    expect(verifySignature("other", "1700000000", "body", sig, 300, now)).toBe(false);
    expect(verifySignature("s", "1700000000", "body", sig, 300, now + 301_000)).toBe(false);
    expect(verifySignature("s", "1700000000", "body", "sha256=short", 300, now)).toBe(false);
    expect(verifySignature("s", "nope", "body", sig, 300, now)).toBe(false);
  });
});

describe("emitEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.webhookDelivery.create.mockResolvedValue({ id: "d1" });
  });
  it("writes one delivery per subscribed enabled endpoint of the tenant and queues each", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    db.webhookDelivery.create.mockResolvedValueOnce({ id: "d1" }).mockResolvedValueOnce({ id: "d2" });
    await emitEvent("t1", "message.received", { hello: "world" });
    expect(db.webhookEndpoint.findMany).toHaveBeenCalledWith({ where: { tenantId: "t1", enabled: true, events: { has: "message.received" } }, select: { id: true } });
    expect(db.webhookDelivery.create).toHaveBeenCalledTimes(2);
    const first = db.webhookDelivery.create.mock.calls[0][0].data;
    expect(first).toMatchObject({ tenantId: "t1", endpointId: "e1", event: "message.received" });
    expect(first.payload).toMatchObject({ event: "message.received", data: { hello: "world" } });
    expect(enqueue).toHaveBeenCalledWith("outbound-webhook", { deliveryId: "d1", tenantId: "t1" }, { maxAttempts: MAX_DELIVERY_ATTEMPTS });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
  it("never throws and never logs payload content", async () => {
    db.webhookEndpoint.findMany.mockRejectedValue(new Error("db down: secret message text"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(emitEvent("t1", "message.status", { text: "private" })).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/private|secret message/);
    spy.mockRestore();
  });
  it("does nothing when no endpoint subscribes", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([]);
    await emitEvent("t1", "template.status", {});
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.webhookEndpoint.count.mockResolvedValue(0);
    db.webhookEndpoint.create.mockImplementation(async ({ data }) => ({ id: "e1", url: data.url, events: data.events, enabled: true, failureCount: 0, createdAt: new Date() }));
  });
  it("shows the secret once, stores it encrypted and never returns it again", async () => {
    const { endpoint, secret } = await createEndpoint("t1", { url: "https://hooks.example.com/in", events: ["message.received"] }, publicResolver);
    expect(secret).toMatch(/^whsec_/);
    const data = db.webhookEndpoint.create.mock.calls[0][0].data;
    expect(JSON.stringify(data)).not.toContain(secret);
    expect(decrypt({ ciphertext: data.secretCiphertext, iv: data.iv, authTag: data.authTag })).toBe(secret);
    expect(JSON.stringify(endpoint)).not.toContain("secret");
    await listEndpoints("t1");
    expect(db.webhookEndpoint.findMany.mock.calls[0][0].select).not.toHaveProperty("secretCiphertext");
  });
  it("rejects private destinations, bad events and http at creation", async () => {
    await expect(createEndpoint("t1", { url: "https://evil.example.com", events: ["message.received"] }, async () => ["10.0.0.1"])).rejects.toMatchObject({ status: 400 });
    await expect(createEndpoint("t1", { url: "http://hooks.example.com", events: ["message.received"] }, publicResolver)).rejects.toMatchObject({ status: 400 });
    await expect(createEndpoint("t1", { url: "https://hooks.example.com", events: ["nope"] }, publicResolver)).rejects.toMatchObject({ status: 400 });
    await expect(createEndpoint("t1", { url: "https://hooks.example.com", events: [] }, publicResolver)).rejects.toMatchObject({ status: 400 });
    expect(db.webhookEndpoint.create).not.toHaveBeenCalled();
  });
  it("rotates the secret tenant-scoped, and 404s for another tenant's endpoint", async () => {
    db.webhookEndpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    const { secret } = await rotateSecret("t1", "e1");
    expect(secret).toMatch(/^whsec_/);
    expect(db.webhookEndpoint.updateMany.mock.calls[0][0].where).toEqual({ id: "e1", tenantId: "t1" });
    db.webhookEndpoint.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(rotateSecret("t1", "foreign")).rejects.toMatchObject({ status: 404 });
  });
  it("queues a test event only for an endpoint of the tenant", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValueOnce({ id: "e1" });
    db.webhookDelivery.create.mockResolvedValue({ id: "d9" });
    expect(await sendTestEvent("t1", "e1")).toEqual({ deliveryId: "d9" });
    expect(db.webhookEndpoint.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "e1", tenantId: "t1" } }));
    db.webhookEndpoint.findFirst.mockResolvedValueOnce(null);
    await expect(sendTestEvent("t1", "foreign")).rejects.toMatchObject({ status: 404 });
  });
});

describe("processDelivery", () => {
  const secret = "whsec_unit";
  const enc = encrypt(secret);
  const endpoint = (over = {}) => ({ id: "e1", tenantId: "t1", url: "https://hooks.example.com/in", enabled: true, failureCount: 0, secretCiphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, ...over });
  const delivery = { id: "d1", tenantId: "t1", endpointId: "e1", event: "message.received", status: "pending", attempts: 0, payload: { id: "evt", event: "message.received", data: { x: 1 } } };
  const job = { deliveryId: "d1", tenantId: "t1" };
  const last = { attempt: 6, maxAttempts: 6, isLastAttempt: true };
  const notLast = { attempt: 1, maxAttempts: 6, isLastAttempt: false };

  beforeEach(() => {
    vi.clearAllMocks();
    db.webhookDelivery.findFirst.mockResolvedValue(delivery);
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint());
  });

  it("posts the signed JSON with the required headers and marks delivered", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 204 });
    await processDelivery(job, notLast, { resolve: publicResolver, transport, now: () => 1700000000_000 });
    const req = transport.mock.calls[0][0];
    expect(req.address).toBe("93.184.216.34");
    expect(req.timeoutMs).toBe(10_000);
    expect(req.headers["x-edwyz-event"]).toBe("message.received");
    expect(req.headers["x-edwyz-delivery"]).toBe("d1");
    expect(req.headers["x-edwyz-timestamp"]).toBe("1700000000");
    expect(req.headers["x-edwyz-signature"]).toBe(signPayload(secret, "1700000000", req.body));
    expect(JSON.parse(req.body)).toEqual(delivery.payload);
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith({ where: { id: "d1", tenantId: "t1" }, data: expect.objectContaining({ status: "delivered", lastStatus: 204, attempts: 1 }) });
  });

  it("resets the failure counter after a success", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ failureCount: 7 }));
    await processDelivery(job, notLast, { resolve: publicResolver, transport: async () => ({ status: 200 }) });
    expect(db.webhookEndpoint.updateMany).toHaveBeenCalledWith({ where: { id: "e1", tenantId: "t1" }, data: { failureCount: 0 } });
  });

  it("throws to retry on a non-2xx before the last attempt, without touching the failure count", async () => {
    await expect(processDelivery(job, notLast, { resolve: publicResolver, transport: async () => ({ status: 500 }) })).rejects.toThrow("500");
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "retrying", lastStatus: 500 }) }));
    expect(db.webhookEndpoint.updateMany).not.toHaveBeenCalled();
  });

  it("marks failed and increments failureCount on the last attempt", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ failureCount: 3 }));
    await processDelivery(job, last, { resolve: publicResolver, transport: async () => ({ status: 503 }) });
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    expect(db.webhookEndpoint.updateMany).toHaveBeenCalledWith({ where: { id: "e1", tenantId: "t1" }, data: { failureCount: 4 } });
  });

  it("disables the endpoint at the 20th consecutive failure", async () => {
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ failureCount: DISABLE_AFTER_FAILURES - 1 }));
    await processDelivery(job, last, { resolve: publicResolver, transport: async () => ({ status: 500 }) });
    expect(db.webhookEndpoint.updateMany).toHaveBeenCalledWith({ where: { id: "e1", tenantId: "t1" }, data: { failureCount: 20, enabled: false } });
  });

  it("treats a redirect as a failure and never follows it", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 302 });
    await processDelivery(job, last, { resolve: publicResolver, transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", lastError: "redirects are not followed" }) }));
  });

  it("re-checks the destination at send time and fails permanently without calling out", async () => {
    const transport = vi.fn();
    await processDelivery(job, notLast, { resolve: async () => ["169.254.169.254"], transport });
    expect(transport).not.toHaveBeenCalled();
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });

  it("records connection errors and timeouts without leaking details", async () => {
    await processDelivery(job, last, { resolve: publicResolver, transport: async () => Promise.reject(new Error("timeout")) });
    expect(db.webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: "timed out" }) }));
  });

  it("does not deliver to a disabled or missing endpoint and skips finished deliveries", async () => {
    const transport = vi.fn();
    db.webhookEndpoint.findFirst.mockResolvedValue(endpoint({ enabled: false }));
    await processDelivery(job, notLast, { resolve: publicResolver, transport });
    db.webhookEndpoint.findFirst.mockResolvedValue(null);
    await processDelivery(job, notLast, { resolve: publicResolver, transport });
    db.webhookDelivery.findFirst.mockResolvedValue({ ...delivery, status: "delivered" });
    await processDelivery(job, notLast, { resolve: publicResolver, transport });
    expect(transport).not.toHaveBeenCalled();
  });

  it("looks everything up by the tenant in the job", async () => {
    await processDelivery(job, notLast, { resolve: publicResolver, transport: async () => ({ status: 200 }) });
    expect(db.webhookDelivery.findFirst).toHaveBeenCalledWith({ where: { id: "d1", tenantId: "t1" } });
    expect(db.webhookEndpoint.findFirst).toHaveBeenCalledWith({ where: { id: "e1", tenantId: "t1" } });
  });
});
