import { emitEvent } from "@/lib/integrations/events";
import { contactOptedOutPayload } from "@/lib/integrations/payloads";
import type { Prisma } from "@/generated/prisma/client";
import { emitAttributeChanges, emitAutomationEvent, emitTagChanges } from "@/lib/automation/v2/emit";
import { assertWithinLimit } from "@/lib/billing";
import { prisma } from "@/lib/db";
import { forgetContact } from "@/lib/promote/forget";
import { type Actor, HttpError, requireRole } from "@/lib/tenancy";
import { contactWhereForSegment } from "@/lib/segments/service";
import { identitySearchFilter } from "./identity";
import { recordConsent, recordConsentWithdrawn } from "./consent";
import { normalizePhone } from "./phone";

export type ContactInput = {
  phone: string;
  name?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  optIn?: boolean;
  optInSource?: string;
};

export type ContactPatch = {
  name?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  optIn?: boolean;
  optInSource?: string;
};

const MAX_PAGE = 100;

export async function listContacts(
  actor: Actor,
  query: { q?: string; tag?: string; segmentId?: string; cursor?: string; limit?: number; maskedPhone?: boolean; scope?: Record<string, unknown> | null },
) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE);
  const where: Prisma.ContactWhereInput = { tenantId: actor.tenantId };
  const and: Prisma.ContactWhereInput[] = [];
  if (query.segmentId) and.push(await contactWhereForSegment(actor.tenantId, query.segmentId));
  if (query.scope) and.push(query.scope as Prisma.ContactWhereInput);
  if (and.length) where.AND = and;
  if (query.tag) where.tags = { has: query.tag };
  if (query.q) where.OR = identitySearchFilter(query.q.slice(0, 100), { maskedPhone: query.maskedPhone }) as Prisma.ContactWhereInput[];
  const cursor = query.cursor && (await prisma.contact.findFirst({ where: { id: query.cursor, tenantId: actor.tenantId }, select: { id: true } })) ? query.cursor : undefined;
  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function createContact(actor: Actor, input: ContactInput, now = new Date()) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number.");
  if (input.optIn) requireRole(actor, "admin");
  if (input.optIn && !input.optInSource) throw new HttpError(400, "optInSource is required when optIn is true.");
  const existing = await prisma.contact.findFirst({ where: { tenantId: actor.tenantId, phone }, select: { id: true } });
  if (existing) throw new HttpError(409, "A contact with this phone number already exists.");
  await assertWithinLimit(actor.tenantId, "contacts");
  const created = await prisma.contact.create({
    data: {
      tenantId: actor.tenantId,
      phone,
      name: input.name,
      tags: input.tags ?? [],
      attributes: (input.attributes ?? {}) as Prisma.InputJsonObject,
      ...(input.optIn ? { optIn: true, optInSource: input.optInSource, optInAt: now } : {}),
    },
  });
  if (created?.id) void emitAutomationEvent({ type: "contact_created", tenantId: actor.tenantId, contactId: created.id });
  if (created?.id && input.optIn && input.optInSource) await recordConsent(actor, created.id, { source: input.optInSource });
  return created;
}

export async function updateContact(actor: Actor, id: string, patch: ContactPatch, now = new Date()) {
  const contact = await prisma.contact.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!contact) throw new HttpError(404, "Contact not found.");
  const data: Prisma.ContactUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.tags !== undefined) data.tags = patch.tags;
  if (patch.attributes !== undefined) data.attributes = patch.attributes as Prisma.InputJsonObject;
  if (patch.optIn === true) {
    requireRole(actor, "admin");
    if (!patch.optInSource) throw new HttpError(400, "optInSource is required when optIn is true.");
    if (contact.optedOutAt) throw new HttpError(409, "This contact opted out of marketing messages. Only they can opt in again, by sending START to your WhatsApp number.");
    if (!contact.optIn) Object.assign(data, { optIn: true, optInSource: patch.optInSource, optInAt: now });
  } else if (patch.optIn === false) {
    // An opt-out, not only a withdrawn marketing consent: like STOP, optedOutAt stops marketing until the customer sends START.
    // Order updates (utility templates), login codes and replies to their own messages still go (lib/contacts/opt-out.ts).
    Object.assign(data, { optIn: false, optedOutAt: contact.optedOutAt ?? now });
  }
  const { count } = await prisma.contact.updateMany({ where: { id: contact.id, tenantId: actor.tenantId }, data: data as Prisma.ContactUpdateManyMutationInput });
  if (count === 0) throw new HttpError(404, "Contact not found.");
  const updated = await prisma.contact.findFirstOrThrow({ where: { id: contact.id, tenantId: actor.tenantId } });
  if (patch.optIn === true && !contact.optIn && patch.optInSource) await recordConsent(actor, contact.id, { source: patch.optInSource });
  else if (patch.optIn === false && contact.optIn) {
    await recordConsentWithdrawn(actor, contact.id);
    if (!contact.optedOutAt) await emitEvent(actor.tenantId, "contact.opted_out", contactOptedOutPayload({ contact: updated, optedOutAt: updated.optedOutAt ?? now, source: "dashboard" }));
  }
  const base = { tenantId: actor.tenantId, contactId: contact.id };
  if (patch.tags !== undefined) void emitTagChanges(base, contact.tags, updated.tags);
  if (patch.attributes !== undefined) void emitAttributeChanges(base, contact.attributes as Record<string, unknown>, updated.attributes as Record<string, unknown>);
  return updated;
}

export async function deleteContact(actor: Actor, id: string) {
  // Out of the workspace's customer-list audiences on Meta first, while the email and phone can still be read; a failure stops
  // the delete so it can run again (docs/IG-PAGE-ADS-SPEC.md 5.5, promote/forget.ts).
  await forgetContact(actor.tenantId, id);
  const result = await prisma.contact.deleteMany({ where: { id, tenantId: actor.tenantId } });
  if (result.count === 0) throw new HttpError(404, "Contact not found.");
}
