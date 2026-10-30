import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Bubble } from "@/components/inbox/MessageBubble";
import { downloadFileName, loadMediaBlob, type ChatMessage } from "@/components/inbox/ux";

const base = { direction: "inbound", status: "received", createdAt: "2026-10-27T10:00:00Z", body: "" } as const;
const render = (m: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(Bubble as never, { m: { ...base, ...m } as ChatMessage, first: true, last: true, templates: [], onOpenMedia: () => undefined, onRetry: () => undefined, onDiscard: () => undefined } as never),
  );

describe("MessageBubble inbound media", () => {
  it("renders a lazy image tile that points at the proxy and never at Meta", () => {
    const html = render({ id: "cm1", type: "image", mediaUrl: "meta-media:98765", mediaMime: "image/jpeg" });
    expect(html).toContain('src="/api/inbox/media/cm1"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('aria-label="Open photo"');
    expect(html).not.toContain("98765");
  });

  it("renders native controls for audio and video", () => {
    const audio = render({ id: "cm2", type: "audio", mediaUrl: "meta-media:1", mediaMime: "audio/ogg" });
    expect(audio).toMatch(/<audio[^>]*controls/);
    expect(audio).toContain('src="/api/inbox/media/cm2"');
    const video = render({ id: "cm3", type: "video", mediaUrl: "meta-media:2", mediaMime: "video/mp4" });
    expect(video).toMatch(/<video[^>]*controls/);
  });

  it("renders a document as a button with its name and type, not as a bare download link", () => {
    const html = render({ id: "cm4", type: "document", body: "[document: Invoice 42.pdf] please check", mediaUrl: "meta-media:3", mediaMime: "application/pdf" });
    expect(html).toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("download=");
    expect(html).toContain("Invoice 42.pdf");
    expect(html).toContain("PDF");
  });
});

describe("document download", () => {
  const res = (body: string, status: number) => new Response(body, { status });

  it("returns the file only for a successful response, never a JSON error body", async () => {
    const ok = vi.fn(async () => res("%PDF-1.4", 200)) as unknown as typeof fetch;
    expect(await (await loadMediaBlob("/api/inbox/media/cm4", ok))?.text()).toBe("%PDF-1.4");
    expect(ok).toHaveBeenCalledWith("/api/inbox/media/cm4", { credentials: "same-origin" });
    for (const status of [404, 413, 429, 502]) {
      const bad = vi.fn(async () => res('{"error":"This file could not be loaded."}', status)) as unknown as typeof fetch;
      expect(await loadMediaBlob("/api/inbox/media/cm4", bad), String(status)).toBeNull();
    }
    expect(await loadMediaBlob("/x", (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBeNull();
  });

  it("uses the reported name as the saved name, made safe", () => {
    expect(downloadFileName("Invoice 42.pdf")).toBe("Invoice 42.pdf");
    expect(downloadFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(downloadFileName(["a", "b:c*", '"d.pdf'].join(String.fromCharCode(92)))).toBe("a_b_c_d.pdf");
    expect(downloadFileName(null)).toBe("document");
    expect(downloadFileName("..")).toBe("document");
    expect(downloadFileName("x".repeat(400)).length).toBe(150);
  });
});
