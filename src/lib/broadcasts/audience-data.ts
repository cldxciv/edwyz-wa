import { prisma } from "@/lib/db";
import { audienceWhere, isFixedAudience, specFromJson } from "./audience";
import { matchingContactsForMapping, matchingPhones, resolveFilters } from "@/lib/segments/service";
import { countryProbe } from "./country";
import type { MappableContact } from "./mapping";

export type AudienceBroadcast = { id: string; tenantId: string; segmentTags: string[]; audienceFilter: unknown };

const MAPPING_SAMPLE = 5000;
const PHONE_CAP = 200_000;

async function frozenCount(b: AudienceBroadcast) {
  return prisma.broadcastRecipient.count({ where: { tenantId: b.tenantId, broadcastId: b.id } });
}

/** Contacts to test a value mapping against: the frozen recipients once the broadcast has started, otherwise today's matching audience. */
export async function audienceContacts(b: AudienceBroadcast, limit = MAPPING_SAMPLE): Promise<{ total: number; contacts: MappableContact[] }> {
  const frozen = await frozenCount(b);
  if (frozen > 0 || isFixedAudience(b.audienceFilter)) {
    const contacts = await prisma.contact.findMany({
      where: { tenantId: b.tenantId, broadcastRecipients: { some: { broadcastId: b.id, tenantId: b.tenantId } } },
      take: limit,
      select: { name: true, phone: true, attributes: true },
    });
    return { total: frozen, contacts };
  }
  const filters = await resolveFilters(b.tenantId, specFromJson(b.audienceFilter));
  return matchingContactsForMapping(b.tenantId, audienceWhere(b.tenantId, b.segmentTags), filters, limit);
}

/** A phone-like string for everyone in the audience (capped), for the per-country cost estimate. BSUID-only contacts count by the country in their BSUID. */
export async function audiencePhones(b: AudienceBroadcast): Promise<string[]> {
  const frozen = await frozenCount(b);
  if (frozen > 0 || isFixedAudience(b.audienceFilter)) {
    const rows = await prisma.contact.findMany({
      where: { tenantId: b.tenantId, broadcastRecipients: { some: { broadcastId: b.id, tenantId: b.tenantId } } },
      take: PHONE_CAP,
      select: { phone: true, bsuid: true },
    });
    return rows.map(countryProbe);
  }
  const filters = await resolveFilters(b.tenantId, specFromJson(b.audienceFilter));
  return matchingPhones(b.tenantId, audienceWhere(b.tenantId, b.segmentTags), filters);
}
