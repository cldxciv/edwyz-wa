import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  enqueue: vi.fn(),
  append: vi.fn(),
  runPass: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { webhookEvent: { create: mocks.create }, $executeRaw: vi.fn(async () => 1) } }));
vi.mock("@/lib/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/lib/storage", () => ({ appendJsonLine: mocks.append }));
vi.mock("@/worker/loop", () => ({ runPass: mocks.runPass }));

import { POST as tick } from "@/app/api/internal/tick/route";
import { GET, POST } from "@/app/webhooks/whatsapp/route";

const SECRET = "app-secret";
const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const post = (raw: string, sig: string | null) =>
  new Request("https://wa.edwyz.com/webhooks/whatsapp", { method: "POST", body: raw, headers: sig ? { "x-hub-signature-256": sig } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_SECRET = SECRET;
  process.env.META_VERIFY_TOKEN = "verify-me";
  mocks.create.mockResolvedValue({ id: "evt1" });
});

describe("webhook route", () => {
  it("rejects a bad signature and stores nothing", async () => {
    const res = await POST(post(body, "sha256=deadbeef"));
    expect(res.status).toBe(401);
    expect((await POST(post(body, null))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("accepts a good signature, stores the event and enqueues a webhook job", async () => {
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith({ data: { payload: JSON.parse(body), signatureValid: true } });
    expect(mocks.enqueue).toHaveBeenCalledWith("webhook", { eventId: "evt1" });
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("answers 500 when the database write fails so Meta retries", async () => {
    mocks.create.mockRejectedValue(new Error("db down"));
    const res = await POST(post(body, sign(body)));
    expect(res.status).toBe(500);
  });

  it("keeps the GET handshake", async () => {
    const url = "https://wa.edwyz.com/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc";
    const ok = GET(new Request(url));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc");
    expect(GET(new Request(url.replace("verify-me", "nope"))).status).toBe(403);
  });
});

describe("POST /api/internal/tick", () => {
  const call = (secret?: string) =>
    tick(new Request("https://wa.edwyz.com/api/internal/tick", { method: "POST", headers: secret ? { "x-worker-secret": secret } : {} }));

  beforeEach(() => {
    process.env.WORKER_SECRET = "right-secret";
    mocks.runPass.mockResolvedValue({ webhook: 1, send: 2, swept: 0 });
  });

  it("rejects a wrong or missing secret", async () => {
    expect((await call("wrong-secret")).status).toBe(403);
    expect((await call()).status).toBe(403);
    expect(mocks.runPass).not.toHaveBeenCalled();
  });

  it("rejects everything when WORKER_SECRET is not configured", async () => {
    delete process.env.WORKER_SECRET;
    expect((await call("anything")).status).toBe(403);
  });

  it("runs a pass with the right secret", async () => {
    const res = await call("right-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webhook: 1, send: 2, swept: 0 });
  });
});
