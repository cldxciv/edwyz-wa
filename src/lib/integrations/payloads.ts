/**
 * The outbound webhook payloads. Each builder is a pure function from plain values to the `data` object of an event, and each
 * event's documentation is derived from the same builder's sample, so the public docs, the OpenAPI document and the code cannot drift.
 * Adding a field here without documenting it (or the reverse) fails tests/integrations-payloads.test.ts.
 */
import type { WebhookEventName } from "./events";

export type FieldDoc = { name: string; type: string; description: string };
export type EventDoc = { event: WebhookEventName; title: string; when: string; fields: FieldDoc[]; sample: unknown };

export type ContactRef = { id: string; phone: string | null; bsuid: string | null; waId: string | null; username: string | null; name: string | null };

type ContactLike = { id: string; phone?: string | null; bsuid?: string | null; waId?: string | null; username?: string | null; name?: string | null };

/** Every payload that names a contact identifies it the same way. phone can be null for people who message through a username. */
export const contactRef = (c: ContactLike): ContactRef => ({ id: c.id, phone: c.phone ?? null, bsuid: c.bsuid ?? null, waId: c.waId ?? null, username: c.username ?? null, name: c.name ?? null });

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export type MessageReceivedInput = {
  conversationId: string;
  channel: string | null;
  assignedTo: string | null;
  contact: ContactLike;
  message: { id: string; type: string; text: string | null; mediaId: string | null; mimeType: string | null; timestamp: Date | string };
  referral: { sourceType?: string; sourceId?: string; sourceUrl?: string; headline?: string; ctwaClid?: string } | null;
};

export function messageReceivedPayload(i: MessageReceivedInput) {
  return {
    conversationId: i.conversationId,
    channel: i.channel,
    assignedTo: i.assignedTo,
    contact: contactRef(i.contact),
    message: { id: i.message.id, type: i.message.type, text: i.message.text, mediaId: i.message.mediaId, mimeType: i.message.mimeType, timestamp: iso(i.message.timestamp) },
    referral: i.referral
      ? {
          sourceType: i.referral.sourceType ?? null,
          sourceId: i.referral.sourceId ?? null,
          sourceUrl: i.referral.sourceUrl ?? null,
          headline: i.referral.headline ?? null,
          ctwaClid: i.referral.ctwaClid ?? null,
        }
      : null,
  };
}

export type MessageStatusInput = {
  messageId: string;
  conversationId: string;
  wamid: string | null;
  status: string;
  errorCode: string | null;
  timestamp: Date | string;
  contact: ContactLike | null;
};

export function messageStatusPayload(i: MessageStatusInput) {
  return {
    messageId: i.messageId,
    conversationId: i.conversationId,
    wamid: i.wamid,
    status: i.status,
    errorCode: i.errorCode,
    timestamp: iso(i.timestamp),
    contact: i.contact ? contactRef(i.contact) : null,
  };
}

export type TemplateStatusInput = {
  templateId: string | null;
  name: string | null;
  language: string | null;
  category: string | null;
  status: string;
  reason: string | null;
  timestamp: Date | string;
};

export function templateStatusPayload(i: TemplateStatusInput) {
  return { templateId: i.templateId, name: i.name, language: i.language, category: i.category, status: i.status, reason: i.reason, timestamp: iso(i.timestamp) };
}

export type BroadcastTotals = { total: number; sent: number; delivered: number; read: number; failed: number; skipped: number };

/** Counts by recipient status. sent includes delivered and read, delivered includes read, as everywhere else in the product. */
export function broadcastTotals(counts: Record<string, number>): BroadcastTotals {
  const n = (s: string) => counts[s] ?? 0;
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    sent: n("sent") + n("delivered") + n("read"),
    delivered: n("delivered") + n("read"),
    read: n("read"),
    failed: n("failed"),
    skipped: n("skipped"),
  };
}

export type BroadcastCompletedInput = { broadcastId: string; name: string | null; templateId: string | null; completedAt: Date | string; totals: BroadcastTotals };

export function broadcastCompletedPayload(i: BroadcastCompletedInput) {
  return { broadcastId: i.broadcastId, name: i.name, templateId: i.templateId, completedAt: iso(i.completedAt), totals: i.totals };
}

