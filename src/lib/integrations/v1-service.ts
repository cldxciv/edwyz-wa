import type { Prisma } from "@/generated/prisma/client";
import { assertWithinLimit } from "@/lib/billing";
import { assertApiSendFits, holdForApiSend, releaseBulkHold, type BulkHold } from "@/lib/broadcasts/cost";
import type { SpendActor } from "@/lib/spend/types";
import { normalizeBsuid } from "@/lib/contacts/identity";
import { emitAttributeChanges, emitAutomationEvent, emitTagChanges } from "@/lib/automation/v2/emit";
import { recordChannelConsent, recordConsentWithdrawn } from "@/lib/contacts/consent";
import { mayReceive, OPTED_OUT_OF_MARKETING, sendKindForCategory } from "@/lib/contacts/opt-out";
import { normalizePhone } from "@/lib/contacts/phone";
import { listContacts } from "@/lib/contacts/service";
import { prisma } from "@/lib/db";
import { sendTemplateMessage, sendText } from "@/lib/inbox/service";
import { listTemplates } from "@/lib/templates/service";
import { emitEvent } from "./events";
import { contactOptedOutPayload } from "./payloads";
import { type Actor, HttpError } from "@/lib/tenancy";

type ContactRow = { id: string; phone: string | null; bsuid?: string | null; username?: string | null; waId?: string | null; name: string | null; tags: string[]; attributes: unknown; optIn: boolean; optInAt: Date | null; optedOutAt: Date | null; createdAt: Date };

const contactView = (c: ContactRow) => ({
  id: c.id,
  phone: c.phone,
  bsuid: c.bsuid ?? null,
  username: c.username ?? null,
  waId: c.waId ?? null,
  name: c.name,
  tags: c.tags,
  attributes: c.attributes,
  optIn: c.optIn,
  optInAt: c.optInAt,
  optedOutAt: c.optedOutAt,
  createdAt: c.createdAt,
});

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function parsePhone(value: unknown, field: string): string {
  const phone = typeof value === "string" ? normalizePhone(value) : null;
  if (!phone) throw new HttpError(400, `${field} must be a valid phone number with country code.`);
  return phone;
}

/** Who a send is for: a phone number, or the BSUID of a contact who messaged us through a username. */
type Locator = { phone: string } | { bsuid: string };

function parseLocator(body: Record<string, unknown>): Locator {
  const raw = typeof body.to === "string" ? body.to.trim() : "";
  const bsuid = normalizeBsuid(body.bsuid) ?? normalizeBsuid(raw.replace(/^bsuid:/, ""));
  if (bsuid) return { bsuid };
  return { phone: parsePhone(body.to, "to") };
}

const locatorWhere = (tenantId: string, who: Locator) => ({ tenantId, ...("phone" in who ? { phone: who.phone } : { bsuid: who.bsuid }) });

async function createFromSend(tenantId: string, phone: string) {
  await assertWithinLimit(tenantId, "contacts", 1);
  const created = await prisma.contact.create({ data: { tenantId, phone } });
  if (created?.id) void emitAutomationEvent({ type: "contact_created", tenantId, contactId: created.id });
  return created;
}

type Sender = { id: string; wabaRefId: string };

type TemplateInput = { name: string; language: string; components: unknown[] | undefined };

function parseTemplate(t: unknown): TemplateInput {
  if (!isObject(t) || typeof t.name !== "string" || !t.name || typeof t.language !== "string" || !t.language) {
    throw new HttpError(400, "template.name and template.language are required.");
  }
  if (t.components !== undefined && (!Array.isArray(t.components) || JSON.stringify(t.components).length > 20_000)) {
    throw new HttpError(400, "template.components must be an array.");
  }
  return { name: t.name, language: t.language, components: t.components as unknown[] | undefined };
}

/**
 * Who is sending through the API (docs/SPEND-CONTROLS-SPEC.md 4.9): `api` for the v1 and compat APIs, `mcp` for the MCP
 * connection. Both are automated in the spend controls' sense: held while spending is stopped, and refused at enqueue (409)
 * when the WhatsApp limit is used up.
 */
export type ApiSendOptions = {
  conversationId?: string;
  origin?: "api" | "mcp";
  /** A compat batch's hold (one per call); without it a template send takes its own hold of one message. */
  reservationId?: string;
  /** The API key, for the spend ledger. */
  keyId?: string;
};

const apiActor = (actor: Actor, opts: ApiSendOptions): SpendActor => ({ type: "api", keyId: opts.keyId ?? opts.origin ?? "api", userId: actor.userId });

