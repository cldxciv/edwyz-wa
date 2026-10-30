import { describe, expect, it } from "vitest";
import { documentName, documentTypeLabel, inboundMediaSrc, mediaCaption, mediaPreview } from "@/components/inbox/ux";

describe("inbound media in the inbox UI", () => {
  it("points Meta media at the tenant-checked proxy by message id", () => {
    expect(mediaPreview({ id: "cm123", type: "image", mediaUrl: "meta-media:999", mediaMime: "image/png" })).toEqual({ kind: "image", src: "/api/inbox/media/cm123", mime: "image/png" });
    expect(mediaPreview({ id: "cm123", type: "sticker", mediaUrl: "meta-media:999", mediaMime: "image/webp" })?.kind).toBe("image");
    expect(inboundMediaSrc("a b")).toBe("/api/inbox/media/a%20b");
  });

  it("never exposes the Meta media id and shows a tile without a message id or with a malformed reference", () => {
    const src = mediaPreview({ id: "cm123", type: "audio", mediaUrl: "meta-media:999", mediaMime: "audio/ogg" })?.src;
    expect(src).not.toContain("999");
    expect(mediaPreview({ type: "video", mediaUrl: "meta-media:123", mediaMime: "video/mp4" })?.src).toBeNull();
    expect(mediaPreview({ id: "cm123", type: "image", mediaUrl: "meta-media:../x", mediaMime: null })?.src).toBeNull();
    expect(mediaPreview({ id: "../x", type: "image", mediaUrl: "meta-media:1", mediaMime: null })?.src).toBeNull();
  });

  it("labels documents by name and type", () => {
    expect(documentName("[document: Invoice 42.pdf] please check")).toBe("Invoice 42.pdf");
    expect(documentName("[document]")).toBeNull();
    expect(documentName(null)).toBeNull();
    expect(documentTypeLabel("application/pdf")).toBe("PDF");
    expect(documentTypeLabel("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("Excel");
    expect(documentTypeLabel("application/x-unknown")).toBe("File");
    expect(documentTypeLabel(null)).toBe("File");
  });

  it("drops the stored media label and keeps the customer's caption", () => {
    expect(mediaCaption("[image]")).toBeNull();
    expect(mediaCaption("[image] my receipt")).toBe("my receipt");
    expect(mediaCaption("[document: a.pdf] contract")).toBe("contract");
    expect(mediaCaption("[document: a.pdf]")).toBeNull();
    expect(mediaCaption("plain text")).toBe("plain text");
    expect(mediaCaption(null)).toBeNull();
  });
});
