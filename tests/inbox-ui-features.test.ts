import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, type ComposerProps } from "@/components/inbox/Composer";
import { FILTER_KEYS, FILTER_TABS, filterToQuery } from "@/components/inbox/helpers";
import { Bubble, NoteBubble, UnreadLine } from "@/components/inbox/MessageBubble";
import { SavedViews } from "@/components/inbox/SavedViews";
import { mediaPreview, templatesForWaba, validateAttachment, wabaOf, type ChatMessage } from "@/components/inbox/ux";
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

  it("shows photos and videos, now sent by WhatsApp media id, through the proxy, and still shows older media-library links", () => {
    expect(mediaPreview({ id: "m5", type: "image", mediaUrl: "meta-media:8", mediaMime: "image/jpeg" })?.src).toBe("/api/inbox/media/m5");
    expect(mediaPreview({ id: "m6", type: "video", mediaUrl: "meta-media:9", mediaMime: "video/mp4" })?.src).toBe("/api/inbox/media/m6");
    const key = `${"b".repeat(32)}.jpg`;
    expect(mediaPreview({ id: "m7", type: "image", mediaUrl: `https://wa.edwyz.com/api/content/media-public/t1/${key}?sig=x`, mediaMime: "image/jpeg" })?.src).toBe(`/api/content/media/${key}`);
  });
});

describe("templates a chat can send", () => {
  const t = (id: string, wabaRefId?: string) => ({ id, name: id, language: "en", category: "UTILITY", status: "approved", components: [], ...(wabaRefId ? { wabaRefId } : {}) });

  it("offers only the templates of the number's own WhatsApp Business Account", () => {
    const all = [t("a1", "waba_a"), t("b1", "waba_b"), t("a2", "waba_a")];
    expect(templatesForWaba(all, "waba_a")?.map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(templatesForWaba(all, "waba_c")).toEqual([]);
  });

  it("hides nothing while the account is unknown, and keeps the loading state", () => {
    const all = [t("a1", "waba_a"), t("x")];
    expect(templatesForWaba(all, null)).toBe(all);
    expect(templatesForWaba(null, "waba_a")).toBeNull();
    expect(templatesForWaba(all, "waba_b")?.map((x) => x.id)).toEqual(["x"]);
  });

  it("reads the account from an API row only when it is a plain id", () => {
    expect(wabaOf({ displayPhone: "+91 1", wabaRefId: "waba_a" })).toBe("waba_a");
    expect(wabaOf({ displayPhone: "+91 1" })).toBeNull();
    expect(wabaOf({ wabaRefId: "" })).toBeNull();
    expect(wabaOf({ wabaRefId: 5 })).toBeNull();
    expect(wabaOf(undefined)).toBeNull();
    expect(wabaOf(null)).toBeNull();
  });

  it("both the chat and the new-chat dialog pass the filtered list to the picker", () => {
    const read = (f: string) => readFileSync(path.resolve(__dirname, "../src/components/inbox", f), "utf8");
    expect(read("ChatView.tsx")).toMatch(/templates=\{chatTemplates\}/);
    expect(read("ChatView.tsx")).toMatch(/templatesForWaba\(templates, numberWaba\)/);
    expect(read("NewChatDialog.tsx")).toMatch(/templates=\{sendable\}/);
  });
});

describe("composer while the chat loads", () => {
  const props = (windowOpen: boolean | null, extra: Partial<ComposerProps> = {}): ComposerProps => ({
    conversationId: "cv1",
    windowOpen,
    remainingMs: windowOpen ? 5 * 3_600_000 : 0,
    lastInboundAt: null,
    now: new Date("2026-10-30T10:00:00Z"),
    disabled: windowOpen === null,
    contactName: "Asha",
    contactPhone: "+919876543210",
    agentName: "Priya",
    members: [],
    templates: null,
    templatesError: null,
    onReloadTemplates: () => undefined,
    onSendText: () => undefined,
    onSendMedia: async () => undefined,
    onSendTemplate: async () => undefined,
    onAddNote: () => undefined,
    restore: null,
    ...extra,
  });
  const html = (p: ComposerProps) => renderToStaticMarkup(createElement(Composer, p));

  it("does not claim the window is closed before it knows: no template-only notice, no picker, the box stays in place but disabled", () => {
    const out = html(props(null));
    expect(out).not.toContain("Template-only mode");
    expect(out).not.toContain("Internal note</button>.");
    expect(out).not.toContain("Loading templates");
    expect(out).toMatch(/<textarea[^>]*id="inbox-composer"[^>]*disabled=""/);
    expect(out).toContain("ui-skeleton");
  });

  it("shows template-only mode once the chat says the window is closed", () => {
    const out = html(props(false));
    expect(out).toContain("Template-only mode");
    expect(out).toContain("Loading templates");
    expect(out).toContain("Internal note</button>.");
    expect(out).not.toContain('id="inbox-composer"');
  });

  it("shows the open window and an enabled box once the chat says it is open, even if the parent forgot to disable it while loading", () => {
    const open = html(props(true));
    expect(open).toContain("Reply window open");
    expect(open).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html(props(null, { disabled: false }))).toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe("empty inbox", () => {
  it("sends 'Connect a number' to the connect page, which exists, not to /app/settings, which has no page", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/inbox/ConversationList.tsx"), "utf8");
    expect(src).toContain('href="/app/settings/connect">Connect a number</a>');
    expect(src).not.toContain('href="/app/settings">');
    expect(readFileSync(path.resolve(__dirname, "../src/app/(app)/app/settings/connect/page.tsx"), "utf8")).toBeTruthy();
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
