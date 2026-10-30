import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), updateMany: vi.fn() },
  message: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
const graph = vi.hoisted(() => ({
  graphFetch: vi.fn(),
  GraphError: class GraphError extends Error {
    retryable = false;
    ambiguous = false;
    status = 400;
    code: number | undefined;
  },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/graph", () => graph);
vi.mock("@/lib/integrations/events", () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
// The spend send gate (docs/SPEND-CONTROLS-SPEC.md 4.9) is covered by spend-messaging.test.ts and inbox-send.test.ts; here it lets the send through.
vi.mock("@/lib/spend/messaging/gate", () => ({ messagingGate: async () => ({ action: "send", overLimit: false, spend: {}, run: (fn: () => unknown) => fn() }), finishSend: async () => undefined }));

import {
  INTERACTIVE_LIMITS,
  buildList,
  buildReplyButtons,
  describeInteractive,
  normalizeInteractive,
  parseInteractiveReply,
  sendInteractive,
} from "@/lib/inbox/interactive";
import { buildSendBody, processSendJob } from "@/lib/inbox/send";
import { describeMessage } from "@/lib/webhooks/payload";

const titles = (n: number, prefix = "Option") => Array.from({ length: n }, (_, i) => ({ id: `id${i + 1}`, title: `${prefix} ${i + 1}` }));

describe("reply buttons", () => {
  it("builds the Cloud API payload with header, body, footer and up to three buttons", () => {
    const payload = buildReplyButtons({ body: "Pick one", header: "Menu", footer: "Reply any time", buttons: titles(3) });
    expect(payload).toEqual({
      type: "button",
      header: { type: "text", text: "Menu" },
      body: { text: "Pick one" },
      footer: { text: "Reply any time" },
      action: { buttons: titles(3).map((b) => ({ type: "reply", reply: b })) },
    });
  });

  it("rejects more than 3 buttons, none, long or empty titles, duplicate titles and duplicate ids", () => {
    const base = { body: "Pick" };
    expect(() => buildReplyButtons({ ...base, buttons: titles(4) })).toThrow(/between 1 and 3/);
    expect(() => buildReplyButtons({ ...base, buttons: [] })).toThrow(/between 1 and 3/);
    expect(() => buildReplyButtons({ ...base, buttons: [{ id: "a", title: "x".repeat(INTERACTIVE_LIMITS.buttonTitle + 1) }] })).toThrow(/at most 20/);
    expect(() => buildReplyButtons({ ...base, buttons: [{ id: "a", title: "  " }] })).toThrow(/required/);
    expect(() => buildReplyButtons({ ...base, buttons: [{ id: "a", title: "Same" }, { id: "b", title: "same" }] })).toThrow(/share the title/);
    expect(() => buildReplyButtons({ ...base, buttons: [{ id: "a", title: "One" }, { id: "a", title: "Two" }] })).toThrow(/share the id/);
    expect(() => buildReplyButtons({ ...base, buttons: [{ id: "x".repeat(257), title: "One" }] })).toThrow(/id of 1 to 256/);
  });

  it("accepts exactly the limits", () => {
    expect(() => buildReplyButtons({ body: "b".repeat(1024), buttons: [{ id: "a", title: "t".repeat(20) }], header: "h".repeat(60), footer: "f".repeat(60) })).not.toThrow();
    expect(() => buildReplyButtons({ body: "b".repeat(1025), buttons: titles(1) })).toThrow(/at most 1024/);
    expect(() => buildReplyButtons({ body: "b", buttons: titles(1), header: "h".repeat(61) })).toThrow(/at most 60/);
    expect(() => buildReplyButtons({ body: "b", buttons: titles(1), footer: "f".repeat(61) })).toThrow(/at most 60/);
  });

  it("supports an image, video or document header with a secure link only", () => {
    const image = buildReplyButtons({ body: "b", buttons: titles(1), headerMedia: { type: "image", link: "https://cdn.example.com/a.png" } });
    expect(image).toMatchObject({ header: { type: "image", image: { link: "https://cdn.example.com/a.png" } } });
    const doc = buildReplyButtons({ body: "b", buttons: titles(1), headerMedia: { type: "document", link: "https://cdn.example.com/a.pdf", filename: "menu.pdf" } });
    expect(doc).toMatchObject({ header: { type: "document", document: { link: "https://cdn.example.com/a.pdf", filename: "menu.pdf" } } });
    expect(() => buildReplyButtons({ body: "b", buttons: titles(1), headerMedia: { type: "image", link: "http://insecure.example.com/a.png" } })).toThrow(/https/);
  });
});

describe("lists", () => {
  it("builds one section with up to ten rows and optional descriptions", () => {
    const payload = buildList({ body: "Menu", buttonLabel: "Open", rows: [{ id: "r1", title: "One", description: "First" }, ...titles(9, "Row")].map((r, i) => (i === 0 ? r : { ...r, id: `r${i + 1}` })) });
    expect(payload.type).toBe("list");
    if (payload.type !== "list") return;
    expect(payload.action.button).toBe("Open");
    expect(payload.action.sections).toHaveLength(1);
    expect(payload.action.sections[0].rows).toHaveLength(10);
    expect(payload.action.sections[0].rows[0]).toEqual({ id: "r1", title: "One", description: "First" });
  });

  it("rejects more than 10 rows, long titles, descriptions and button labels, and duplicate ids", () => {
    expect(() => buildList({ body: "m", buttonLabel: "Open", rows: titles(11) })).toThrow(/at most 10/);
    expect(() => buildList({ body: "m", buttonLabel: "Open", rows: [{ id: "a", title: "t".repeat(25) }] })).toThrow(/at most 24/);
    expect(() => buildList({ body: "m", buttonLabel: "Open", rows: [{ id: "a", title: "t", description: "d".repeat(73) }] })).toThrow(/at most 72/);
    expect(() => buildList({ body: "m", buttonLabel: "b".repeat(21), rows: titles(1) })).toThrow(/at most 20/);
    expect(() => buildList({ body: "m", buttonLabel: "", rows: titles(1) })).toThrow(/required/);
    expect(() => buildList({ body: "m", buttonLabel: "Open", rows: [{ id: "a", title: "One" }, { id: "a", title: "Two" }] })).toThrow(/share the id/);
  });

  it("only allows a text header", () => {
    expect(() => normalizeInteractive({ type: "list", header: { type: "image", image: { link: "https://x.example.com/a.png" } }, body: { text: "m" }, action: { button: "Open", sections: [{ rows: titles(1) }] } })).toThrow(/header/);
  });

  it("limits the total across sections and requires titles when there are several", () => {
    const section = (title: string, n: number) => ({ title, rows: titles(n).map((r) => ({ ...r, id: `${title}${r.id}` })) });
    expect(() => normalizeInteractive({ type: "list", body: { text: "m" }, action: { button: "Open", sections: [section("A", 6), section("B", 5)] } })).toThrow(/at most 10 rows in total/);
    expect(() => normalizeInteractive({ type: "list", body: { text: "m" }, action: { button: "Open", sections: [section("A", 2), { rows: [{ id: "z", title: "Z" }] }] } })).toThrow(/needs a title/);
    expect(() => normalizeInteractive({ type: "list", body: { text: "m" }, action: { button: "Open", sections: [section("A", 2), section("B", 3)] } })).not.toThrow();
  });
});

describe("normalizeInteractive", () => {
  it("drops unknown fields so nothing unexpected reaches Graph", () => {
    const clean = normalizeInteractive({ type: "button", evil: true, body: { text: "b", extra: 1 }, action: { buttons: [{ type: "reply", reply: { id: "a", title: "A", x: 1 }, y: 2 }], z: 3 } });
    expect(clean).toEqual({ type: "button", body: { text: "b" }, action: { buttons: [{ type: "reply", reply: { id: "a", title: "A" } }] } });
  });
  it("rejects anything that is not a button or list payload", () => {
    expect(() => normalizeInteractive(null)).toThrow();
    expect(() => normalizeInteractive({ type: "product", body: { text: "b" } })).toThrow(/reply buttons or lists/);
  });
  it("describes the message with its options for the inbox", () => {
    expect(describeInteractive(buildReplyButtons({ body: "Pick", buttons: [{ id: "a", title: "Yes" }, { id: "b", title: "No" }] }))).toBe("Pick\n\n[Yes] [No]");
  });
});

describe("inbound replies", () => {
  it("reads the tapped button id and title", () => {
    expect(parseInteractiveReply({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Yes" } } })).toEqual({ kind: "button_reply", id: "b1", title: "Yes" });
  });
  it("reads the tapped list row with its description", () => {
    expect(parseInteractiveReply({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "r2", title: "Two", description: "Second" } } })).toEqual({ kind: "list_reply", id: "r2", title: "Two", description: "Second" });
  });
  it("ignores other messages and replies without an id", () => {
    expect(parseInteractiveReply({ type: "text", text: { body: "hi" } })).toBeNull();
    expect(parseInteractiveReply({ type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow" } } })).toBeNull();
    expect(parseInteractiveReply({ type: "interactive", interactive: { type: "button_reply", button_reply: { title: "No id" } } })).toBeNull();
  });
  it("hands the reply id to the webhook parser next to the readable title", () => {
    expect(describeMessage({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Yes" } } })).toMatchObject({ type: "interactive", body: "Yes", replyId: "b1" });
    expect(describeMessage({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "r1", title: "One" } } })).toMatchObject({ body: "One", replyId: "r1" });
    expect(describeMessage({ type: "text", text: { body: "hi" } })).not.toHaveProperty("replyId");
  });
});

describe("sending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.message.create.mockImplementation(async ({ data }) => ({ id: "m1", ...data }));
  });
  const payload = () => buildReplyButtons({ body: "Pick", buttons: titles(2) });

  it("queues an interactive message inside the 24 hour window, scoped to the tenant", async () => {
    db.conversation.findFirst.mockResolvedValue({ lastInboundAt: new Date() });
    const message = await sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", interactive: payload() });
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(db.message.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", conversationId: "c1", direction: "outbound", type: "interactive", status: "queued", body: "Pick\n\n[Option 1] [Option 2]" });
    expect(queue.enqueue).toHaveBeenCalledWith("send", { messageId: message.id, tenantId: "t1", interactive: payload(), origin: "unknown", category: "SERVICE", wabaRefId: null });
  });

  it("refuses outside the window and for unknown conversations", async () => {
    db.conversation.findFirst.mockResolvedValue({ lastInboundAt: new Date(Date.now() - 25 * 3_600_000) });
    await expect(sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", interactive: payload() })).rejects.toMatchObject({ status: 409 });
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", interactive: payload() })).rejects.toMatchObject({ status: 404 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("validates before touching the database", async () => {
    await expect(sendInteractive({ tenantId: "t1", origin: "unknown", conversationId: "c1", interactive: { type: "button", body: { text: "" }, action: { buttons: [] } } as never })).rejects.toMatchObject({ status: 400 });
    expect(db.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("puts the interactive object in the Graph request body", () => {
    const body = buildSendBody("+919876543210", { type: "interactive", body: "Pick", mediaUrl: null, mediaMime: null }, { interactive: payload() });
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "919876543210", type: "interactive", interactive: payload() });
  });

  it("refuses to send a damaged queued payload", () => {
    expect(() => buildSendBody("+91", { type: "interactive", body: "x", mediaUrl: null, mediaMime: null }, { interactive: { type: "button", body: { text: "b" }, action: { buttons: titles(4).map((b) => ({ type: "reply", reply: b })) } } })).toThrow();
  });

  it("the send job posts the message and records the id", async () => {
    db.message.findFirst.mockResolvedValue({
      id: "m1",
      type: "interactive",
      body: "Pick",
      mediaUrl: null,
      mediaMime: null,
      status: "queued",
      wamid: null,
      statusTimeline: [],
      conversationId: "c1",
      conversation: { contact: { phone: "+919876543210" }, phoneNumber: { phoneNumberId: "meta_1" } },
    });
    graph.graphFetch.mockResolvedValue({ messages: [{ id: "wamid.out" }] });
    await processSendJob({ messageId: "m1", tenantId: "t1", interactive: payload() });
    const call = graph.graphFetch.mock.calls[0][0];
    expect(call).toMatchObject({ tenantId: "t1", path: "meta_1/messages", method: "POST" });
    expect(call.body).toMatchObject({ type: "interactive", interactive: { type: "button" } });
    expect(db.message.updateMany.mock.calls[0][0].data).toMatchObject({ status: "sent", wamid: "wamid.out" });
  });
});
