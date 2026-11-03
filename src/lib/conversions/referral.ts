import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { emitLeadCreated } from "@/lib/integrations/emitters";
import { queueConversion } from "./index";

export type Referral = {
  sourceType?: string;
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  ctwaClid?: string;
};

const LIMITS = { sourceType: 32, sourceId: 128, sourceUrl: 1024, headline: 300, body: 1000, ctwaClid: 512 } as const;

const FIELD_ALIASES: Record<keyof Referral, string[]> = {
  sourceType: ["source_type", "sourceType"],
  sourceId: ["source_id", "sourceId"],
  sourceUrl: ["source_url", "sourceUrl"],
  headline: ["headline"],
  body: ["body"],
  ctwaClid: ["ctwa_clid", "ctwaClid"],
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARS, " ").trim().slice(0, max);
  return cleaned || undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Keeps only known string fields (snake_case from the webhook or camelCase), caps lengths, drops non-http source URLs. Returns null when nothing identifies an ad. */
export function normaliseReferral(raw: unknown): Referral | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Referral = {};
  for (const key of Object.keys(FIELD_ALIASES) as (keyof Referral)[]) {
    const alias = FIELD_ALIASES[key].find((name) => input[name] !== undefined);
    const value = alias ? cleanString(input[alias], LIMITS[key]) : undefined;
    if (value) out[key] = value;
  }
  if (out.sourceUrl && !isHttpUrl(out.sourceUrl)) delete out.sourceUrl;
  if (!out.sourceId && !out.ctwaClid && !out.sourceUrl) return null;
  return out;
}

/** Pure: extracts the click-to-WhatsApp referral from a raw inbound webhook message object (messages[i]). */
export function parseReferral(message: unknown): Referral | null {
  if (!message || typeof message !== "object") return null;
  return normaliseReferral((message as { referral?: unknown }).referral);
}

/**
 * Stores the referral on the conversation once (never overwrites an existing one), then records the click-to-WhatsApp lead
 * (recordCtwaLead). Returns true when the referral was stored. A lead that cannot be recorded never stops the message.
 */
export async function captureReferral(tenantId: string, conversationId: string, referral: unknown): Promise<boolean> {
  const normalised = normaliseReferral(referral);
  if (!normalised) return false;
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, tenantId, referral: { equals: Prisma.DbNull } },
    data: { referral: normalised },
  });
  await recordCtwaLead(tenantId, conversationId, normalised).catch(() => console.error("[conversions] could not record a click-to-WhatsApp lead"));
  return result.count > 0;
}

/** One lead per contact per ad (or post) in this many days, so repeat clicks on the same ad do not count again (IG spec D14). */
export const CTWA_LEAD_WINDOW_MS = 30 * 86_400_000;
export const CTWA_LEADGEN_PREFIX = "ctwa:";

/** A click-to-WhatsApp lead has no Meta lead id: its key is the click id, else the ad, the contact and the 30-day window. */
export function ctwaLeadgenId(referral: Referral, contactId: string, now: Date): string {
  if (referral.ctwaClid) return `${CTWA_LEADGEN_PREFIX}${referral.ctwaClid}`;
  return `${CTWA_LEADGEN_PREFIX}${referral.sourceId ?? "unknown"}:${contactId}:${Math.floor(now.getTime() / CTWA_LEAD_WINDOW_MS)}`;
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown })?.code === "P2002";

/**
 * A chat that started from an ad (a referral that names the ad or post) becomes a Lead with source ctwa, at most one per
 * contact per ad per 30 days, and a "Lead" conversion is queued for it (delivered with the click id, so Meta can match it
 * to the ad). The lead gets the chat's current owner; nothing is routed and no lead sequence starts here, because the
 * customer is already chatting and the normal inbound flow (bots, AI, routing) runs right after. Returns the new lead id.
 * Integrations hear of it through lead.created with source ctwa (and no form id). A failed webhook never undoes the lead.
 */