async function sendTextV1(actor: Actor, body: Record<string, unknown>, phoneNumberRowId: string, who: Locator, opts: ApiSendOptions) {
  const { tenantId } = actor;
  const conversationId = opts.conversationId;
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 4096) throw new HttpError(400, "text is required (up to 4096 characters).");
  const contact = await prisma.contact.findFirst({ where: locatorWhere(tenantId, who) });
  // A named conversation is the one used; otherwise the chat is found by (sender number, contact).
  const conversation = contact
    ? await prisma.conversation.findFirst({
        where: conversationId ? { id: conversationId, tenantId, contactId: contact.id } : { tenantId, phoneNumberId: phoneNumberRowId, contactId: contact.id },
        select: { id: true, referral: true, createdAt: true },
      })
    : null;
  // A text goes only into an open chat, as a reply: an opt-out stops marketing only (lib/contacts/opt-out.ts).
  if (contact && !mayReceive(contact, "service")) throw new HttpError(422, OPTED_OUT_OF_MARKETING);
  if (!conversation) throw new HttpError(409, "The 24-hour customer service window is closed. Send an approved template message instead.");
  const origin = opts.origin ?? "api";
  // A free-form message cannot carry a hold: it is refused here, synchronously, when the WhatsApp limit cannot pay for it.
  await assertApiSendFits({ tenantId, actor: apiActor(actor, opts), origin, contact, conversation });
  const message = await sendText({ tenantId, conversationId: conversation.id, userId: actor.userId, body: body.text, origin });
  return { id: message.id, conversationId: conversation.id, status: message.status };
}

/**
 * Template sends require an approved template of this workspace. Marketing templates additionally require a contact that already
 * exists with a recorded opt-in; such a send never creates a contact. Utility and authentication templates may reach a new number,
 * which becomes a contact without an opt-in record.
 */
/** Templates the API may send: approved, or flagged by Meta (6.3: only marketing broadcasts and assistants stop using a flagged one). */
const SENDABLE_TEMPLATE = ["approved", "flagged"] as const;

async function sendTemplateV1(actor: Actor, body: Record<string, unknown>, sender: Sender, who: Locator, opts: ApiSendOptions) {
  const { tenantId } = actor;
  const t = parseTemplate(body.template);
  const template = await prisma.template.findFirst({
    where: { tenantId, wabaRefId: sender.wabaRefId, name: t.name, language: t.language, status: { in: [...SENDABLE_TEMPLATE] } },
    select: { category: true },
  });
  if (!template) throw new HttpError(404, "No approved template with this name and language.");

  const existing = await prisma.contact.findFirst({ where: locatorWhere(tenantId, who) });
  if (existing && !mayReceive(existing, sendKindForCategory(template.category))) throw new HttpError(422, OPTED_OUT_OF_MARKETING);
  if (template.category.toLowerCase() === "marketing" && !existing?.optIn) {
    throw new HttpError(422, "Marketing templates can only be sent to contacts with a recorded opt-in. Record the opt-in first.");
  }
  if (!existing && "bsuid" in who) throw new HttpError(404, "No contact with this WhatsApp user id. A user id can only be messaged after that person has messaged you.");

  // The WhatsApp limit (4.9): a call without a batch hold holds this one message first, so an exhausted limit answers 409
  // synchronously and nothing is created or queued.
  const origin = opts.origin ?? "api";
  const conversation = existing ? await prisma.conversation.findFirst({ where: { tenantId, phoneNumberId: sender.id, contactId: existing.id }, select: { referral: true, createdAt: true } }) : null;
  const hold: BulkHold | null = opts.reservationId
    ? null
    : await holdForApiSend({ tenantId, actor: apiActor(actor, opts), origin, category: template.category, contact: existing ?? ("phone" in who ? { phone: who.phone } : { bsuid: who.bsuid }), conversation });
  const reservationId = opts.reservationId ?? hold?.reservationId ?? undefined;
  try {
    const contact = existing ?? (await createFromSend(tenantId, (who as { phone: string }).phone));
    const message = await sendTemplateMessage({
      tenantId,
      phoneNumberId: sender.id,
      contactId: contact.id,
      templateName: t.name,
      language: t.language,
      components: t.components,
      userId: actor.userId,
      origin,
      ...(reservationId ? { reservationId } : {}),
    });
    return { id: message.id, conversationId: message.conversationId, status: message.status };
  } catch (error) {
    // Nothing was queued: what this call set aside goes back at once.
    await releaseBulkHold(hold?.reservationId, "The API message was not sent, so what was set aside for it went back to your WhatsApp limit.", apiActor(actor, opts));
    throw error;
  }
}

/**
 * `opts.conversationId` (text only) sends inside that exact conversation, from the number it belongs to. A `from` that names a
 * different number is refused instead of silently picking one of the two. `opts.origin` says who is sending (api, or mcp for
 * the MCP connection); a compat batch passes its hold as `opts.reservationId`.
 */
