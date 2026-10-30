import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  template: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  waba: { findFirst: vi.fn() },
}));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: async () => "tok_secret" }));
const authMock = vi.hoisted(() => ({ role: "admin" as "admin" | "agent" }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: authMock.role }) }));
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: () => undefined }));

import { MEDIA_RULES, checkUpload, looksLike, mediaTypeForMime, readBytesLimited, safeFilename, uploadTemplateHeaderSample } from "@/lib/templates/upload";
import { duplicateTemplate, headerMediaFrom } from "@/lib/templates/service";
import { POST } from "@/app/api/templates/media/route";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const pdf = new TextEncoder().encode("%PDF-1.7 ....");
const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

const actor = { userId: "u1", tenantId: "t1", role: "admin" as const };

beforeEach(() => {
  vi.resetAllMocks();
  authMock.role = "admin";
  process.env.META_APP_ID = "app123";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.META_APP_ID;
});

describe("sample file checks", () => {
  it("maps the allowed types to a header format and refuses others", () => {
    expect(mediaTypeForMime("image/png; charset=binary")).toBe("IMAGE");
    expect(mediaTypeForMime("video/mp4")).toBe("VIDEO");
    expect(mediaTypeForMime("application/pdf")).toBe("DOCUMENT");
    expect(mediaTypeForMime("image/gif")).toBeNull();
    expect(MEDIA_RULES.IMAGE.maxBytes).toBe(5 * 1024 * 1024);
  });
  it("checks the first bytes match the claimed type", () => {
    expect(looksLike("image/png", png)).toBe(true);
    expect(looksLike("image/jpeg", jpeg)).toBe(true);
    expect(looksLike("application/pdf", pdf)).toBe(true);
    expect(looksLike("video/mp4", mp4)).toBe(true);
    expect(looksLike("image/png", jpeg)).toBe(false);
    expect(looksLike("image/gif", png)).toBe(false);
  });
  it("rejects wrong type, empty, oversized and disguised files", () => {
    expect(() => checkUpload({ bytes: png, mime: "image/gif", filename: "a.gif" })).toThrow(/JPG or PNG/);
    expect(() => checkUpload({ bytes: new Uint8Array(0), mime: "image/png", filename: "a.png" })).toThrow(/empty/);
    expect(() => checkUpload({ bytes: new Uint8Array(5 * 1024 * 1024 + 1).fill(1), mime: "image/png", filename: "a.png" })).toThrow(/too large/);
    expect(() => checkUpload({ bytes: pdf, mime: "image/png", filename: "a.png" })).toThrow(/does not look like/);
    expect(checkUpload({ bytes: png, mime: "image/png", filename: "../my photo.png" })).toEqual({ type: "IMAGE", mime: "image/png", filename: "my_photo.png" });
  });
  it("makes file names safe", () => {
    expect(safeFilename("../../etc/passwd")).toBe("etc_passwd");
    expect(safeFilename("")).toBe("sample");
  });
});

