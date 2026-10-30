import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { getRateCard } from "@/lib/admin/ratecard";
import { broadcastSupportReason } from "@/lib/broadcasts/components";
import { API_HOLD_TTL_MS, bulkEstimateMinor, bulkGateStep, holdForBulk, releaseBulkHold, type BulkHold } from "@/lib/broadcasts/cost";
import { countryOfBsuid, countryOfPhone } from "@/lib/broadcasts/country";
import { buildRecipientComponents, templateSlots, type VariableMap } from "@/lib/broadcasts/mapping";
import { NO_ADDRESS_MESSAGE, normalizeBsuid, recipientAddress } from "@/lib/contacts/identity";
import { prisma } from "@/lib/db";
import { sendMessageV1 } from "@/lib/integrations/v1-service";
import { describeError } from "@/lib/safe-error";
import { listTemplates } from "@/lib/templates/service";
import { HttpError, type Actor } from "@/lib/tenancy";
import { isObject, iso, pageJson, parsePaging, resolveTarget, sliceMemory, toE164 } from "./common";
import { parseLocalMessageId, sendOnce, type SentOnce } from "./idempotency";
import type { Handler } from "./runtime";
import { MAX_TEMPLATE_RECIPIENTS } from "./spec";

const messageSent = (s: SentOnce, localId: string | undefined) => ({
  id: s.id,
  conversation_id: s.conversationId,
  status: s.status,
  local_message_id: localId ?? null,
  deduplicated: s.duplicate,
});

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100) throw new HttpError(400, `${field} must be a string up to 100 characters.`);
  return value;
}

export const sendText: Handler = async ({ actor, params, body }) => {
  const input = await body();
  const localId = parseLocalMessageId(input.local_message_id);
  const channel = optionalString(input.channel, "channel");
  const { contact, conversationId } = await resolveTarget(actor.tenantId, params.target);
  const who = contact ? requireAddress(contact) : addressFromPhone(toE164(params.target));
  if (!who) throw new HttpError(404, "Contact not found.");
  const sent = await sendOnce(actor.tenantId, whoKey(who), localId, { type: "text", text: input.text, channel: channel ?? null, conversationId }, () =>
    sendMessageV1(actor, { ...whoFields(who), type: "text", text: input.text, ...(channel ? { from: channel } : {}) }, { origin: "api", ...(conversationId ? { conversationId } : {}) }),
  );
  return { status: 202, json: { message: messageSent(sent, localId) } };
};

type Who = { phone: string } | { bsuid: string };

const addressFromPhone = (phone: string | null): Who | null => (phone ? { phone } : null);
const whoKey = (who: Who) => ("phone" in who ? who.phone : who.bsuid);
const whoFields = (who: Who) => ("phone" in who ? { to: who.phone } : { bsuid: who.bsuid });

/** A stored contact is messaged by phone when it has one, otherwise by BSUID. */
function requireAddress(contact: { phone: string | null; bsuid: string | null }): Who {
  const address = recipientAddress(contact);
  if (!address) throw new HttpError(422, NO_ADDRESS_MESSAGE);
  return address;
}

/** Values fill {{1}}, {{2}}... in the order given, or by number when every name is a digit string. */
function orderedValues(customParams: unknown): string[] {
  if (customParams === undefined) return [];
  if (!Array.isArray(customParams) || customParams.length > 20) throw new HttpError(400, "custom_params must be an array of { name, value }.");
  const items = customParams.map((p) => {
    if (!isObject(p) || typeof p.name !== "string" || (typeof p.value !== "string" && typeof p.value !== "number")) {
      throw new HttpError(400, "Every custom_params item needs a name and a text value.");
    }
    return { name: p.name, value: String(p.value) };
  });
  if (items.length > 0 && items.every((i) => /^\d+$/.test(i.name))) items.sort((a, b) => Number(a.name) - Number(b.name));
  return items.map((i) => i.value);
}

type Tpl = { name: string; language: string; components: unknown; category?: string | null };

