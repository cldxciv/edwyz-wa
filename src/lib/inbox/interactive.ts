import { prisma } from "@/lib/db";
import { stopBotsOnHumanReply } from "@/lib/chatbots/human-reply";
import { enqueue } from "@/lib/queue";
import { DEFAULT_ORIGIN, FREE_FORM_CATEGORY, type OriginField } from "@/lib/spend/messaging/origin";
import { HttpError } from "@/lib/tenancy";
import { isWithinServiceWindow } from "./window";

/** Hard limits of the WhatsApp Cloud API interactive message types. Anything outside them is rejected before it is queued. */
export const INTERACTIVE_LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  buttonId: 256,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  listButton: 20,
  body: 1024,
  headerText: 60,
  footer: 60,
  headerLink: 2000,
  filename: 240,
} as const;

export const HEADER_MEDIA_TYPES = ["image", "video", "document"] as const;
export type HeaderMediaType = (typeof HEADER_MEDIA_TYPES)[number];

export type InteractiveOption = { id: string; title: string; description?: string };

type Header = { type: "text"; text: string } | { type: HeaderMediaType; image?: { link: string }; video?: { link: string }; document?: { link: string; filename?: string } };

export type InteractivePayload =
  | { type: "button"; header?: Header; body: { text: string }; footer?: { text: string }; action: { buttons: { type: "reply"; reply: { id: string; title: string } }[] } }
  | { type: "list"; header?: { type: "text"; text: string }; body: { text: string }; footer?: { text: string }; action: { button: string; sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] } };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const bad = (message: string): never => {
  throw new HttpError(400, message);
};

function checkedText(value: unknown, max: number, label: string, required: boolean): string {
  const t = text(value);
  if (!t) return required ? bad(`${label} is required.`) : "";
  if (t.length > max) bad(`${label} can be at most ${max} characters.`);
  return t;
}

function checkedId(value: unknown, max: number, label: string): string {
  const id = typeof value === "string" ? value : "";
  if (!id || id.length > max || id !== id.trim()) bad(`${label} needs an id of 1 to ${max} characters.`);
  return id;
}

function buildHeader(raw: unknown, allowMedia: boolean): Header | undefined {
  if (raw === undefined || raw === null) return undefined;
  const h = rec(raw);
  if (h.type === "text") {
    const t = checkedText(h.text, INTERACTIVE_LIMITS.headerText, "Header", true);
    return { type: "text", text: t };
  }
  if (!allowMedia || !(HEADER_MEDIA_TYPES as readonly unknown[]).includes(h.type)) return bad("The header must be text, or an image, video or document for buttons.");
  const type = h.type as HeaderMediaType;
  const source = rec(h[type]);
  const link = typeof source.link === "string" ? source.link : "";
  if (!/^https:\/\/\S+$/i.test(link) || link.length > INTERACTIVE_LIMITS.headerLink) bad("A media header needs a secure (https) link.");
  if (type === "document") {
    const filename = text(source.filename);
    if (filename.length > INTERACTIVE_LIMITS.filename) bad("The document file name is too long.");
    return { type, document: { link, ...(filename ? { filename } : {}) } };
  }
  return type === "image" ? { type, image: { link } } : { type, video: { link } };
}

function buildButtons(action: Rec): { type: "reply"; reply: { id: string; title: string } }[] {
  const list = Array.isArray(action.buttons) ? action.buttons : [];
  if (list.length < 1 || list.length > INTERACTIVE_LIMITS.buttons) bad(`Reply buttons need between 1 and ${INTERACTIVE_LIMITS.buttons} buttons.`);
  const ids = new Set<string>();
  const titles = new Set<string>();
  return list.map((entry) => {
    const reply = rec(rec(entry).reply);
    const id = checkedId(reply.id, INTERACTIVE_LIMITS.buttonId, "Each button");
    const title = checkedText(reply.title, INTERACTIVE_LIMITS.buttonTitle, "Each button title", true);
    if (ids.has(id)) bad(`Two buttons share the id "${id}".`);
    if (titles.has(title.toLowerCase())) bad(`Two buttons share the title "${title}".`);
    ids.add(id);
    titles.add(title.toLowerCase());
    return { type: "reply" as const, reply: { id, title } };
  });
}

function buildSections(action: Rec) {
  const sections = Array.isArray(action.sections) ? action.sections : [];
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.rows) bad("A list needs at least one section.");
  const ids = new Set<string>();
  let total = 0;
  const out = sections.map((raw) => {
    const s = rec(raw);
    const title = checkedText(s.title, INTERACTIVE_LIMITS.rowTitle, "A section title", false);
    const rows = (Array.isArray(s.rows) ? s.rows : []).map((r) => {
      const row = rec(r);
      const id = checkedId(row.id, INTERACTIVE_LIMITS.rowId, "Each row");
      if (ids.has(id)) bad(`Two rows share the id "${id}".`);
      ids.add(id);
      const description = checkedText(row.description, INTERACTIVE_LIMITS.rowDescription, "A row description", false);
      return { id, title: checkedText(row.title, INTERACTIVE_LIMITS.rowTitle, "Each row title", true), ...(description ? { description } : {}) };
    });
    if (rows.length === 0) bad("Each list section needs at least one row.");
    total += rows.length;
    return { ...(title ? { title } : {}), rows };
  });
  if (total > INTERACTIVE_LIMITS.rows) bad(`A list can have at most ${INTERACTIVE_LIMITS.rows} rows in total.`);
  if (out.length > 1 && out.some((s) => !s.title)) bad("Every section of a multi-section list needs a title.");
  return out;
}

/**
 * Validates a WhatsApp interactive payload against the Cloud API limits and returns a clean copy that holds only known fields.
 * Used for what we build and again for what is read back from a queued job, so a damaged job can never reach Graph.
 */