describe("resumable upload to Meta", () => {
  function stubFetch(replies: { ok?: boolean; status?: number; body: unknown }[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const r = replies.shift() ?? { ok: false, status: 500, body: {} };
        return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
      }),
    );
    return calls;
  }

  it("opens an upload session, sends the bytes and returns the handle", async () => {
    const calls = stubFetch([{ body: { id: "upload:abc" } }, { body: { h: "4::handle" } }]);
    const media = await uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "logo.png" });
    expect(media).toEqual({ type: "IMAGE", handle: "4::handle", mime: "image/png", filename: "logo.png" });
    expect(calls[0].url).toContain("/app123/uploads?");
    expect(calls[0].url).toContain("file_length=12");
    expect(calls[0].url).toContain("file_type=image%2Fpng");
    expect(calls[1].url).toMatch(/\/upload:abc$/);
    expect((calls[1].init.headers as Record<string, string>).file_offset).toBe("0");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("OAuth tok_secret");
  });
  it("adds appsecret_proof to both calls when META_APP_SECRET is set, and not otherwise", async () => {
    const proof = createHmac("sha256", "the-app-secret").update("tok_secret").digest("hex");
    process.env.META_APP_SECRET = "the-app-secret";
    try {
      const calls = stubFetch([{ body: { id: "upload:abc" } }, { body: { h: "4::handle" } }]);
      await uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "logo.png" });
      expect(new URL(calls[0].url).searchParams.get("appsecret_proof")).toBe(proof);
      expect(new URL(calls[1].url).searchParams.get("appsecret_proof")).toBe(proof);
      expect(calls[1].url).toContain("/upload:abc?appsecret_proof=");
    } finally {
      delete process.env.META_APP_SECRET;
    }
    const plain = stubFetch([{ body: { id: "upload:abc" } }, { body: { h: "4::handle" } }]);
    await uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "logo.png" });
    expect(plain[0].url).not.toContain("appsecret_proof");
    expect(plain[1].url).toMatch(/\/upload:abc$/);
  });
  it("does not leak Meta's error text and refuses when the app is not configured", async () => {
    stubFetch([{ ok: false, status: 400, body: { error: { message: "token tok_secret invalid" } } }]);
    const error = await uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "a.png" }).catch((e) => e);
    expect(error.message).not.toContain("tok_secret");
    expect(error.status).toBe(400);
    delete process.env.META_APP_ID;
    await expect(uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "a.png" })).rejects.toThrow(/not set up/);
  });
  it("treats a missing session id or handle as a Meta failure", async () => {
    stubFetch([{ body: {} }]);
    await expect(uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "a.png" })).rejects.toThrow(/Meta did not accept/);
    stubFetch([{ body: { id: "upload:abc" } }, { body: {} }]);
    await expect(uploadTemplateHeaderSample("t1", { bytes: png, mime: "image/png", filename: "a.png" })).rejects.toThrow(/Meta did not accept/);
  });
  it("reads a body only up to the limit", async () => {
    const req = (size: number) => new Request("https://wa.test/x", { method: "POST", body: new Uint8Array(size) });
    expect((await readBytesLimited(req(10), 100)).byteLength).toBe(10);
    await expect(readBytesLimited(req(200), 100)).rejects.toThrow(/too large/);
  });
});

describe("POST /api/templates/media", () => {
  const request = (bytes: Uint8Array, type = "image/png") =>
    new Request("https://wa.test/api/templates/media", { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent("logo.png") }, body: bytes as unknown as BodyInit });

  it("needs an admin", async () => {
    authMock.role = "agent";
    expect((await POST(request(png))).status).toBe(403);
  });
  it("uploads and audits without file content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "upload:1" }) })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ h: "4::h" }) }),
    );
    const res = await POST(request(png));
    expect(res.status).toBe(200);
    expect((await res.json()).media.handle).toBe("4::h");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "template.sample_uploaded", meta: { type: "IMAGE", bytes: 12 } }));
  });
  it("answers 400 for a file that is not what it claims", async () => {
    expect((await POST(request(pdf))).status).toBe(400);
  });
});

describe("template header media record", () => {
  it("derives the stored media from the validated components and the editor's hint", () => {
    const components = [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::h"] } }, { type: "BODY", text: "x" }];
    expect(headerMediaFrom(components, { headerMedia: { mime: "image/png; x=1", filename: "logo.png" } })).toEqual({ type: "IMAGE", handle: "4::h", mime: "image/png", filename: "logo.png" });
    expect(headerMediaFrom(components, { headerMedia: { mime: "application/pdf" } })).toEqual({ type: "IMAGE", handle: "4::h" });
    expect(headerMediaFrom([{ type: "BODY", text: "x" }], {})).toBeNull();
  });
  it("copies the sample with a duplicated template and names copies without clashing", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tpl1", name: "promo_copy", wabaRefId: "w1", language: "en", category: "MARKETING", components: [], headerMedia: { type: "IMAGE", handle: "4::h" } });
    db.template.findMany.mockResolvedValue([{ name: "promo" }, { name: "promo_copy" }, { name: "promo_copy2" }]);
    db.template.create.mockImplementation(async ({ data }: { data: object }) => data);
    const copy = (await duplicateTemplate(actor, "tpl1")) as unknown as { name: string; headerMedia: unknown };
    expect(copy.name).toBe("promo_copy3");
    expect(copy.headerMedia).toEqual({ type: "IMAGE", handle: "4::h" });
    expect(db.template.findFirst).toHaveBeenCalledWith({ where: { id: "tpl1", tenantId: "t1" } });
  });
});
