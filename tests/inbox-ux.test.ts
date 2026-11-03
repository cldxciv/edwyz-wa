import { describe, expect, it } from "vitest";
import { shortcutFor } from "@/components/inbox/helpers";
import {
  attributeRows,
  avatarColor,
  buildTimeline,
  clampListWidth,
  emojiMatches,
  emojiQuery,
  expandShortcodes,
  failureHint,
  formatAgo,
  formatBytes,
  highlightParts,
  initials,
  LIST_DEFAULT,
  LIST_MAX,
  LIST_MIN,
  mediaPreview,
  newInbound,
  parseReferral,
  parseSendKey,
  parseStoredWidth,
  previewText,
  readStore,
  scrollTopFor,
  slashMatches,
  validateAttachment,
  visibleRange,
  windowPercent,
  windowTone,
  wantsSend,
  writeStore,
  type ChatMessage,
  type NoteItem,
} from "@/components/inbox/ux";
import { bodyText, buildBodyComponents, checkVariables, cleanVariable, fillTemplate, inlineSendable, variableCount } from "@/lib/inbox/template-vars";

const msg = (id: string, direction: "inbound" | "outbound", iso: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, direction, type: "text", body: id, mediaUrl: null, mediaMime: null, templateName: null, status: "sent", errorCode: null, createdAt: iso, ...extra,
});

describe("avatars", () => {
  it("derives stable colours from the id", () => {
    expect(avatarColor("abc")).toEqual(avatarColor("abc"));
    expect(avatarColor("abc")).not.toEqual(avatarColor("abd"));
  });
  it("builds initials with fallbacks", () => {
    expect(initials("Asha Rao")).toBe("AR");
    expect(initials("  maria  de la cruz ")).toBe("MC");
    expect(initials("Single")).toBe("S");
    expect(initials(null, "+91 98765 43210")).toBe("10");
    expect(initials("", "")).toBe("#");
    expect(initials("+++", "123")).toBe("23");
  });
});

describe("windowed rendering", () => {
  it("renders only the visible rows plus overscan", () => {
    expect(visibleRange(0, 460, 92, 1000, 2)).toEqual({ start: 0, end: 7 });
    expect(visibleRange(9200, 460, 92, 1000, 2)).toEqual({ start: 98, end: 107 });
    expect(visibleRange(10 ** 9, 460, 92, 1000, 2).end).toBe(1000);
    expect(visibleRange(0, 460, 92, 0)).toEqual({ start: 0, end: 0 });
  });
  it("scrolls just enough to reveal a row", () => {
    expect(scrollTopFor(0, 500, 300, 100)).toBe(0);
    expect(scrollTopFor(9, 0, 300, 100)).toBe(700);
    expect(scrollTopFor(2, 100, 300, 100)).toBe(100);
  });
});

describe("search highlighting", () => {
  it("splits on every case-insensitive match", () => {
    expect(highlightParts("Ana Banana", "ana")).toEqual([
      { text: "Ana", match: true },
      { text: " B", match: false },
      { text: "ana", match: true },
      { text: "na", match: false },
    ]);
  });
  it("is safe with regex characters and empty queries", () => {
    expect(highlightParts("a.b (c)", "(c)")).toEqual([{ text: "a.b ", match: false }, { text: "(c)", match: true }]);
    expect(highlightParts("abc", "  ")).toEqual([{ text: "abc", match: false }]);
    expect(highlightParts("abc", "zzz")).toEqual([{ text: "abc", match: false }]);
  });
});

describe("list previews", () => {
  it("labels media and templates", () => {
    expect(previewText(undefined)).toBe("No messages yet");
    expect(previewText({ direction: "inbound", type: "text", body: "hi  there" })).toBe("hi there");
    expect(previewText({ direction: "outbound", type: "image", body: "look" })).toBe("You: Photo: look");
    expect(previewText({ direction: "inbound", type: "audio", body: null })).toBe("Voice message");
    expect(previewText({ direction: "outbound", type: "template", body: "[template] order_update" })).toBe("You: order_update");
    expect(previewText({ direction: "inbound", type: "image", body: "[image] look" })).toBe("Photo: look");
    expect(previewText({ direction: "inbound", type: "document", body: "[document: bill.pdf]" })).toBe("Document");
    expect(previewText({ direction: "inbound", type: "contacts", body: "[contacts] Ravi Kumar: +91 98765 43210" })).toBe("Contact card: Ravi Kumar: +91 98765 43210");
    expect(previewText({ direction: "inbound", type: "order", body: ["[order] 3 items, total 1598 INR", "2 x SKU-1 at 499 INR"].join("\n") })).toMatch(/^Order: 3 items, total 1598 INR/);
  });
});