export function normalizeInteractive(raw: unknown): InteractivePayload {
  const p = rec(raw);
  const body = { text: checkedText(rec(p.body).text, INTERACTIVE_LIMITS.body, "The message text", true) };
  const footerText = checkedText(rec(p.footer).text, INTERACTIVE_LIMITS.footer, "The footer", false);
  const footer = footerText ? { footer: { text: footerText } } : {};
  const action = rec(p.action);
  if (p.type === "button") {
    const header = buildHeader(p.header, true);
    return { type: "button", ...(header ? { header } : {}), body, ...footer, action: { buttons: buildButtons(action) } };
  }
  if (p.type === "list") {
    const header = buildHeader(p.header, false) as { type: "text"; text: string } | undefined;
    const button = checkedText(action.button, INTERACTIVE_LIMITS.listButton, "The list button text", true);
    return { type: "list", ...(header ? { header } : {}), body, ...footer, action: { button, sections: buildSections(action) } };
  }
  return bad("Interactive messages are either reply buttons or lists.");
}

type BuildCommon = { body: string; footer?: string };

export function buildReplyButtons(input: BuildCommon & { buttons: { id: string; title: string }[]; header?: string; headerMedia?: { type: HeaderMediaType; link: string; filename?: string } }): InteractivePayload {
  const header = input.headerMedia
    ? { type: input.headerMedia.type, [input.headerMedia.type]: { link: input.headerMedia.link, ...(input.headerMedia.type === "document" && input.headerMedia.filename ? { filename: input.headerMedia.filename } : {}) } }
    : input.header
      ? { type: "text", text: input.header }
      : undefined;
  return normalizeInteractive({
    type: "button",
    ...(header ? { header } : {}),
    body: { text: input.body },
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    action: { buttons: input.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
  });
}

export function buildList(input: BuildCommon & { buttonLabel: string; rows: InteractiveOption[]; header?: string; sectionTitle?: string }): InteractivePayload {
  return normalizeInteractive({
    type: "list",
    ...(input.header ? { header: { type: "text", text: input.header } } : {}),
    body: { text: input.body },
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    action: { button: input.buttonLabel, sections: [{ ...(input.sectionTitle ? { title: input.sectionTitle } : {}), rows: input.rows }] },
  });
}

/** Readable text kept in the inbox for an interactive message: the message plus its options. */
export function describeInteractive(payload: InteractivePayload): string {
  const options = payload.type === "button" ? payload.action.buttons.map((b) => b.reply.title) : payload.action.sections.flatMap((s) => s.rows.map((r) => r.title));
  return `${payload.body.text}\n\n${options.map((o) => `[${o}]`).join(" ")}`.slice(0, 4096);
}

export type InteractiveReply = { kind: "button_reply" | "list_reply"; id: string; title: string; description?: string };

/** The tapped option of an inbound interactive message, or null for any other message (including flow replies). */
export function parseInteractiveReply(message: unknown): InteractiveReply | null {
  const m = rec(message);
  if (m.type !== "interactive") return null;
  const i = rec(m.interactive);
  const kind = i.type === "list_reply" ? "list_reply" : i.type === "button_reply" ? "button_reply" : rec(i.list_reply).id ? "list_reply" : rec(i.button_reply).id ? "button_reply" : null;
  if (!kind) return null;
  const reply = rec(kind === "list_reply" ? i.list_reply : i.button_reply);
  const id = typeof reply.id === "string" ? reply.id : "";
  if (!id) return null;
  const title = typeof reply.title === "string" ? reply.title : "";
  const description = typeof reply.description === "string" ? reply.description : undefined;
  return { kind, id, title, ...(description ? { description } : {}) };
}

/** origin: who is sending, for the spend controls' send gate (docs/SPEND-CONTROLS-SPEC.md 4.9); unstamped is "unknown" (automated). */
type SendInput = { tenantId: string; conversationId: string; userId?: string; interactive: InteractivePayload } & OriginField;

/**
 * Queues an interactive message. Free-form like text, so only inside the 24 hour customer service window.
 * Throws a 400 HttpError when the payload breaks a WhatsApp limit, so callers can fall back to plain text.
 */
export async function sendInteractive(input: SendInput) {
  const interactive = normalizeInteractive(input.interactive);
  const origin = input.origin ?? DEFAULT_ORIGIN;
  const conversation = await prisma.conversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenantId }, select: { lastInboundAt: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  if (!isWithinServiceWindow(conversation.lastInboundAt)) {
    throw new HttpError(409, "The 24-hour customer service window is closed. Send an approved template message instead.");
  }
  const message = await prisma.message.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      direction: "outbound",
      type: "interactive",
      body: describeInteractive(interactive),
      status: "queued",
      statusTimeline: [{ status: "queued", at: new Date().toISOString() }],
      sentByUserId: input.userId ?? null,
      origin,
      pricingCategory: FREE_FORM_CATEGORY,
    },
  });
  const now = new Date();
  await prisma.conversation.updateMany({ where: { id: input.conversationId, tenantId: input.tenantId }, data: { lastMessageAt: now, ...(input.userId ? { lastAgentReplyAt: now } : {}) } });
  if (input.userId) {
    await prisma.conversation.updateMany({ where: { id: input.conversationId, tenantId: input.tenantId, firstAgentReplyAt: null }, data: { firstAgentReplyAt: now } });
    await stopBotsOnHumanReply(input.tenantId, input.conversationId);
  }
  // Free-form, so priced as SERVICE; the gate reads the sending number's WABA from the conversation at send time.
  await enqueue("send", { messageId: message.id, tenantId: input.tenantId, interactive, origin, category: FREE_FORM_CATEGORY, wabaRefId: null });
  return message;
}
