import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FILTER_KEYS, FILTER_TABS, filterToQuery } from "@/components/inbox/helpers";
import { Bubble, NoteBubble, UnreadLine } from "@/components/inbox/MessageBubble";
import { SavedViews } from "@/components/inbox/SavedViews";
import { mediaPreview, validateAttachment, type ChatMessage } from "@/components/inbox/ux";
import { SAVED_TABS } from "@/lib/inbox/filters";
import { isInboxView } from "@/lib/inbox/list";

const members = [
  { userId: "u1", name: "Priya Shah", email: "p@x.com", role: "agent" },
  { userId: "u2", name: "Anil", email: "a@x.com", role: "admin" },
];

describe("inbox tabs", () => {
  it("offers every view the server understands, once each, with plain labels", () => {
    expect(new Set(FILTER_KEYS).size).toBe(FILTER_KEYS.length);
    for (const key of FILTER_KEYS) expect(SAVED_TABS as readonly string[]).toContain(key);
    for (const tab of FILTER_TABS) expect(tab.label).toMatch(/^[A-Z][a-z]+$/);
  });

  it("maps the new tabs to list parameters the API accepts", () => {
    for (const key of ["new", "favorite", "campaign", "mentioned", "active"] as const) {
      expect(filterToQuery(key)).toEqual({ view: key });
      expect(isInboxView(key)).toBe(true);
    }
    expect(filterToQuery("blocked")).toEqual({ status: "blocked" });
    expect(filterToQuery("expired")).toEqual({ expired: "1" });
    expect(filterToQuery("all")).toEqual({});
  });

  it("explains the derived tabs in a tooltip", () => {
    for (const key of ["new", "expired", "campaign", "mentioned", "active"]) expect(FILTER_TABS.find((t) => t.key === key)?.hint).toBeTruthy();
  });
});

describe("unread line and mentions", () => {
  it("renders a labelled separator for the unread line", () => {
    const html = renderToStaticMarkup(createElement(UnreadLine));
    expect(html).toContain('role="separator"');
    expect(html).toContain("Unread messages");
  });

  it("highlights the teammates mentioned in a note and leaves the rest as plain text", () => {
    const note = { id: "n1", authorId: "u2", body: "Please call @Priya Shah today", createdAt: "2026-10-27T10:00:00Z" };
    const html = renderToStaticMarkup(createElement(NoteBubble as never, { note, author: "Anil", first: true, last: true, onUndo: () => undefined, members } as never));
    expect(html).toContain("<strong");
    expect(html).toContain("@Priya Shah");
    expect(html).toContain("Please call ");
    expect(html).toContain("Internal note");
  });

  it("renders a note without any members as plain text", () => {
    const note = { id: "n1", authorId: "u2", body: "no mentions", createdAt: "2026-10-27T10:00:00Z" };
    const html = renderToStaticMarkup(createElement(NoteBubble as never, { note, author: "Anil", first: true, last: true, onUndo: () => undefined } as never));
    expect(html).not.toContain("<strong");
    expect(html).toContain("no mentions");
  });
});

describe("sent attachments in the thread", () => {
  const out = (m: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(Bubble as never, {
        m: { direction: "outbound", status: "sent", createdAt: "2026-10-27T10:00:00Z", body: null, ...m } as ChatMessage,
        first: true,
        last: true,
        templates: [],
        onOpenMedia: () => undefined,
        onRetry: () => undefined,
        onDiscard: () => undefined,
      } as never),
    );

  it("shows a sent sticker as a picture through the media proxy and never exposes the Meta id", () => {
    const html = out({ id: "m1", type: "sticker", mediaUrl: "meta-media:424242", mediaMime: "image/webp" });
    expect(html).toContain('src="/api/inbox/media/m1"');
    expect(html).not.toContain("424242");
  });

  it("shows sent audio with player controls and a sent document as a download button", () => {
    expect(out({ id: "m2", type: "audio", mediaUrl: "meta-media:5", mediaMime: "audio/ogg" })).toMatch(/<audio[^>]*controls/);
    const doc = out({ id: "m3", type: "document", mediaUrl: "meta-media:6", mediaMime: "application/pdf", body: "the invoice" });
    expect(doc).toContain("<button");
    expect(doc).toContain("PDF");
    expect(doc).toContain("the invoice");
  });

  it("previews uploaded files only through the tenant-checked proxy", () => {
    expect(mediaPreview({ id: "m4", type: "document", mediaUrl: "meta-media:7", mediaMime: "application/pdf" })?.src).toBe("/api/inbox/media/m4");
  });
});

describe("file picker rules", () => {
  it("accepts documents and audio now, with the WhatsApp limits", () => {
    expect(validateAttachment({ type: "application/pdf", size: 20 * 1048576 })).toBeNull();
    expect(validateAttachment({ type: "audio/mpeg", size: 1000 })).toBeNull();
    expect(validateAttachment({ type: "image/webp", size: 50 * 1024 })).toBeNull();
    expect(validateAttachment({ type: "video/quicktime", size: 1000 })).toMatch(/MOV/);
  });
});

describe("SavedViews", () => {
  it("offers to save a filtered view and stays out of the way on the plain list", () => {
    const filtered = renderToStaticMarkup(createElement(SavedViews, { current: { tab: "new" }, canShare: false, onApply: () => undefined }));
    expect(filtered).toContain("Save view");
    const plain = renderToStaticMarkup(createElement(SavedViews, { current: { tab: "all" }, canShare: false, onApply: () => undefined }));
    expect(plain).toBe("");
  });
});