async function pickTemplate(tenantId: string, name: string, language: string | undefined): Promise<Tpl> {
  const rows = await prisma.template.findMany({
    // A template Meta flagged may still be sent through the API (spend spec 6.3: only marketing broadcasts and assistants stop).
    where: { tenantId, name, status: { in: ["approved", "flagged"] }, ...(language ? { language } : {}) },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  if (rows.length === 0) throw new HttpError(404, "No approved template with this name.");
  if (new Set(rows.map((r) => r.language)).size > 1) throw new HttpError(400, "This template exists in several languages; send language.");
  return rows[0];
}

const MAX_PARAM = 1024;

function paramText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_PARAM) throw new HttpError(400, `${field} must be text of 1 to ${MAX_PARAM} characters.`);
  return value;
}

/** Button link values: an array of { index, value }, where index counts the template's buttons from 0. */
function buttonValues(raw: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (raw === undefined) return out;
  if (!Array.isArray(raw) || raw.length > 10) throw new HttpError(400, "button_params must be an array of { index, value }.");
  for (const item of raw) {
    if (!isObject(item) || !Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) > 9) throw new HttpError(400, "Every button_params item needs an index from 0 to 9.");
    out.set(item.index as number, paramText(item.value, "button_params value"));
  }
  return out;
}

type RecipientValues = { body: string[]; header: string | undefined; buttons: Map<number, string> };

/**
 * Builds the send components from the values one recipient brought: custom_params for the message text in order, header_param for a
 * header placeholder or the https link of an image, video or document header, and button_params for link buttons.
 */
function templateComponents(tpl: Tpl, values: RecipientValues): unknown[] {
  const unsupported = broadcastSupportReason(tpl.components);
  if (unsupported) throw new HttpError(422, unsupported);
  const slots = templateSlots(tpl.components);
  const bodySlots = slots.filter((s) => s.kind === "body");
  if (values.body.length !== bodySlots.length) throw new HttpError(400, `This template takes ${bodySlots.length} parameter(s); got ${values.body.length}.`);
  const map: VariableMap = {};
  bodySlots.forEach((slot, i) => (map[slot.key] = { source: "static", value: values.body[i] }));
  for (const slot of slots) {
    if (slot.kind === "header_text" || slot.kind === "header_media") {
      if (values.header === undefined) throw new HttpError(400, slot.kind === "header_media" ? `This template has a ${slot.mediaType} header; send header_param with a public https link.` : "This template has a header placeholder; send header_param.");
      map.header = { source: "static", value: values.header };
    } else if (slot.kind === "button_url") {
      const value = values.buttons.get(slot.buttonIndex);
      if (value === undefined) throw new HttpError(400, `This template has a link button at position ${slot.buttonIndex}; send button_params with { index: ${slot.buttonIndex}, value }.`);
      map[slot.key] = { source: "static", value };
    }
  }
  if (values.header !== undefined && !slots.some((s) => s.kind === "header_text" || s.kind === "header_media")) throw new HttpError(400, "This template has no header placeholder; remove header_param.");
  for (const index of values.buttons.keys()) if (!slots.some((s) => s.kind === "button_url" && s.buttonIndex === index)) throw new HttpError(400, `This template has no link placeholder on button ${index}.`);
  const built = buildRecipientComponents(tpl.components, { name: null, attributes: {} }, map, "fail");
  if (!built.ok) throw new HttpError(400, `A value is missing or not valid for: ${built.missing.join(", ")}. Header media needs a public https link.`);
  return built.components;
}

/** The country each recipient of a batch is priced in (null when the address cannot be read: the highest rate). */
function batchCountries(recipients: unknown[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const item of recipients) {
    if (!isObject(item)) continue;
    const phone = typeof item.phone_number === "string" ? toE164(item.phone_number) : null;
    const bsuid = typeof item.bsuid === "string" ? normalizeBsuid(item.bsuid) : null;
    if (!phone && !bsuid) continue; // refused below, so it costs nothing
    const country = phone ? countryOfPhone(phone) : countryOfBsuid(bsuid as string);
    out.set(country, (out.get(country) ?? 0) + 1);
  }
  return out;
}

