import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { identitySearchFilter } from "@/lib/contacts/identity";
import { deleteContact, updateContact } from "@/lib/contacts/service";
import { prisma } from "@/lib/db";
import { upsertContactV1 } from "@/lib/integrations/v1-service";
import { HttpError } from "@/lib/tenancy";
import {
  contactView, currentAttributes, findContact, isObject, mergeAttributes, pageJson, parseCustomParams, parseName, parsePaging, parseTags, requireContact, toE164,
} from "./common";
import type { Handler } from "./runtime";

function listFilter(tenantId: string, query: URLSearchParams): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { tenantId };
  const tag = query.get("tag");
  if (tag) where.tags = { has: tag };
  const search = query.get("search")?.slice(0, 100);
  if (search) {
    where.OR = identitySearchFilter(search) as Prisma.ContactWhereInput[];
  }
  return where;
}

export const countContacts: Handler = async ({ actor, query }) => ({ json: { count: await prisma.contact.count({ where: listFilter(actor.tenantId, query) }) } });

export const removeContact: Handler = async ({ actor, params }) => {
  const contact = await requireContact(actor.tenantId, params.target);
  await deleteContact(actor, contact.id);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "compat.contact.deleted", target: contact.id });
  return { json: {} };
};

export const listContacts: Handler = async ({ actor, query }) => {
  const paging = parsePaging(query);
  const where = listFilter(actor.tenantId, query);
  const [rows, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: paging.skip, take: paging.take }),
    prisma.contact.count({ where }),
  ]);
  return { json: pageJson("contact_list", rows.map(contactView), paging, total) };
};

export const getContact: Handler = async ({ actor, params }) => ({ json: { contact: contactView(await requireContact(actor.tenantId, params.target)) } });

function externalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new HttpError(400, "external_id must be a non-empty string up to 200 characters.");
  return value.trim();
}

/**
 * external_id is how callers find a contact again (external_id:<value> in a path), so two contacts of one workspace must never share one.
 * It can arrive as a custom_params item as well as in the external_id field; both ways are checked here. Setting it to null removes it.
 */
async function guardExternalId(tenantId: string, incoming: Record<string, unknown>, selfId: string | null): Promise<void> {
  if (!("external_id" in incoming) || incoming.external_id === null) return;
  const value = externalId(incoming.external_id);
  if (value === undefined) return;
  incoming.external_id = value;
  const other = await findContact(tenantId, `external_id:${value}`);
  if (other && other.id !== selfId) throw new HttpError(409, "A contact with this external_id already exists.");
}

export const createContact: Handler = async ({ actor, body }) => {
  const input = await body();
  if (typeof input.phone_number !== "string" || !toE164(input.phone_number)) {
    throw new HttpError(400, "phone_number is required and must include the country code.");
  }
  const phone = toE164(input.phone_number) as string;
  const attributes: Record<string, unknown> = input.custom_params === undefined ? {} : mergeAttributes({}, parseCustomParams(input.custom_params));
  const ext = externalId(input.external_id);
  if (ext) attributes.external_id = ext;
  await guardExternalId(actor.tenantId, attributes, null);

  if (await findContact(actor.tenantId, phone)) throw new HttpError(409, "A contact with this phone number already exists.");
  if (ext && (await findContact(actor.tenantId, `external_id:${ext}`))) throw new HttpError(409, "A contact with this external_id already exists.");

  const result = await upsertContactV1(actor, {
    phone,
    ...(input.name !== undefined ? { name: parseName(input.name) } : {}),
    ...(input.tags !== undefined ? { tags: parseTags(input.tags) } : {}),
    attributes,
    ...(input.opt_in !== undefined ? { optIn: input.opt_in } : {}),
    ...(input.opt_in_source !== undefined ? { optInSource: input.opt_in_source } : {}),
  });
  const created = await prisma.contact.findFirst({ where: { id: result.contact.id, tenantId: actor.tenantId } });
  return { status: 201, json: { contact: contactView(created ?? (result.contact as never)) } };
};

type Patch = { name?: string; tags?: string[]; attributes?: Record<string, unknown> };

async function apply(actor: Parameters<Handler>[0]["actor"], target: string, build: (current: Awaited<ReturnType<typeof requireContact>>) => Patch, incoming?: Record<string, unknown>) {
  const contact = await requireContact(actor.tenantId, target);
  if (incoming) await guardExternalId(actor.tenantId, incoming, contact.id);
  const updated = await updateContact(actor, contact.id, build(contact));
  return { json: { contact: contactView(updated) } };
}

export const putContact: Handler = async ({ actor, params, body }) => {
  const input = await body();
  const patch: Patch = {};
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.tags !== undefined) patch.tags = parseTags(input.tags);
  const incoming = input.custom_params === undefined ? undefined : parseCustomParams(input.custom_params);
  if (Object.keys(patch).length === 0 && !incoming) throw new HttpError(400, "Send at least one of name, tags or custom_params.");
  return apply(actor, params.target, (c) => ({ ...patch, ...(incoming ? { attributes: mergeAttributes(currentAttributes(c), incoming) } : {}) }), incoming);
};

export const addTags: Handler = async ({ actor, params, body }) => {
  const input = await body();
  const add = parseTags(input.tags);
  if (add.length === 0) throw new HttpError(400, "tags must contain at least one tag.");
  return apply(actor, params.target, (c) => ({ tags: parseTags([...new Set([...c.tags, ...add])]) }));
};

export const removeTag: Handler = async ({ actor, params }) => apply(actor, params.target, (c) => ({ tags: c.tags.filter((t) => t !== params.tag) }));

export const putAttributes: Handler = async ({ actor, params, body }) => {
  const input = await body();
  if (!isObject(input) || input.custom_params === undefined) throw new HttpError(400, "custom_params is required.");
  const incoming = parseCustomParams(input.custom_params);
  return apply(actor, params.target, (c) => ({ attributes: mergeAttributes(currentAttributes(c), incoming) }), incoming);
};
