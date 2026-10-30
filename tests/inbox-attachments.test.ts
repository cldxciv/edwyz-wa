import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ conversation: { findFirst: vi.fn() } }));
const graph = vi.hoisted(() => ({ graphUpload: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/graph", () => {
  class GraphError extends Error {
    constructor(message: string, public status: number, public code?: number, public subcode?: number, public retryable = false, public ambiguous = false) {
      super(message);
    }
  }
  return { GraphError, graphUpload: graph.graphUpload };
});

import { GraphError } from "@/lib/graph";
import {
  ATTACHMENT_LIMITS,
  attachmentProblem,
  classifyAttachment,
  matchesSignature,
  safeFileName,
  stickerLimit,
} from "@/lib/inbox/attachments";
import { uploadAttachmentToMeta } from "@/lib/inbox/upload";
import { buildSendBody } from "@/lib/inbox/send";

const MB = 1048576;
const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(Math.max(16 - head.length, 0)).fill(0)]);

describe("WhatsApp attachment rules", () => {
  it("classifies mime types into the WhatsApp kinds with their limits", () => {
    expect(classifyAttachment("image/jpeg")).toMatchObject({ kind: "image", maxBytes: 5 * MB });
    expect(classifyAttachment("IMAGE/PNG; charset=x")).toMatchObject({ kind: "image" });
    expect(classifyAttachment("video/mp4")).toMatchObject({ kind: "video", maxBytes: 16 * MB });
    expect(classifyAttachment("audio/ogg; codecs=opus")).toMatchObject({ kind: "audio", mime: "audio/ogg", maxBytes: 16 * MB });
    expect(classifyAttachment("application/pdf")).toMatchObject({ kind: "document", maxBytes: 100 * MB });
    expect(classifyAttachment("image/webp")).toMatchObject({ kind: "sticker" });
  });

  it("refuses what WhatsApp does not accept: MOV, GIF, zip, scripts", () => {
    for (const type of ["video/quicktime", "image/gif", "application/zip", "text/html", "application/x-msdownload", ""]) expect(classifyAttachment(type)).toBeNull();
    expect(attachmentProblem({ type: "video/quicktime", size: 10 })).toMatch(/MOV/);
    expect(attachmentProblem({ type: "application/zip", size: 10 })).toMatch(/WhatsApp accepts/);
  });

  it("enforces the size limit per kind, in plain words", () => {
    expect(attachmentProblem({ type: "image/jpeg", size: 5 * MB })).toBeNull();
    expect(attachmentProblem({ type: "image/jpeg", size: 5 * MB + 1 })).toMatch(/Photos can be up to 5 MB/);
    expect(attachmentProblem({ type: "video/mp4", size: 16 * MB + 1 })).toMatch(/Videos can be up to 16 MB/);
    expect(attachmentProblem({ type: "audio/mpeg", size: 17 * MB })).toMatch(/Audio files can be up to 16 MB/);
    expect(attachmentProblem({ type: "application/pdf", size: 100 * MB })).toBeNull();
    expect(attachmentProblem({ type: "application/pdf", size: 100 * MB + 1 })).toMatch(/Documents can be up to 100 MB/);
    expect(attachmentProblem({ type: "image/jpeg", size: 0 })).toMatch(/empty/);
  });

  it("gives static stickers 100 KB and animated ones 500 KB", () => {
    const stat = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    const anim = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8XANIM");
    expect(stickerLimit(stat)).toBe(ATTACHMENT_LIMITS.stickerStatic);
    expect(stickerLimit(anim)).toBe(ATTACHMENT_LIMITS.stickerAnimated);
  });

  it("checks that the first bytes belong to the declared type", () => {
    expect(matchesSignature("image/jpeg", bytes(0xff, 0xd8, 0xff))).toBe(true);
    expect(matchesSignature("image/jpeg", bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false);
    expect(matchesSignature("application/pdf", new TextEncoder().encode("%PDF-1.7 more bytes"))).toBe(true);
    expect(matchesSignature("application/pdf", new TextEncoder().encode("MZ executable bytes"))).toBe(false);
    expect(matchesSignature("audio/ogg", new TextEncoder().encode("OggS\0\0\0\0\0\0\0\0\0\0"))).toBe(true);
    expect(matchesSignature("application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes(0x50, 0x4b, 3, 4))).toBe(true);
    expect(matchesSignature("text/plain", new TextEncoder().encode("hi"))).toBe(true);
    expect(matchesSignature("text/plain", new Uint8Array())).toBe(false);
  });

  it("cleans file names", () => {
    expect(safeFileName("../etc/passwd")).toBe(".._etc_passwd");
    expect(safeFileName("quote \"x\".pdf")).toBe("quote _x_.pdf");
    expect(safeFileName("  ")).toBe("file");
    expect(safeFileName("a".repeat(300))).toHaveLength(100);
  });
});

describe("outbound document, audio and sticker bodies", () => {
  const row = (type: string, mediaUrl: string, body: string | null = null) => ({ type, body, mediaUrl, mediaMime: null });

  it("addresses an uploaded file by its Meta media id and sends the file name for documents", () => {
    expect(buildSendBody("+919876543210", row("document", "meta-media:55", "the invoice"), { filename: "invoice.pdf" })).toMatchObject({
      type: "document",
      document: { id: "55", caption: "the invoice", filename: "invoice.pdf" },
    });
  });

  it("never sends a caption with audio or stickers", () => {
    expect((buildSendBody("+91", row("audio", "meta-media:1", "ignored"), {}) as Record<string, unknown>).audio).toEqual({ id: "1" });
    expect((buildSendBody("+91", row("sticker", "meta-media:2", "ignored"), {}) as Record<string, unknown>).sticker).toEqual({ id: "2" });
  });
});

describe("uploadAttachmentToMeta", () => {
  const req = (body: Uint8Array | string, headers: Record<string, string>) => new Request("https://wa.edwyz.com/x", { method: "POST", headers, body: body as unknown as BodyInit });
  const pdf = new TextEncoder().encode("%PDF-1.7 hello world, this is a document");

  beforeEach(() => {
    vi.clearAllMocks();
    db.conversation.findFirst.mockResolvedValue({ phoneNumber: { phoneNumberId: "meta_phone_1" } });
    graph.graphUpload.mockResolvedValue({ id: "999" });
  });

  it("uploads to the conversation's own number with the tenant token and returns the media id", async () => {
    const out = await uploadAttachmentToMeta("t1", "c1", req(pdf, { "content-type": "application/pdf", "content-length": String(pdf.length), "x-file-name": encodeURIComponent("My Invoice.pdf") }));
    expect(out).toEqual({ mediaId: "999", kind: "document", mime: "application/pdf", bytes: pdf.length, filename: "My Invoice.pdf" });
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
    expect(graph.graphUpload).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", path: "meta_phone_1/media", fields: { messaging_product: "whatsapp", type: "application/pdf" }, file: expect.objectContaining({ filename: "My Invoice.pdf", mime: "application/pdf" }) }),
    );
  });

  it("404s for a conversation of another workspace and uploads nothing", async () => {
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(uploadAttachmentToMeta("t1", "foreign", req(pdf, { "content-type": "application/pdf" }))).rejects.toMatchObject({ status: 404 });
    expect(graph.graphUpload).not.toHaveBeenCalled();
  });

  it("refuses unsupported types with 415 and a MOV with a specific message", async () => {
    await expect(uploadAttachmentToMeta("t1", "c1", req("x", { "content-type": "application/zip" }))).rejects.toMatchObject({ status: 415 });
    await expect(uploadAttachmentToMeta("t1", "c1", req("x", { "content-type": "video/quicktime" }))).rejects.toMatchObject({ status: 415, message: expect.stringMatching(/MOV/) });
    expect(graph.graphUpload).not.toHaveBeenCalled();
  });

  it("refuses a declared size over the limit before reading the body", async () => {
    await expect(uploadAttachmentToMeta("t1", "c1", req(pdf, { "content-type": "audio/mpeg", "content-length": String(17 * MB) }))).rejects.toMatchObject({ status: 413 });
    expect(graph.graphUpload).not.toHaveBeenCalled();
  });

  it("stops reading a body that grows past the limit when no size was declared", async () => {
    const big = new Uint8Array(ATTACHMENT_LIMITS.stickerAnimated + 10);
    big.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "));
    // Sticker limit applies after the read: static stickers are 100 KB.
    await expect(uploadAttachmentToMeta("t1", "c1", req(big.subarray(0, ATTACHMENT_LIMITS.stickerStatic + 5), { "content-type": "image/webp" }))).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/Stickers can be up to 100 KB/) });
    expect(graph.graphUpload).not.toHaveBeenCalled();
  });

  it("rejects content that does not match the declared type", async () => {
    await expect(uploadAttachmentToMeta("t1", "c1", req("MZ this is not a pdf at all", { "content-type": "application/pdf" }))).rejects.toMatchObject({ status: 400 });
    expect(graph.graphUpload).not.toHaveBeenCalled();
  });

  it("maps Meta rejections and outages to plain errors without leaking details", async () => {
    graph.graphUpload.mockRejectedValueOnce(new GraphError("(#100) secret details", 400, 100));
    const rejected = await uploadAttachmentToMeta("t1", "c1", req(pdf, { "content-type": "application/pdf" })).catch((e) => e);
    expect(rejected).toMatchObject({ status: 422 });
    expect(rejected.message).not.toMatch(/secret/);
    graph.graphUpload.mockRejectedValueOnce(new GraphError("boom", 0, undefined, undefined, false, true));
    await expect(uploadAttachmentToMeta("t1", "c1", req(pdf, { "content-type": "application/pdf" }))).rejects.toMatchObject({ status: 502 });
    graph.graphUpload.mockResolvedValueOnce({});
    await expect(uploadAttachmentToMeta("t1", "c1", req(pdf, { "content-type": "application/pdf" }))).rejects.toMatchObject({ status: 502 });
  });
});
