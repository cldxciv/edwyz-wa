import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

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

/** Stores the referral on the conversation once. Never overwrites an existing one. Returns true when it was stored. */
export async function captureReferral(tenantId: string, conversationId: string, referral: unknown): Promise<boolean> {
  const normalised = normaliseReferral(referral);
  if (!normalised) return false;
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, tenantId, referral: { equals: Prisma.DbNull } },
    data: { referral: normalised },
  });
  return result.count > 0;
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
