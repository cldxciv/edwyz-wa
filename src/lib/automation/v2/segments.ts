import { prisma } from "@/lib/db";
import { type ContactSnapshot, filterMatches, isEmptyFilter, parseFilter, SNAPSHOT_SELECT } from "@/lib/segments/filter";

/*
 * Segment membership for the "is in segment" condition. Segments are saved by the segments service in its own filter
 * format ({ all, any } of { field, op, value }), so this file only loads the contact and asks that service's evaluator.
 * A saved filter that can no longer be read, or one with no conditions, never matches: "not a member" is the safe answer.
 */

export function contactInSegment(filter: unknown, contact: ContactSnapshot, now = new Date()): boolean {
  try {
    const parsed = parseFilter(filter);
    return !isEmptyFilter(parsed) && filterMatches(contact, parsed, now);
  } catch {
    return false;
  }
}

async function loadSnapshot(tenantId: string, contactId: string): Promise<ContactSnapshot | null> {
  const row = await prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { ...SNAPSHOT_SELECT, conversations: { select: { lastInboundAt: true } } } });
  if (!row) return null;
  const { conversations, ...rest } = row;
  const times = (conversations ?? []).map((c) => c.lastInboundAt?.getTime() ?? 0).filter(Boolean);
  return { ...rest, lastInboundAt: times.length ? new Date(Math.max(...times)) : null };
}

/** Which of the given segments the contact belongs to. */
export async function segmentMembership(tenantId: string, contactId: string, ids: string[], now = new Date()): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [segments, snapshot] = await Promise.all([
    prisma.segment.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, filter: true } }),
    loadSnapshot(tenantId, contactId),
  ]);
  if (!snapshot) return new Set();
  return new Set(segments.filter((s) => contactInSegment(s.filter, snapshot, now)).map((s) => s.id));
}
