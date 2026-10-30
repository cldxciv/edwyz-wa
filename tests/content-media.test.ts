import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ scheduledPost: { findFirst: vi.fn() } }));
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner", tenantId: "t1" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: auth.tenantId, role: auth.role }) }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/approvals", () => ({ createApproval: vi.fn(), expireDecidedApprovals: vi.fn(async () => 0) }));
vi.mock("@/lib/meta-connect", () => ({ listAssets: vi.fn(async () => []) }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));

import { DELETE as deleteRoute } from "@/app/api/content/media/[file]/route";
import { DEFAULT_MEDIA_QUOTA_MB, mediaPublicUrl, mediaQuotaBytes, mediaUsage, mediaUsageBytes, saveUpload, verifySignature } from "@/lib/content/media";

const ORIGIN = "https://wa.edwyz.com";
const GOOD_SECRET = "9f3a6c1e8b2d47f05a7e9c3b1d6f4a82c5e0b7391d8a6f2e4c7b0a9d3e5f1862";
const dir = mkdtempSync(path.join(tmpdir(), "content-media-"));
const saved = { data: process.env.DATA_DIR, quota: process.env.CONTENT_MEDIA_QUOTA_MB, secret: process.env.CONTENT_MEDIA_SECRET, state: process.env.STATE_SECRET, node: process.env.NODE_ENV };

const jpeg = (bytes: number) => {
  const b = Buffer.alloc(bytes, 7);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const upload = (tenant: string, bytes: number) =>
  saveUpload(tenant, new Request(`${ORIGIN}/api/content/media`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg(bytes) }));
const declared = (tenant: string, bytes: number) =>
  saveUpload(tenant, new Request(`${ORIGIN}/api/content/media`, { method: "POST", headers: { "content-type": "image/jpeg", "content-length": String(bytes) }, body: jpeg(bytes) }));
const del = (file: string, origin: string | null = ORIGIN) =>
  deleteRoute(new Request(`${ORIGIN}/api/content/media/${file}`, { method: "DELETE", headers: origin ? { origin } : {} }), { params: Promise.resolve({ file }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATA_DIR = dir;
  process.env.CONTENT_MEDIA_SECRET = GOOD_SECRET;
  delete process.env.CONTENT_MEDIA_QUOTA_MB;
  delete process.env.CONTENT_MEDIA_MAX_FILES;
  auth.role = "admin";
  auth.tenantId = "t1";
  db.scheduledPost.findFirst.mockResolvedValue(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries({ DATA_DIR: saved.data, CONTENT_MEDIA_QUOTA_MB: saved.quota, CONTENT_MEDIA_SECRET: saved.secret, STATE_SECRET: saved.state })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllEnvs();
});

describe("per-tenant media quota (P3-15)", () => {
  it("defaults to 500 MB and reads CONTENT_MEDIA_QUOTA_MB", () => {
    expect(DEFAULT_MEDIA_QUOTA_MB).toBe(500);
    expect(mediaQuotaBytes()).toBe(500 * 1048576);
    process.env.CONTENT_MEDIA_QUOTA_MB = "2";
    expect(mediaQuotaBytes()).toBe(2 * 1048576);
    process.env.CONTENT_MEDIA_QUOTA_MB = "junk";
    expect(mediaQuotaBytes()).toBe(500 * 1048576);
  });

  it("refuses an upload that would pass the quota, counts only that tenant, and frees room on delete", async () => {
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.02";
    const first = await upload("quota1", 8000);
    expect(await mediaUsageBytes("quota1")).toBe(8000);
    await upload("quota1", 8000);
    await expect(upload("quota1", 8000)).rejects.toMatchObject({ status: 413 });
    expect(await mediaUsageBytes("quota1")).toBe(16000);
    await expect(upload("quota2", 8000)).resolves.toBeTruthy();

    auth.tenantId = "quota1";
    expect((await del(first.key)).status).toBe(200);
    await expect(upload("quota1", 8000)).resolves.toBeTruthy();
  });

  it("stops a streamed upload that exceeds the remaining room, without leaving a partial file", async () => {
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.01";
    await expect(upload("quota3", 20000)).rejects.toMatchObject({ status: 413 });
    expect(await mediaUsageBytes("quota3")).toBe(0);
  });
});

describe("the quota is a hard bound (P3-15)", () => {
  it("parallel uploads cannot overshoot it: room is reserved per tenant, not read once per request", async () => {
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.03";
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => declared("burst1", 8000)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 413 });
    expect((await mediaUsage("burst1")).charged).toBeLessThanOrEqual(mediaQuotaBytes());
  });

  it("parallel uploads with no declared length reserve what is left, so the total still stays inside the quota", async () => {
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.03";
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => upload("burst2", 8000)));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await mediaUsage("burst2")).charged).toBeLessThanOrEqual(mediaQuotaBytes());
  });

  it("a client that declares less than it sends is cut off at what it declared", async () => {
    const lying = new Request(`${ORIGIN}/api/content/media`, { method: "POST", headers: { "content-type": "image/jpeg", "content-length": "100" }, body: jpeg(50_000) });
    await expect(saveUpload("liar1", lying)).rejects.toMatchObject({ status: 413 });
    expect(await mediaUsageBytes("liar1")).toBe(0);
  });

  it("tiny files are charged a whole disk block each", async () => {
    process.env.CONTENT_MEDIA_QUOTA_MB = "0.02";
    for (let i = 0; i < 5; i++) await upload("tiny1", 12);
    expect(await mediaUsageBytes("tiny1")).toBe(60);
    expect((await mediaUsage("tiny1")).charged).toBe(5 * 4096);
    await expect(upload("tiny1", 12)).rejects.toMatchObject({ status: 413 });
  });

  it("caps the number of files per workspace", async () => {
    process.env.CONTENT_MEDIA_MAX_FILES = "3";
    for (let i = 0; i < 3; i++) await upload("count1", 100);
    await expect(upload("count1", 100)).rejects.toMatchObject({ status: 413, message: expect.stringContaining("maximum of 3 files") });
    await expect(upload("count2", 100)).resolves.toBeTruthy();
  });

  it("sweeps upload leftovers from a crash, but not fresh ones, and they do not stay in the quota forever", async () => {
    const tdir = path.join(dir, "content", "crash1");
    mkdirSync(tdir, { recursive: true });
    const stale = path.join(tdir, `${"a".repeat(32)}.jpg.part`);
    const fresh = path.join(tdir, `${"b".repeat(32)}.jpg.part`);
    writeFileSync(stale, Buffer.alloc(5000));
    writeFileSync(fresh, Buffer.alloc(3000));
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, old, old);
    const usage = await mediaUsage("crash1");
    expect(usage.files).toBe(1);
    expect(usage.bytes).toBe(3000);
  });
});