export async function sendMessageV1(actor: Actor, body: Record<string, unknown>, opts: ApiSendOptions = {}) {
  const { tenantId } = actor;
  const who = parseLocator(body);
  if (body.type !== "text" && body.type !== "template") throw new HttpError(400, 'type must be "text" or "template".');
  if (body.from !== undefined && typeof body.from !== "string") throw new HttpError(400, "from must be a phone number id.");

  if (opts.conversationId && body.type === "text") {
    const chat = await prisma.conversation.findFirst({
      where: { id: opts.conversationId, tenantId },
      select: { phoneNumberId: true, phoneNumber: { select: { id: true, phoneNumberId: true, wabaRefId: true } } },
    });
    if (!chat?.phoneNumber) throw new HttpError(404, "Conversation not found.");
    if (body.from && body.from !== chat.phoneNumber.phoneNumberId) throw new HttpError(400, "channel does not match the number this conversation belongs to.");
    return sendTextV1(actor, body, chat.phoneNumber.id, who, opts);
  }

  const sender = await prisma.phoneNumber.findFirst({
    where: { tenantId, ...(body.from ? { phoneNumberId: body.from as string } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, wabaRefId: true },
  });
  if (!sender) throw new HttpError(409, "No connected WhatsApp number found.");

  return body.type === "text" ? sendTextV1(actor, body, sender.id, who, { ...opts, conversationId: undefined }) : sendTemplateV1(actor, body, sender, who, opts);
}

export async function upsertContactV1(actor: Actor, body: Record<string, unknown>) {
  const { tenantId } = actor;
  const phone = parsePhone(body.phone, "phone");
  const data: Prisma.ContactUpdateManyMutationInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length > 200) throw new HttpError(400, "name must be a string up to 200 characters.");
    data.name = body.name.trim();
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 50 || body.tags.some((x) => typeof x !== "string" || !x.trim() || x.length > 60)) {
      throw new HttpError(400, "tags must be up to 50 short strings.");
    }
    data.tags = [...new Set((body.tags as string[]).map((x) => x.trim()))];
  }
  if (body.attributes !== undefined) {
    if (!isObject(body.attributes) || JSON.stringify(body.attributes).length > 10_000) throw new HttpError(400, "attributes must be a JSON object under 10 KB.");
    data.attributes = body.attributes as Prisma.InputJsonObject;
  }
  if (body.optIn !== undefined && typeof body.optIn !== "boolean") throw new HttpError(400, "optIn must be true or false.");
  if (body.optIn === true && (typeof body.optInSource !== "string" || !body.optInSource.trim() || body.optInSource.length > 100)) {
    throw new HttpError(400, "optInSource is required when optIn is true.");
  }

  const existing = await prisma.contact.findFirst({ where: { tenantId, phone } });
  if (existing?.optedOutAt && body.optIn === true) throw new HttpError(422, "This contact opted out of marketing messages. Only they can opt in again, by sending START to your WhatsApp number.");
  // A contact who is already opted in keeps the source and time of the first consent: repeating optIn: true must not overwrite the proof.
  const alreadyIn = !!existing?.optIn;
  const newConsent = body.optIn === true && !alreadyIn;
  const optIn =
    body.optIn === true ? (alreadyIn ? {} : { optIn: true, optInSource: (body.optInSource as string).trim(), optInAt: new Date() }) : body.optIn === false ? { optIn: false } : {};
  const consentSource = typeof body.optInSource === "string" ? body.optInSource.trim() : "api";

  if (existing) {
    await prisma.contact.updateMany({ where: { id: existing.id, tenantId }, data: { ...data, ...optIn } });
    if (newConsent) await recordChannelConsent(tenantId, existing.id, { source: consentSource, via: "api", userId: actor.userId });
    else if (body.optIn === false && alreadyIn) {
      await recordConsentWithdrawn({ tenantId, userId: actor.userId }, existing.id);
      // Withdrawing consent through the API stops marketing to this contact, so subscribers hear about it (source "api").
      try {
        await emitEvent(tenantId, "contact.opted_out", contactOptedOutPayload({ contact: existing, optedOutAt: new Date(), source: "api" }));
      } catch {
        console.warn("[v1] the opt-out event could not be queued");
      }
    }
    const updated = await prisma.contact.findFirst({ where: { id: existing.id, tenantId } });
    if (updated) {
      const base = { tenantId, contactId: existing.id };
      if (body.tags !== undefined) void emitTagChanges(base, existing.tags, updated.tags);
      if (body.attributes !== undefined) void emitAttributeChanges(base, (existing.attributes ?? {}) as Record<string, unknown>, (updated.attributes ?? {}) as Record<string, unknown>);
    }
    return { created: false, contact: contactView(updated as ContactRow) };
  }
  await assertWithinLimit(tenantId, "contacts", 1);
  const created = await prisma.contact.create({ data: { tenantId, phone, ...(data as object), ...optIn } });
  if (newConsent) await recordChannelConsent(tenantId, created.id, { source: consentSource, via: "api", userId: actor.userId });
  void emitAutomationEvent({ type: "contact_created", tenantId, contactId: created.id });
  return { created: true, contact: contactView(created as ContactRow) };
}

export async function listContactsV1(actor: Actor, params: URLSearchParams) {
  const limit = Number(params.get("limit") ?? 50);
  const page = await listContacts(actor, {
    q: params.get("q") ?? undefined,
    tag: params.get("tag") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return { contacts: page.items.map((c) => contactView(c as ContactRow)), nextCursor: page.nextCursor };
}

export async function listTemplatesV1(actor: Actor, params: URLSearchParams) {
  const rows = await listTemplates(actor, { status: params.get("status") ?? undefined });
  return { templates: rows.map((t) => ({ name: t.name, language: t.language, category: t.category, status: t.status, components: t.components })) };
}
