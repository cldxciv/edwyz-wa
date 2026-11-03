import type { Prisma } from "@/generated/prisma/client";
import { receivableWhere, type SendKind } from "@/lib/contacts/opt-out";
import { prisma } from "@/lib/db";
import { type AudienceSpec, NOT_BLOCKED, countMatching, matchingContactIds, resolveFilters, specFromJson } from "@/lib/segments/service";

/**
 * Opted-in, not opted-out, not blocked, and (when tags are given) carrying ANY of the tags. Counting, previews, cost estimates and
 * the frozen audience all start from this, so a blocked contact is never counted or messaged; one blocked after the audience was
 * frozen is skipped at send time with the code "blocked" (process.ts). The opt-out filter is the marketing one (lib/contacts/opt-out.ts)
 * unless a caller passes the template's kind; a broadcast needs a recorded opt-in for every template anyway, and an opt-out clears it.
 */
export function audienceWhere(tenantId: string, segmentTags: string[], kind: SendKind = "marketing"): Prisma.ContactWhereInput {
  return {
    tenantId,
    optIn: true,
    ...receivableWhere(kind),
    ...NOT_BLOCKED,
    ...(segmentTags.length ? { tags: { hasSome: segmentTags } } : {}),
  };
}

/** A fixed audience is a list of recipients copied from another broadcast (retry with another template, follow-up). It is never recomputed. */
export function isFixedAudience(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { fixed?: unknown }).fixed === true;
}

export { specFromJson };
export type { AudienceSpec };

export async function countAudience(tenantId: string, segmentTags: string[], spec?: AudienceSpec | null): Promise<number> {
  const base = audienceWhere(tenantId, segmentTags);
  if (!spec?.segmentId && !spec?.filter) return prisma.contact.count({ where: base });
  return countMatching(tenantId, base, await resolveFilters(tenantId, spec));
}

/** Snapshots the audience into BroadcastRecipient rows. Safe to call twice: the unique key skips existing rows. */
export async function freezeAudience(tenantId: string, broadcastId: string, segmentTags: string[], spec?: AudienceSpec | null): Promise<number> {
  const base = audienceWhere(tenantId, segmentTags);
  const filters = await resolveFilters(tenantId, spec);
  const ids = await matchingContactIds(tenantId, base, filters);
  for (let i = 0; i < ids.length; i += 5000) {
    await prisma.broadcastRecipient.createMany({
      data: ids.slice(i, i + 5000).map((contactId) => ({ tenantId, broadcastId, contactId })),
      skipDuplicates: true,
    });
  }
  return prisma.broadcastRecipient.count({ where: { tenantId, broadcastId } });
}