/**
 * One hold for the whole call (docs/SPEND-CONTROLS-SPEC.md 4.9: compat messageTemplates/send takes its reservation per call), so
 * a batch that does not fit the WhatsApp limit is refused with 409 before anything is queued. Null when nothing can be priced.
 */
async function holdBatch(actor: Actor, tpl: Tpl, recipients: unknown[]): Promise<BulkHold | null> {
  const card = await getRateCard();
  const estimateMinor = card ? bulkEstimateMinor({ category: tpl.category ?? "MARKETING", countries: batchCountries(recipients), card }) : null;
  if (!card || estimateMinor === null) return null;
  return bulkGateStep(
    "an API batch",
    () =>
      holdForBulk({
        tenantId: actor.tenantId,
        subject: { type: "api_batch", id: `compat:${randomUUID()}` },
        estimateMinor,
        currency: card.currency,
        ttlMs: API_HOLD_TTL_MS,
        actor: { type: "api", keyId: "compat", userId: actor.userId },
        reason: `Template ${tpl.name} to ${recipients.length} ${recipients.length === 1 ? "person" : "people"} through the API.`,
        refusal: "batch",
      }),
    null,
  );
}

async function sendOneTemplate(actor: Actor, tpl: Tpl, channel: string | undefined, item: unknown, reservationId: string | null = null) {
  if (!isObject(item) || (typeof item.phone_number !== "string" && typeof item.bsuid !== "string")) throw new HttpError(400, "phone_number or bsuid is required.");
  const bsuid = typeof item.bsuid === "string" ? normalizeBsuid(item.bsuid) : null;
  if (typeof item.bsuid === "string" && !bsuid) throw new HttpError(400, "bsuid is not a valid WhatsApp user id.");
  const phone = typeof item.phone_number === "string" ? toE164(item.phone_number) : null;
  if (typeof item.phone_number === "string" && !phone) throw new HttpError(400, "phone_number must include the country code.");
  const who: Who = phone ? { phone } : { bsuid: bsuid as string };
  const localId = parseLocalMessageId(item.local_message_id);
  const components = templateComponents(tpl, {
    body: orderedValues(item.custom_params),
    header: item.header_param === undefined || item.header_param === null ? undefined : paramText(item.header_param, "header_param"),
    buttons: buttonValues(item.button_params),
  });
  const sent = await sendOnce(actor.tenantId, whoKey(who), localId, { type: "template", name: tpl.name, language: tpl.language, components, channel: channel ?? null }, () =>
    sendMessageV1(
      actor,
      {
        ...whoFields(who),
        type: "template",
        template: { name: tpl.name, language: tpl.language, components },
        ...(channel ? { from: channel } : {}),
      },
      { origin: "api", ...(reservationId ? { reservationId } : {}) },
    ),
  );
  return {
    local_message_id: localId ?? null,
    phone_number: phone,
    bsuid: "bsuid" in who ? who.bsuid : null,
    accepted: true,
    status: "accepted",
    message_id: sent.id,
    conversation_id: sent.conversationId,
    deduplicated: sent.duplicate,
    errors: null as string[] | null,
    error_status: null as number | null,
  };
}

function rejectedRecipient(item: unknown, status: number, message: string) {
  const rec = isObject(item) ? item : {};
  return {
    local_message_id: typeof rec.local_message_id === "string" ? rec.local_message_id : null,
    phone_number: typeof rec.phone_number === "string" ? rec.phone_number : null,
    bsuid: typeof rec.bsuid === "string" ? rec.bsuid : null,
    accepted: false,
    status: "rejected",
    message_id: null,
    conversation_id: null,
    deduplicated: false,
    errors: [message],
    error_status: status,
  };
}