export async function recordCtwaLead(tenantId: string, conversationId: string, referral: Referral, now = new Date()): Promise<string | null> {
  if (!referral.sourceId && !referral.ctwaClid) return null;
  const chat = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { contactId: true, assignedToId: true } });
  if (!chat?.contactId) return null;
  const adMetaId = referral.sourceId ?? null;
  const recent = await prisma.lead.findFirst({
    where: { tenantId, contactId: chat.contactId, adMetaId, leadgenId: { startsWith: CTWA_LEADGEN_PREFIX }, createdAt: { gte: new Date(now.getTime() - CTWA_LEAD_WINDOW_MS) } },
    select: { id: true },
  });
  if (recent) return null;
  // The campaign is known for Edwyz's own ads; an ad made in Ads Manager keeps only its id.
  const ad = adMetaId && referral.sourceType !== "post" ? await prisma.ad.findFirst({ where: { tenantId, metaAdId: adMetaId }, select: { adSet: { select: { campaign: { select: { metaCampaignId: true } } } } } }) : null;
  const fields: Record<string, string> = { source: "click_to_whatsapp" };
  if (referral.headline) fields.ad_headline = referral.headline;
  if (referral.sourceUrl) fields.ad_link = referral.sourceUrl;
  const leadgenId = ctwaLeadgenId(referral, chat.contactId, now);
  const campaignMetaId = ad?.adSet?.campaign?.metaCampaignId ?? null;
  let lead: { id: string; status?: string };
  try {
    lead = await prisma.lead.create({
      data: {
        tenantId,
        leadFormId: null,
        leadgenId,
        contactId: chat.contactId,
        fields,
        campaignMetaId,
        adMetaId,
        assignedToId: chat.assignedToId ?? null,
        createdAt: now,
      },
      select: { id: true, status: true },
    });
  } catch (e) {
    // The same click delivered twice: the first one already made the lead.
    if (isUniqueViolation(e)) return null;
    throw e;
  }
  await queueConversion(tenantId, { leadId: lead.id, contactId: chat.contactId, eventName: "Lead", eventTime: now });
  await emitLeadCreated(tenantId, { id: lead.id, status: lead.status ?? "new", leadgenId, fields, campaignMetaId, adMetaId, createdAt: now, contactId: chat.contactId, leadFormId: null }).catch(() =>
    console.error("[conversions] could not emit the lead.created event for a click-to-WhatsApp lead"),
  );
  return lead.id;
}

export type ReferralFilter = { sourceId?: string; sourceType?: string; from?: Date; to?: Date; limit?: number };

function sourceWhere(tenantId: string, filter: ReferralFilter): Prisma.ConversationWhereInput {
  const and: Prisma.ConversationWhereInput[] = [{ referral: { not: Prisma.DbNull } }];
  if (filter.sourceId) and.push({ referral: { path: ["sourceId"], equals: filter.sourceId } });
  if (filter.sourceType) and.push({ referral: { path: ["sourceType"], equals: filter.sourceType } });
  const createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) };
  return { tenantId, AND: and, ...(filter.from || filter.to ? { createdAt } : {}) };
}

/** Conversations that started from an ad, newest first, for reports. */
export async function listConversationsByAdSource(tenantId: string, filter: ReferralFilter = {}) {
  const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  return prisma.conversation.findMany({
    where: sourceWhere(tenantId, filter),
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, contactId: true, status: true, referral: true, createdAt: true },
  });
}

export type SourceCount = { sourceId: string; sourceType: string | null; headline: string | null; conversations: number };

/** Conversation counts per ad source (capped scan of the most recent 5000 ad conversations). */
export async function countConversationsByAdSource(tenantId: string, filter: ReferralFilter = {}): Promise<SourceCount[]> {
  const rows = await prisma.conversation.findMany({
    where: sourceWhere(tenantId, filter),
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { referral: true },
  });
  const counts = new Map<string, SourceCount>();
  for (const row of rows) {
    const ref = (row.referral ?? {}) as Referral;
    const key = ref.sourceId ?? "unknown";
    const entry = counts.get(key) ?? { sourceId: key, sourceType: ref.sourceType ?? null, headline: ref.headline ?? null, conversations: 0 };
    entry.conversations += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.conversations - a.conversations);
}
