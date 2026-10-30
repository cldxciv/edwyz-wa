import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { GraphError, graphFetch } from "@/lib/graph";
import { type Actor, HttpError } from "@/lib/tenancy";
import { mapMetaStatus } from "./status";
import { type HeaderMedia, mediaTypeForMime } from "./upload";
import { type TemplateInput, validateTemplateInput } from "./validate";

type MetaTemplate = {
  id?: string;
  name: string;
  language: string;
  category?: string;
  status?: string;
  components?: unknown[];
  rejected_reason?: string;
};
type MetaPage = { data?: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } };

const MAX_PAGES = 50;

/** The WABA always comes from the actor's tenant, never from the request. */
async function tenantWaba(tenantId: string) {
  const waba = await prisma.waba.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  if (!waba) throw new HttpError(409, "Connect a WhatsApp Business account first.");
  return waba;
}

export async function listTemplates(actor: Actor, filter: { status?: string } = {}) {
  return prisma.template.findMany({
    where: { tenantId: actor.tenantId, ...(filter.status ? { status: filter.status as never } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/** The sample file behind a media header, derived from the validated components (the handle Meta gave) plus what the editor knew about the file. */
export function headerMediaFrom(components: unknown, raw: unknown): HeaderMedia | null {
  const header = (Array.isArray(components) ? components : []).find((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "HEADER") as
    | { format?: unknown; example?: { header_handle?: unknown[] } }
    | undefined;
  const format = typeof header?.format === "string" ? header.format.toUpperCase() : "";
  const handle = header?.example?.header_handle?.[0];
  if (!["IMAGE", "VIDEO", "DOCUMENT"].includes(format) || typeof handle !== "string") return null;
  const hint = (raw && typeof raw === "object" ? (raw as { headerMedia?: { mime?: unknown; filename?: unknown } }).headerMedia : undefined) ?? {};
  const mime = typeof hint.mime === "string" && mediaTypeForMime(hint.mime) === format ? hint.mime.split(";")[0].trim().toLowerCase() : undefined;
  const filename = typeof hint.filename === "string" ? hint.filename.slice(0, 80) : undefined;
  return { type: format as HeaderMedia["type"], handle, ...(mime ? { mime } : {}), ...(filename ? { filename } : {}) };
}

export async function createTemplate(actor: Actor, raw: unknown) {
  const input: TemplateInput = validateTemplateInput(raw);
  const headerMedia = headerMediaFrom(input.components, raw);
  const waba = await tenantWaba(actor.tenantId);
  const duplicate = await prisma.template.findFirst({
    where: { tenantId: actor.tenantId, wabaRefId: waba.id, name: input.name, language: input.language },
    select: { id: true },
  });
  if (duplicate) throw new HttpError(409, "A template with this name and language already exists.");
  return prisma.template.create({
    data: {
      tenantId: actor.tenantId,
      wabaRefId: waba.id,
      name: input.name,
      language: input.language,
      category: input.category,
      status: "draft",
      components: input.components as Prisma.InputJsonValue,
      ...(headerMedia ? { headerMedia: headerMedia as unknown as Prisma.InputJsonObject } : {}),
    },
  });
}

const COPY_SUFFIX = /_copy\d*$/;

/** A draft copy of any template (for example to fix a rejected one). The name gets _copy, _copy2 ... so it never clashes. */
export async function duplicateTemplate(actor: Actor, id: string) {
  const source = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!source) throw new HttpError(404, "Template not found.");
  const root = source.name.replace(COPY_SUFFIX, "").slice(0, 500);
  const taken = new Set(
    (await prisma.template.findMany({ where: { tenantId: actor.tenantId, wabaRefId: source.wabaRefId, language: source.language, name: { startsWith: root } }, select: { name: true }, take: 100 })).map((t) => t.name),
  );
  let name = `${root}_copy`;
  for (let n = 2; taken.has(name); n++) name = `${root}_copy${n}`;
  return prisma.template.create({
    data: {
      tenantId: actor.tenantId,
      wabaRefId: source.wabaRefId,
      name,
      language: source.language,
      category: source.category,
      status: "draft",
      components: source.components as Prisma.InputJsonValue,
      ...(source.headerMedia ? { headerMedia: source.headerMedia as Prisma.InputJsonObject } : {}),
    },
  });
}

async function ownedTemplate(actor: Actor, id: string) {
  const template = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!template) throw new HttpError(404, "Template not found.");
  const waba = await prisma.waba.findFirst({ where: { id: template.wabaRefId, tenantId: actor.tenantId } });
  if (!waba) throw new HttpError(409, "Template's WhatsApp Business account is not available.");
  return { template, waba };
}

export async function submitTemplate(actor: Actor, id: string) {
  const { template, waba } = await ownedTemplate(actor, id);
  if (template.status !== "draft" && template.status !== "rejected") {
    throw new HttpError(409, "Only draft or rejected templates can be submitted.");
  }
  validateTemplateInput(template);
  let result: { id?: string; status?: string };
  try {
    result = await graphFetch<{ id?: string; status?: string }>({
      tenantId: actor.tenantId,
      path: `${waba.wabaId}/message_templates`,
      method: "POST",
      body: { name: template.name, language: template.language, category: template.category, components: template.components },
    });
  } catch (e) {
    if (e instanceof GraphError) throw new HttpError(e.status >= 500 ? 502 : 400, `Meta rejected the template: ${e.message}`);
    throw e;
  }
  return prisma.template.update({
    where: { id: template.id, tenantId: actor.tenantId },
    data: { metaTemplateId: result.id ?? null, status: result.status ? mapMetaStatus(result.status) : "pending", rejectionReason: null },
  });
}

async function fetchAllMetaTemplates(tenantId: string, wabaId: string): Promise<MetaTemplate[]> {
  const all: MetaTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await graphFetch<MetaPage>({
      tenantId,
      path: `${wabaId}/message_templates`,
      query: { limit: "100", fields: "id,name,language,category,status,components,rejected_reason", ...(after ? { after } : {}) },
    });
    all.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return all;
}

export async function syncTemplates(actor: Actor) {
  const wabas = await prisma.waba.findMany({ where: { tenantId: actor.tenantId } });
  if (wabas.length === 0) throw new HttpError(409, "Connect a WhatsApp Business account first.");
  let synced = 0;
  for (const waba of wabas) {
    for (const t of await fetchAllMetaTemplates(actor.tenantId, waba.wabaId)) {
      if (!t.name || !t.language) continue;
      const data = {
        category: t.category ?? "UTILITY",
        status: mapMetaStatus(t.status),
        components: (t.components ?? []) as Prisma.InputJsonValue,
        metaTemplateId: t.id ?? null,
        rejectionReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      };
      await prisma.template.upsert({
        where: { tenantId_wabaRefId_name_language: { tenantId: actor.tenantId, wabaRefId: waba.id, name: t.name, language: t.language } },
        create: { tenantId: actor.tenantId, wabaRefId: waba.id, name: t.name, language: t.language, ...data },
        update: data,
      });
      synced++;
    }
  }
  return { synced };
}

export async function deleteTemplate(actor: Actor, id: string) {
  const { template, waba } = await ownedTemplate(actor, id);
  const inUse = await prisma.broadcast.count({ where: { tenantId: actor.tenantId, templateId: template.id } });
  if (inUse > 0) throw new HttpError(409, "This template is used by a broadcast and cannot be deleted.");
  if (template.status !== "draft") {
    await graphFetch({ tenantId: actor.tenantId, path: `${waba.wabaId}/message_templates`, method: "DELETE", query: { name: template.name } });
  }
  await prisma.template.delete({ where: { id: template.id, tenantId: actor.tenantId } });
}

/** The portable shape of a template (no ids, status or account), for download and for importing into another workspace. */
export async function exportTemplate(actor: Actor, id: string) {
  const t = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId }, select: { name: true, language: true, category: true, components: true } });
  if (!t) throw new HttpError(404, "Template not found.");
  return { name: t.name, language: t.language, category: t.category, components: t.components };
}
