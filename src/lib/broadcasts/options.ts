import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/tenancy";
import { presetSegments } from "@/lib/segments/presets";
import { type AudienceSpec, knownAttributeKeys, previewMatching, resolveFilters } from "@/lib/segments/service";
import { audienceWhere, countAudience } from "./audience";
import { portfolioPhones } from "./portfolio";
import { topTier } from "./throttle";

const TAG_SCAN_LIMIT = 5000;

/** Data the broadcast wizard needs: the tenant's numbers, known tags, saved segments, attribute names and the live eligible-contact count. */
export async function broadcastOptions(actor: Actor, segmentTags: string[], spec?: AudienceSpec | null) {
  const [phoneNumbers, tagRows, eligible, segments, attributeKeys] = await Promise.all([
    prisma.phoneNumber.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { createdAt: "asc" },
      select: { id: true, wabaRefId: true, displayPhone: true, verifiedName: true, qualityRating: true, messagingLimitTier: true, status: true },
    }),
    prisma.contact.findMany({ where: { tenantId: actor.tenantId, tags: { isEmpty: false } }, select: { tags: true }, take: TAG_SCAN_LIMIT }),
    countAudience(actor.tenantId, segmentTags, spec),
    prisma.segment.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" }, take: 100, select: { id: true, name: true } }),
    knownAttributeKeys(actor.tenantId),
  ]);
  const tags = [...new Set(tagRows.flatMap((r) => r.tags))].sort();
  // Meta's limit is shared by the whole portfolio: show every number the portfolio's tier (the highest any of its numbers reports).
  const portfolioTiers = new Map<string, string | null>();
  for (const wabaRefId of new Set(phoneNumbers.map((p) => p.wabaRefId))) {
    portfolioTiers.set(wabaRefId, topTier(await portfolioPhones(actor.tenantId, wabaRefId).catch(() => phoneNumbers.filter((p) => p.wabaRefId === wabaRefId))));
  }
  return { phoneNumbers: phoneNumbers.map(({ wabaRefId, ...p }) => ({ ...p, portfolioTier: portfolioTiers.get(wabaRefId) ?? null })), tags, eligibleCount: eligible, segments, presets: presetSegments().map(({ id, name, description }) => ({ id, name, description })), attributeKeys };
}

/** Who a tag + segment + filter combination reaches among opted-in contacts: the count and a few examples. */
export async function audiencePreview(actor: Actor, segmentTags: string[], spec: AudienceSpec) {
  const filters = await resolveFilters(actor.tenantId, spec);
  return previewMatching(actor.tenantId, audienceWhere(actor.tenantId, segmentTags), filters);
}
