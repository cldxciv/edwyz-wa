import { createHash } from "node:crypto";

export type ConversionEventName = "Lead" | "QualifiedLead" | "Purchase" | "Contact";

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function hashEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalised = email.trim().toLowerCase();
  return normalised.includes("@") ? sha256(normalised) : null;
}

/** Digits only, no plus sign and no leading zeros, as the E.164 number without the "+". */
export function hashPhone(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 7 && digits.length <= 15 ? sha256(digits) : null;
}

/** Deterministic: the same lead or contact and event name always produce the same id, so Meta deduplicates repeats. */
export function conversionEventId(tenantId: string, subjectId: string, eventName: string): string {
  return sha256(`${tenantId}:${subjectId}:${eventName}`).slice(0, 40);
}

export type PayloadInput = {
  tenantId: string;
  subjectId: string;
  eventName: ConversionEventName;
  eventTime: Date;
  email?: string | null;
  phone?: string | null;
  ctwaClid?: string | null;
  wabaId?: string | null;
  /** The lead's id on Meta (the leadgen id of a lead ad). A click-to-WhatsApp lead has none. */
  leadgenId?: string | null;
};

/** A Meta lead id is numeric; Edwyz's own keys (ctwa:...) are never sent as one. */
export const metaLeadId = (leadgenId: string | null | undefined): string | null => (typeof leadgenId === "string" && /^\d{1,32}$/.test(leadgenId) ? leadgenId : null);

/**
 * The event name Meta gets. Edwyz keeps one name per stage ("Lead" is a new lead); business messaging events (a chat from a
 * click-to-WhatsApp ad) name a new lead "LeadSubmitted". QualifiedLead and Purchase are the same on both.
 */
export function metaEventName(eventName: ConversionEventName, messaging: boolean): string {
  return messaging && eventName === "Lead" ? "LeadSubmitted" : eventName;
}

/*
 * UNCONFIRMED against live Meta: verify every field name against the current Conversions API for business messaging docs before launch:
 * action_source "business_messaging" with messaging_channel "whatsapp" and user_data.ctwa_clid for click-to-WhatsApp
 * conversations; "system_generated" otherwise (messaging_channel is sent only with business_messaging). user_data.em / ph are SHA-256 hex arrays; the event name mapping for
 * QualifiedLead may need to be a custom event or "LeadSubmitted" depending on the dataset type.
 * VERIFY live that Meta accepts "LeadSubmitted" (metaEventName) for a new lead from a click-to-WhatsApp chat.
 * A lead-ad lead (Conversion Leads, CRM integration) also carries user_data.lead_id (the leadgen id) and custom_data
 * { event_source: "crm", lead_event_source: "Edwyz" }, so Meta can tie each stage (Lead, QualifiedLead, Purchase) to the lead.
 */
export function buildConversionPayload(input: PayloadInput) {
  const em = hashEmail(input.email);
  const ph = hashPhone(input.phone);
  const userData: Record<string, unknown> = {};
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (input.ctwaClid) userData.ctwa_clid = input.ctwaClid;
  if (input.wabaId) userData.whatsapp_business_account_id = input.wabaId;
  const leadId = metaLeadId(input.leadgenId);
  if (leadId) userData.lead_id = leadId;
  const messaging = Boolean(input.ctwaClid);
  return {
    data: [
      {
        event_name: metaEventName(input.eventName, messaging),
        event_time: Math.floor(input.eventTime.getTime() / 1000),
        // Keyed on Edwyz's own name, so the id of an event never changes with the name Meta gets.
        event_id: conversionEventId(input.tenantId, input.subjectId, input.eventName),
        action_source: messaging ? "business_messaging" : "system_generated",
        ...(messaging ? { messaging_channel: "whatsapp" } : {}),
        user_data: userData,
        ...(leadId ? { custom_data: { event_source: "crm", lead_event_source: "Edwyz" } } : {}),
      },
    ],
  };
}

export const hasIdentifiers = (payload: ReturnType<typeof buildConversionPayload>) => Object.keys(payload.data[0].user_data).length > 0;