describe("timeline", () => {
  const now = new Date(2026, 9, 27, 12, 0, 0);
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();

  it("separates days, groups close messages from one sender and flags the ends", () => {
    const days = buildTimeline(
      [msg("a", "inbound", at(26, 9, 0)), msg("b", "inbound", at(26, 9, 1)), msg("c", "outbound", at(26, 9, 2)), msg("d", "inbound", at(27, 8, 0)), msg("e", "inbound", at(27, 8, 30))],
      [],
      now,
    );
    expect(days.map((d) => d.label)).toEqual(["Yesterday", "Today"]);
    const [first, second] = days;
    expect(first.entries.map((e) => [e.id, e.first, e.last])).toEqual([["a", true, false], ["b", false, true], ["c", true, true]]);
    expect(second.entries.map((e) => [e.first, e.last])).toEqual([[true, true], [true, true]]);
  });

  it("interleaves notes by time and groups them by author", () => {
    const notes: NoteItem[] = [
      { id: "n1", authorId: "u1", body: "x", createdAt: at(27, 9, 1) },
      { id: "n2", authorId: "u1", body: "y", createdAt: at(27, 9, 2) },
      { id: "n3", authorId: "u2", body: "z", createdAt: at(27, 9, 3) },
    ];
    const [day] = buildTimeline([msg("a", "inbound", at(27, 9, 0)), msg("b", "outbound", at(27, 9, 5))], notes, now);
    expect(day.entries.map((e) => e.id)).toEqual(["a", "note:n1", "note:n2", "note:n3", "b"]);
    expect(day.entries.map((e) => e.first)).toEqual([true, true, false, true, true]);
  });

  it("announces only unseen inbound messages", () => {
    const list = [msg("a", "inbound", at(27, 9, 0)), msg("b", "outbound", at(27, 9, 1)), msg("c", "inbound", at(27, 9, 2), { body: "hello" })];
    expect(newInbound(new Set(["a", "b", "c"]), list)).toBeNull();
    expect(newInbound(new Set(["a", "b"]), list)).toEqual({ id: "c", text: "hello" });
  });
});