describe("DELETE /api/content/media/[file] (P3-15)", () => {
  it("deletes the tenant's own file and 404s the second time", async () => {
    auth.tenantId = "del1";
    const file = await upload("del1", 100);
    expect((await del(file.key)).status).toBe(200);
    expect((await del(file.key)).status).toBe(404);
    expect(await mediaUsageBytes("del1")).toBe(0);
  });

  it("is tenant scoped: another workspace cannot delete the file", async () => {
    const file = await upload("owner1", 100);
    auth.tenantId = "intruder";
    expect((await del(file.key)).status).toBe(404);
    expect(await mediaUsageBytes("owner1")).toBe(100);
  });

  it("requires same origin and the admin role", async () => {
    const file = await upload("del2", 100);
    auth.tenantId = "del2";
    expect((await del(file.key, "https://evil.example")).status).toBe(403);
    expect((await del(file.key, null)).status).toBe(403);
    auth.role = "agent";
    expect((await del(file.key)).status).toBe(403);
    expect(await mediaUsageBytes("del2")).toBe(100);
  });

  it("refuses a file used by a draft, scheduled or publishing post", async () => {
    auth.tenantId = "del3";
    const file = await upload("del3", 100);
    db.scheduledPost.findFirst.mockResolvedValue({ id: "p1" });
    expect((await del(file.key)).status).toBe(409);
    const where = db.scheduledPost.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "del3", mediaKeys: { has: file.key }, status: { in: ["draft", "scheduled", "publishing"] } });
    expect(await mediaUsageBytes("del3")).toBe(100);
  });

  it("rejects keys that are not in the strict shape", async () => {
    expect((await del("..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await del("notakey.jpg")).status).toBe(404);
  });
});

describe("media signing secret (P3-25)", () => {
  it("does not fall back to STATE_SECRET in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.CONTENT_MEDIA_SECRET;
    process.env.STATE_SECRET = GOOD_SECRET;
    expect(() => mediaPublicUrl("t1", "0123456789abcdef0123456789abcdef.jpg")).toThrow(/CONTENT_MEDIA_SECRET is not configured/);
  });

  it("rejects short or low-entropy secrets in every environment", () => {
    for (const weak of ["short", "t".repeat(64), "ab".repeat(32), "0123456789abcdef".repeat(2)]) {
      process.env.CONTENT_MEDIA_SECRET = weak;
      expect(() => mediaPublicUrl("t1", "0123456789abcdef0123456789abcdef.jpg")).toThrow(/too weak/);
    }
  });

  it("accepts 32 random bytes and still bounds the signature lifetime", () => {
    vi.stubEnv("NODE_ENV", "production");
    const url = new URL(mediaPublicUrl("t1", "0123456789abcdef0123456789abcdef.jpg", 1_000_000));
    expect(verifySignature("t1", "0123456789abcdef0123456789abcdef.jpg", url.searchParams.get("exp"), url.searchParams.get("sig"), 1_000_000)).toBe(true);
  });

  it("falls back to STATE_SECRET outside production only when it is strong", () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.CONTENT_MEDIA_SECRET;
    process.env.STATE_SECRET = GOOD_SECRET;
    expect(() => mediaPublicUrl("t1", "0123456789abcdef0123456789abcdef.jpg")).not.toThrow();
  });
});