export const sendTemplate: Handler = async ({ actor, body }) => {
  const input = await body();
  if (typeof input.template_name !== "string" || !input.template_name) throw new HttpError(400, "template_name is required.");
  if (!Array.isArray(input.recipients) || input.recipients.length === 0 || input.recipients.length > MAX_TEMPLATE_RECIPIENTS) {
    throw new HttpError(400, `recipients must be a list of 1 to ${MAX_TEMPLATE_RECIPIENTS} items.`);
  }
  const channel = optionalString(input.channel, "channel");
  const language = optionalString(input.language, "language");
  const broadcastName = optionalString(input.broadcast_name, "broadcast_name") ?? null;
  const tpl = await pickTemplate(actor.tenantId, input.template_name, language);
  // Refused here (409, with the plain sentence) when the batch does not fit the WhatsApp limit: nothing is queued.
  const hold = await holdBatch(actor, tpl, input.recipients);

  const results: Record<string, unknown>[] = [];
  for (const item of input.recipients) {
    try {
      results.push(await sendOneTemplate(actor, tpl, channel, item, hold?.reservationId ?? null));
    } catch (e) {
      if (e instanceof HttpError) results.push(rejectedRecipient(item, e.status, e.message));
      else {
        console.error("[compat] a template recipient failed unexpectedly:", describeError(e));
        results.push(rejectedRecipient(item, 500, "This message could not be sent. Try it again."));
      }
    }
  }
  const rejected = results.filter((r) => r.errors).length;
  // Nothing was queued (every recipient refused): the hold goes back at once. Otherwise the messages use it as they are sent and
  // whatever is left goes back when it expires.
  if (hold?.reservationId && rejected === results.length) {
    await releaseBulkHold(hold.reservationId, "No message of this API call was queued, so what was set aside went back to your WhatsApp limit.", { type: "api", keyId: "compat", userId: actor.userId });
  }
  return {
    json: {
      success: rejected === 0,
      broadcast_id: null,
      broadcast_name: broadcastName,
      error: rejected === 0 ? null : `${rejected} of ${results.length} recipients were not accepted.`,
      accepted_count: results.length - rejected,
      rejected_count: rejected,
      delivery_note: "accepted means we took the message and queued it for sending to WhatsApp. It is not a delivery confirmation: delivery and read receipts arrive later as message.status webhook events and in the message history.",
      recipients: results,
    },
  };
};

type TemplateRow = { id: string; name: string; language: string; category: string; status: string; components: unknown; rejectionReason: string | null; createdAt: Date };

const templateView = (t: TemplateRow) => ({
  id: t.id,
  name: t.name,
  language: t.language,
  category: t.category,
  status: t.status,
  components: t.components,
  rejection_reason: t.rejectionReason,
  created: iso(t.createdAt),
});

export const getTemplate: Handler = async ({ actor, params }) => {
  const row = await prisma.template.findFirst({ where: { id: params.id, tenantId: actor.tenantId } });
  if (!row) throw new HttpError(404, "Template not found.");
  return { json: { message_template: templateView(row as TemplateRow) } };
};

export const listTemplatesHandler: Handler = async ({ actor, query }) => {
  const paging = parsePaging(query);
  const status = query.get("status") ?? undefined;
  if (status && !["draft", "pending", "approved", "rejected", "paused", "disabled"].includes(status)) throw new HttpError(400, "status is not a template status.");
  const rows = await listTemplates(actor, { status });
  const items = sliceMemory(rows, paging).map((t) => templateView(t as TemplateRow));
  return { json: pageJson("message_template_list", items, paging, rows.length) };
};

export const listMessages: Handler = async ({ actor, params, query }) => {
  const paging = parsePaging(query);
  const { contact, conversationId } = await resolveTarget(actor.tenantId, params.target);
  if (!contact) throw new HttpError(404, "Conversation not found.");
  const conversation: Prisma.ConversationWhereInput = conversationId ? { id: conversationId, tenantId: actor.tenantId } : { tenantId: actor.tenantId, contactId: contact.id };
  const where: Prisma.MessageWhereInput = { tenantId: actor.tenantId, conversation };
  const [rows, total] = await Promise.all([
    prisma.message.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.take }),
    prisma.message.count({ where }),
  ]);
  const items = rows.map((m) => ({
    id: m.id,
    conversation_id: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: m.body,
    template_name: m.templateName,
    media_mime: m.mediaMime,
    status: m.status,
    error_code: m.errorCode,
    created: iso(m.createdAt),
  }));
  return { json: pageJson("message_list", items, paging, total) };
};