describe("media previews", () => {
  it("routes our own uploads through the tenant-checked URL", () => {
    const key = "a".repeat(32);
    expect(mediaPreview({ type: "image", mediaUrl: `https://wa.edwyz.com/api/content/media-public/t1/${key}.jpg?exp=1&sig=x`, mediaMime: "image/jpeg" })?.src).toBe(`/api/content/media/${key}.jpg`);
  });
  it("uses https links, and shows a tile for Meta media ids", () => {
    expect(mediaPreview({ type: "image", mediaUrl: "https://cdn.example.com/a.png", mediaMime: null })?.src).toBe("https://cdn.example.com/a.png");
    expect(mediaPreview({ type: "video", mediaUrl: "meta-media:123", mediaMime: "video/mp4" })).toEqual({ kind: "video", src: null, mime: "video/mp4" });
    expect(mediaPreview({ type: "image", mediaUrl: "javascript:alert(1)", mediaMime: null })?.src).toBeNull();
    expect(mediaPreview({ type: "text", mediaUrl: null, mediaMime: null })).toBeNull();
  });
  it("validates attachments against the WhatsApp limits", () => {
    expect(validateAttachment({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateAttachment({ type: "application/zip", size: 1000 })).toMatch(/WhatsApp accepts/);
    expect(validateAttachment({ type: "video/quicktime", size: 1000 })).toMatch(/MOV/);
    expect(validateAttachment({ type: "image/png", size: 6 * 1048576 })).toMatch(/Photos can be up to 5 MB/);
    expect(validateAttachment({ type: "video/mp4", size: 17 * 1048576 })).toMatch(/Videos can be up to 16 MB/);
    expect(validateAttachment({ type: "video/mp4", size: 16 * 1048576 })).toBeNull();
    expect(validateAttachment({ type: "application/pdf", size: 99 * 1048576 })).toBeNull();
    expect(validateAttachment({ type: "audio/ogg", size: 1000 })).toBeNull();
    expect(validateAttachment({ type: "video/mp4", size: 0 })).toMatch(/empty/);
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(5 * 1048576)).toBe("5 MB");
    expect(formatBytes(1.5 * 1048576)).toBe("1.5 MB");
  });
});

describe("failure hints and window", () => {
  it("explains known codes and falls back", () => {
    expect(failureHint("131047")).toMatch(/template/i);
    expect(failureHint("send_unconfirmed")).toMatch(/confirm/i);
    expect(failureHint("999")).toBe("The message could not be delivered.");
    expect(failureHint(null)).toBe("The message could not be delivered.");
  });
  it("explains the codes the app sets itself and the undocumented Meta codes seen in the field", () => {
    expect(failureHint("tenant_blocked")).toMatch(/suspended or read-only/);
    expect(failureHint("opted_out")).toMatch(/STOP/);
    expect(failureHint("131058")).toMatch(/does not document/);
    expect(failureHint("131058")).toMatch(/approved/);
    expect(failureHint("131054")).toMatch(/does not document/);
    for (const code of ["131000", "131005", "131008", "131009", "131016", "131021", "131031", "131037", "131042", "131045", "131052", "131057", "133010", "135000", "100", "368", "80007", "130472", "132000", "132012", "131050", "130429", "130497", "132005"]) {
      expect(failureHint(code), code).not.toBe("The message could not be delivered.");
    }
    expect(failureHint("131021")).toMatch(/business number itself/);
    expect(failureHint("133010")).toMatch(/not registered/);
  });
  it("classifies the window", () => {
    expect(windowTone(0)).toBe("closed");
    expect(windowTone(3600_000)).toBe("soon");
    expect(windowTone(5 * 3600_000)).toBe("ok");
    expect(windowPercent(12 * 3600_000)).toBe(50);
    expect(windowPercent(-5)).toBe(0);
    expect(formatAgo(30_000)).toBe("just now");
    expect(formatAgo(5 * 60_000)).toBe("5 min ago");
    expect(formatAgo(3 * 3600_000)).toBe("3 h ago");
    expect(formatAgo(72 * 3600_000)).toBe("3 days ago");
  });
});

describe("send key", () => {
  const enter = { key: "Enter" };
  it("Enter sends by default and Shift+Enter does not", () => {
    expect(wantsSend(enter, "enter")).toBe(true);
    expect(wantsSend({ ...enter, shiftKey: true }, "enter")).toBe(false);
  });
  it("Ctrl or Cmd+Enter always sends, plain Enter does not in that mode", () => {
    expect(wantsSend(enter, "mod-enter")).toBe(false);
    expect(wantsSend({ ...enter, ctrlKey: true }, "mod-enter")).toBe(true);
    expect(wantsSend({ ...enter, metaKey: true }, "enter")).toBe(true);
  });
  it("ignores IME composition and other keys", () => {
    expect(wantsSend({ ...enter, isComposing: true }, "enter")).toBe(false);
    expect(wantsSend({ key: "a" }, "enter")).toBe(false);
  });
  it("parses the stored preference", () => {
    expect(parseSendKey("mod-enter")).toBe("mod-enter");
    expect(parseSendKey("junk")).toBe("enter");
    expect(parseSendKey(null)).toBe("enter");
  });
});

describe("emoji shortcodes", () => {
  it("expands complete known codes only", () => {
    expect(expandShortcodes("hi :smile: there")).toBe("hi \u{1F604} there");
    expect(expandShortcodes(":wave:")).toBe("\u{1F44B}");
    expect(expandShortcodes("see :nope: and http://x:80:")).toBe("see :nope: and http://x:80:");
    expect(expandShortcodes("ratio 3:4:5")).toBe("ratio 3:4:5");
  });
  it("finds the unfinished code before the caret", () => {
    expect(emojiQuery("hello :sm", 9)).toEqual({ query: "sm", start: 6 });
    expect(emojiQuery(":s", 2)).toBeNull();
    expect(emojiQuery("a:smi", 5)).toBeNull();
    expect(emojiMatches("thumb").map((m) => m.name)).toEqual(["thumbsup", "thumbsdown"]);
  });
});

describe("slash menu", () => {
  const replies = [
    { id: "1", shortcut: "hours", body: "We open at 9" },
    { id: "2", shortcut: "thanks", body: "Thank you" },
    { id: "3", shortcut: "shipping-hours", body: "Ships daily" },
  ];
  const templates = [{ id: "t1", name: "order_update" }, { id: "t2", name: "hours_reminder" }];
  it("lists everything for a bare slash, prefix matches first", () => {
    expect(slashMatches("", replies, templates)).toHaveLength(5);
    expect(slashMatches("hours", replies, templates).map((i) => i.id)).toEqual(["1", "3", "t2"]);
  });
  it("matches templates by name and caps the list", () => {
    expect(slashMatches("order", replies, templates).map((i) => i.kind)).toEqual(["template"]);
    expect(slashMatches("", replies, templates, 2)).toHaveLength(2);
  });
});

describe("panel data", () => {
  it("keeps only https ad links and drops empty referrals", () => {
    expect(parseReferral({ sourceType: "ad", sourceId: "123", sourceUrl: "https://fb.com/ad", headline: "Sale", ctwaClid: "secret" })).toEqual({ headline: "Sale", sourceType: "ad", sourceId: "123", sourceUrl: "https://fb.com/ad" });
    expect(parseReferral({ sourceUrl: "javascript:alert(1)", headline: "x" })?.sourceUrl).toBeNull();
    expect(parseReferral({ sourceUrl: "http://insecure" })).toBeNull();
    expect(parseReferral(null)).toBeNull();
    expect(parseReferral([])).toBeNull();
  });
  it("lists scalar attributes only", () => {
    expect(attributeRows({ city: "Pune", age: 31, vip: true, nested: { a: 1 }, empty: " ", list: [1] })).toEqual([
      { key: "city", value: "Pune" },
      { key: "age", value: "31" },
      { key: "vip", value: "true" },
    ]);
    expect(attributeRows(null)).toEqual([]);
  });
});

describe("list width and storage", () => {
  it("clamps and parses the stored width", () => {
    expect(clampListWidth(10)).toBe(LIST_MIN);
    expect(clampListWidth(9999)).toBe(LIST_MAX);
    expect(clampListWidth(Number.NaN)).toBe(LIST_DEFAULT);
    expect(parseStoredWidth(null)).toBe(LIST_DEFAULT);
    expect(parseStoredWidth("")).toBe(LIST_DEFAULT);
    expect(parseStoredWidth("400")).toBe(400);
    expect(parseStoredWidth("abc")).toBe(LIST_DEFAULT);
  });
  it("never throws when storage is unavailable", () => {
    expect(readStore("k")).toBeNull();
    expect(() => writeStore("k", "v")).not.toThrow();
  });
});

describe("shortcuts", () => {
  it("maps the documented keys", () => {
    expect(shortcutFor({ key: "a" })).toBe("assign");
    expect(shortcutFor({ key: "/" })).toBe("composer");
    expect(shortcutFor({ key: "j" })).toBe("next");
    expect(shortcutFor({ key: "?" })).toBe("help");
    expect(shortcutFor({ key: "Enter", targetTag: "BODY" })).toBe("enter");
  });
  it("stays out of the way while typing or on buttons", () => {
    expect(shortcutFor({ key: "a", targetTag: "TEXTAREA" })).toBeNull();
    expect(shortcutFor({ key: "/", editable: true })).toBeNull();
    expect(shortcutFor({ key: "Enter", targetTag: "BUTTON" })).toBeNull();
    expect(shortcutFor({ key: "Enter", targetTag: "A" })).toBeNull();
    expect(shortcutFor({ key: "e", metaKey: true })).toBeNull();
  });
});

describe("template variables", () => {
  const components = [
    { type: "HEADER", format: "TEXT", text: "Hi" },
    { type: "BODY", text: "Hello {{1}}, order {{2}} ships {{2}}." },
    { type: "FOOTER", text: "Edwyz" },
  ];
  it("reads the body and counts distinct variables", () => {
    expect(bodyText(components)).toBe("Hello {{1}}, order {{2}} ships {{2}}.");
    expect(variableCount(bodyText(components))).toBe(2);
    expect(variableCount("none")).toBe(0);
    expect(bodyText(null)).toBe("");
  });
  it("fills values and leaves gaps visible", () => {
    expect(fillTemplate("Hi {{1}} {{2}}", ["Asha"])).toBe("Hi Asha {{2}}");
    expect(fillTemplate("Hi {{1}}", ["  "])).toBe("Hi {{1}}");
  });
  it("only allows what the inline picker can fill", () => {
    expect(inlineSendable(components)).toEqual({ ok: true, variables: 2 });
    expect(inlineSendable([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }]).ok).toBe(false);
    expect(inlineSendable([{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "x" }]).ok).toBe(false);
    expect(inlineSendable([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.com/{{1}}" }] }]).ok).toBe(false);
    expect(inlineSendable([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.com" }] }]).ok).toBe(true);
  });
  it("cleans and checks values", () => {
    expect(cleanVariable("a\nb\t c     d")).toBe("a b c d");
    expect(checkVariables(["Asha", "42"], 2)).toEqual({ ok: true, values: ["Asha", "42"] });
    expect(checkVariables(undefined, 0)).toEqual({ ok: true, values: [] });
    expect(checkVariables(["a"], 2).ok).toBe(false);
    expect(checkVariables(["a", " "], 2)).toEqual({ ok: false, error: "Fill in value 2." });
    expect(checkVariables([1], 1).ok).toBe(false);
    expect(checkVariables(["x".repeat(2000)], 1).ok).toBe(false);
    expect(buildBodyComponents([])).toEqual([]);
    expect(buildBodyComponents(["a"])).toEqual([{ type: "body", parameters: [{ type: "text", text: "a" }] }]);
  });
});
