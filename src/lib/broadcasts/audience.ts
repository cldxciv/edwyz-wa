import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { type AudienceSpec, countMatching, matchingContactIds, resolveFilters, specFromJson } from "@/lib/segments/service";

/** Opted-in, not opted-out, and (when tags are given) carrying ANY of the tags. */
export function audienceWhere(tenantId: string, segmentTags: string[]): Prisma.ContactWhereInput {
  return {
    tenantId,
    optIn: true,
    optedOutAt: null,
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