export type OptOutSource = "stop_keyword" | "api" | "dashboard" | "chatbot";
export type ContactOptedOutInput = { contact: ContactLike; optedOutAt: Date | string; source: OptOutSource };

export function contactOptedOutPayload(i: ContactOptedOutInput) {
  return { contact: contactRef(i.contact), contactId: i.contact.id, phone: i.contact.phone ?? null, optedOutAt: iso(i.optedOutAt), source: i.source };
}

export type StatusChangedInput = { conversationId: string; contactId: string | null; from: string | null; to: string; changedBy: string | null; source: "user" | "system"; timestamp: Date | string };

export function conversationStatusChangedPayload(i: StatusChangedInput) {
  return { conversationId: i.conversationId, contactId: i.contactId, from: i.from, to: i.to, changedBy: i.changedBy, source: i.source, timestamp: iso(i.timestamp) };
}

/** Where a lead came from: a Meta lead form, or a chat started from a click-to-WhatsApp ad (src/lib/conversions/referral.ts). */
export const LEAD_SOURCES = ["meta_lead_form", "ctwa"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** source defaults to meta_lead_form, the only kind of lead the event carried before click-to-WhatsApp leads. */
export type LeadCreatedInput = {
  leadId: string;
  status: string;
  source?: LeadSource;
  formId: string | null;
  campaignId: string | null;
  adId: string | null;
  createdAt: Date | string;
  contact: ContactLike | null;
  fields: Record<string, string>;
};

export function leadCreatedPayload(i: LeadCreatedInput) {
  return {
    leadId: i.leadId,
    status: i.status,
    source: i.source ?? ("meta_lead_form" as LeadSource),
    formId: i.formId,
    campaignId: i.campaignId,
    adId: i.adId,
    createdAt: iso(i.createdAt),
    contact: i.contact ? contactRef(i.contact) : null,
    fields: i.fields,
  };
}

const CONTACT_FIELDS = (prefix: string, who: string): FieldDoc[] => [
  { name: `${prefix}.id`, type: "string", description: `Id of ${who} in the API.` },
  { name: `${prefix}.phone`, type: "string or null", description: "Phone number with country code. Null for people who message through a WhatsApp username." },
  { name: `${prefix}.bsuid`, type: "string or null", description: "WhatsApp business-scoped user id (BSUID). Always present once the person has messaged you through WhatsApp; use it as the stable key when phone is null." },
  { name: `${prefix}.waId`, type: "string or null", description: "WhatsApp id (the phone number as digits), when WhatsApp shared it." },
  { name: `${prefix}.username`, type: "string or null", description: "WhatsApp username, when known." },
  { name: `${prefix}.name`, type: "string or null", description: "Display name." },
];

const sampleContact = { id: "ckcontact1", phone: "+919876543210", bsuid: "IN.13491208655302741918", waId: "919876543210", username: null, name: "Asha" };
const SAMPLE_TIME = "2026-10-27T10:15:00.000Z";

export const EVENT_CATALOG: EventDoc[] = [
  {
    event: "message.received",
    title: "A customer sends a message",
    when: "After an incoming WhatsApp message is stored. Reactions and status updates do not use this event.",
    fields: [
      { name: "conversationId", type: "string", description: "Conversation the message belongs to." },
      { name: "channel", type: "string or null", description: "Meta phone_number_id the message came in on." },
      { name: "assignedTo", type: "string or null", description: "User id of the agent the conversation is assigned to, if any." },
      ...CONTACT_FIELDS("contact", "the contact"),
      { name: "message.id", type: "string", description: "WhatsApp message id (wamid)." },
      { name: "message.type", type: "string", description: "text, image, audio, video, document, sticker, location, contacts, button, interactive or other." },
      { name: "message.text", type: "string or null", description: "Message text or caption, when there is one." },
      { name: "message.mediaId", type: "string or null", description: "WhatsApp media id for media messages." },
      { name: "message.mimeType", type: "string or null", description: "Media type for media messages." },
      { name: "message.timestamp", type: "string", description: "When WhatsApp says the message was sent, ISO 8601." },
      { name: "referral", type: "object or null", description: "Present when the chat started from a click-to-WhatsApp ad." },
      { name: "referral.sourceType", type: "string or null", description: "ad or post." },
      { name: "referral.sourceId", type: "string or null", description: "Id of the ad or post." },
      { name: "referral.sourceUrl", type: "string or null", description: "Link of the ad or post." },
      { name: "referral.headline", type: "string or null", description: "Ad headline." },
      { name: "referral.ctwaClid", type: "string or null", description: "Click id, for conversion reporting." },
    ],
    sample: messageReceivedPayload({
      conversationId: "ckconv1",
      channel: "109876543210987",
      assignedTo: null,
      contact: sampleContact,
      message: { id: "wamid.HBgM...", type: "text", text: "Hi, is the red one in stock?", mediaId: null, mimeType: null, timestamp: SAMPLE_TIME },
      referral: { sourceType: "ad", sourceId: "120210000000000", sourceUrl: "https://fb.me/example", headline: "Spring sale", ctwaClid: "ARAk..." },
    }),
  },
  {
    event: "message.status",
    title: "A message you sent changes status",
    when: "Each time a message you sent is sent, delivered, read or fails. Statuses can arrive out of order; use timestamp.",
    fields: [
      { name: "messageId", type: "string", description: "Message id in the API." },
      { name: "conversationId", type: "string", description: "Conversation the message belongs to." },
      { name: "wamid", type: "string or null", description: "WhatsApp message id, once WhatsApp has accepted it." },
      { name: "status", type: "string", description: "sent, delivered, read or failed." },
      { name: "errorCode", type: "string or null", description: "WhatsApp error code when status is failed." },
      { name: "timestamp", type: "string", description: "ISO 8601 time of the status." },
      ...CONTACT_FIELDS("contact", "the recipient"),
    ],
    sample: messageStatusPayload({ messageId: "ckmsg1", conversationId: "ckconv1", wamid: "wamid.HBgM...", status: "delivered", errorCode: null, timestamp: SAMPLE_TIME, contact: sampleContact }),
  },
  {
    event: "template.status",
    title: "A template is reviewed",
    when: "When Meta approves, rejects, pauses or otherwise changes the review status of one of your templates.",
    fields: [
      { name: "templateId", type: "string or null", description: "Template id in the API, when the template is known here." },
      { name: "name", type: "string or null", description: "Template name." },
      { name: "language", type: "string or null", description: "Template language code." },
      { name: "category", type: "string or null", description: "marketing, utility or authentication." },
      { name: "status", type: "string", description: "approved, rejected, pending, paused or disabled." },
      { name: "reason", type: "string or null", description: "Why Meta rejected it, when it did." },
      { name: "timestamp", type: "string", description: "ISO 8601 time we recorded the change." },
    ],
    sample: templateStatusPayload({ templateId: "cktemplate1", name: "order_update", language: "en", category: "utility", status: "approved", reason: null, timestamp: SAMPLE_TIME }),
  },
  {
    event: "broadcast.completed",
    title: "A broadcast finishes",
    when: "Once every recipient of a broadcast has been processed. Delivery numbers can still grow afterwards as receipts arrive.",
    fields: [
      { name: "broadcastId", type: "string", description: "Broadcast id in the API." },
      { name: "name", type: "string or null", description: "Broadcast name." },
      { name: "templateId", type: "string or null", description: "Template the broadcast used." },
      { name: "completedAt", type: "string", description: "ISO 8601 time of completion." },
      { name: "totals.total", type: "integer", description: "Recipients in the broadcast." },
      { name: "totals.sent", type: "integer", description: "Recipients whose message WhatsApp accepted (includes delivered and read)." },
      { name: "totals.delivered", type: "integer", description: "Delivered so far (includes read)." },
      { name: "totals.read", type: "integer", description: "Read so far." },
      { name: "totals.failed", type: "integer", description: "Recipients whose message failed." },
      { name: "totals.skipped", type: "integer", description: "Recipients left out, for example because they opted out." },
    ],
    sample: broadcastCompletedPayload({
      broadcastId: "ckbroadcast1",
      name: "October offer",
      templateId: "cktemplate1",
      completedAt: SAMPLE_TIME,
      totals: { total: 120, sent: 118, delivered: 110, read: 64, failed: 2, skipped: 0 },
    }),
  },
  {
    event: "contact.opted_out",
    title: "A contact opts out",
    when: "When someone sends a STOP word, an agent marks the contact as opted out, the API marks the contact as opted out, or a chatbot unsubscribe step runs. We stop all marketing messages to them; order updates and replies to their own messages can still go, and they can send START to get offers again.",
    fields: [
      ...CONTACT_FIELDS("contact", "the contact"),
      { name: "contactId", type: "string", description: "Same as contact.id, kept for older integrations." },
      { name: "phone", type: "string or null", description: "Same as contact.phone, kept for older integrations." },
      { name: "optedOutAt", type: "string", description: "ISO 8601 time of the opt-out." },
      { name: "source", type: "string", description: "stop_keyword, dashboard, api (a compat API call set opt_in to false) or chatbot (an unsubscribe step in a chatbot flow)." },
    ],
    sample: contactOptedOutPayload({ contact: sampleContact, optedOutAt: SAMPLE_TIME, source: "stop_keyword" }),
  },
  {
    event: "conversation.status_changed",
    title: "A conversation changes status",
    when: "When a conversation moves between open, pending, solved and blocked, by an agent, the API, an automation or a customer reply that reopens it.",
    fields: [
      { name: "conversationId", type: "string", description: "Conversation id in the API." },
      { name: "contactId", type: "string or null", description: "Contact the conversation belongs to." },
      { name: "from", type: "string or null", description: "Previous status, when known." },
      { name: "to", type: "string", description: "New status." },
      { name: "changedBy", type: "string or null", description: "User id of the person who changed it. Null for automations and customer replies." },
      { name: "source", type: "string", description: "user when a person or API key changed it, system otherwise." },
      { name: "timestamp", type: "string", description: "ISO 8601 time of the change." },
    ],
    sample: conversationStatusChangedPayload({ conversationId: "ckconv1", contactId: "ckcontact1", from: "open", to: "solved", changedBy: "ckuser1", source: "user", timestamp: SAMPLE_TIME }),
  },
  {
    event: "lead.created",
    title: "A lead arrives",
    when: "When a person fills in one of your Meta lead forms, or starts a WhatsApp chat from one of your click-to-WhatsApp ads (at most once per person per ad in 30 days), and the lead is stored.",
    fields: [
      { name: "leadId", type: "string", description: "Lead id in the app." },
      { name: "status", type: "string", description: "new at creation." },
      { name: "source", type: "string", description: "meta_lead_form for a Meta lead form, ctwa for a chat started from a click-to-WhatsApp ad." },
      { name: "formId", type: "string or null", description: "Meta lead form id. Null for ctwa leads." },
      { name: "campaignId", type: "string or null", description: "Meta campaign id the lead came from, when known." },
      { name: "adId", type: "string or null", description: "Meta ad id the lead came from (for ctwa, the ad or post the chat started from)." },
      { name: "createdAt", type: "string", description: "ISO 8601 time the person submitted the form or started the chat." },
      { name: "contact", type: "object or null", description: "The contact created or matched for this lead: the person who wrote for ctwa leads, or the form's phone number." },
      ...CONTACT_FIELDS("contact", "the contact").map((f) => f),
      { name: "fields", type: "object", description: "The form answers, as field name to text. For ctwa leads: source (click_to_whatsapp), and ad_headline and ad_link when the ad had them." },
    ],
    sample: leadCreatedPayload({
      leadId: "cklead1",
      status: "new",
      formId: "5550001112223",
      campaignId: "120210000000001",
      adId: "120210000000002",
      createdAt: SAMPLE_TIME,
      contact: sampleContact,
      fields: { full_name: "Asha", phone_number: "+919876543210", city: "Pune" },
    }),
  },
];

export const eventDoc = (event: string): EventDoc | undefined => EVENT_CATALOG.find((e) => e.event === event);

/** Every dotted path to a leaf value of an object, with arrays and nulls as leaves. Used to check docs against samples. */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return prefix ? [prefix] : [];
}
