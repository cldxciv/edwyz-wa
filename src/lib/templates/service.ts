import { Prisma } from "@/generated/prisma/client";
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
/** A row changed this recently (just sent for review) may not be in Meta's list yet, so a sync never turns it off. */
const SYNC_GRACE_MS = 10 * 60_000;

/**
 * Meta's refusal as an answer people can act on, instead of a generic 500: an expired token asks to reconnect, Meta being
 * unreachable is a 502, and anything else quotes Meta's reason. NoValidTokenError is already a 409 with the reconnect step.
 */
export function metaFailure(e: unknown, doing: string): unknown {
  if (!(e instanceof GraphError)) return e;
  if (e.code === 190 || e.status === 401) return new HttpError(409, "Your WhatsApp connection has expired. Reconnect WhatsApp in Settings, then try again.");
  if (!e.status || e.status >= 500) return new HttpError(502, `We could not reach Meta to ${doing}. Try again in a moment.`);
  return new HttpError(400, `Meta refused to ${doing}: ${e.message}`);
}

/** Meta's answer when the template is already gone (deleted in WhatsApp Manager): deleting it here then only removes our copy. */
function templateGone(e: unknown): boolean {
  return e instanceof GraphError && (e.status === 404 || /not (be )?found|does not exist|doesn't exist|no longer exists/i.test(e.message));
}

/**
 * The account a new template is created in. Always one of the actor's tenant's accounts: a requested one is checked, otherwise
 * the account of the workspace's first number (the one sending defaults to), else the oldest account.
 */
async function templateWaba(tenantId: string, requested: unknown) {
  if (requested !== undefined && requested !== null && requested !== "") {
    const chosen = typeof requested === "string" && requested.length <= 64 ? await prisma.waba.findFirst({ where: { id: requested, tenantId } }) : null;
    if (!chosen) throw new HttpError(400, "Choose one of your WhatsApp Business accounts.");
    return chosen;
  }
  const first = await prisma.phoneNumber.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { wabaRefId: true } });
  const waba = first
    ? await prisma.waba.findFirst({ where: { id: first.wabaRefId, tenantId } })
    : await prisma.waba.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  if (!waba) throw new HttpError(409, "Connect a WhatsApp Business account first.");
  return waba;
}

/** The workspace's WhatsApp Business accounts for the editor's account choice, with the numbers on each. The default is listed first. */
export async function templateAccounts(actor: Actor) {
  const [wabas, phones] = await Promise.all([
    prisma.waba.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true }, take: 50 }),
    prisma.phoneNumber.findMany({ where: { tenantId: actor.tenantId }, orderBy: { createdAt: "asc" }, select: { wabaRefId: true, displayPhone: true, verifiedName: true }, take: 200 }),
  ]);
  const defaultId = phones[0]?.wabaRefId ?? wabas[0]?.id ?? null;
  const accounts = wabas.map((w) => {
    const numbers = phones.filter((p) => p.wabaRefId === w.id);
    return { id: w.id, name: w.name ?? numbers.find((p) => p.verifiedName)?.verifiedName ?? null, numbers: numbers.map((p) => p.displayPhone), isDefault: w.id === defaultId };
  });
  return accounts.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
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
  const waba = await templateWaba(actor.tenantId, raw && typeof raw === "object" ? (raw as { wabaRefId?: unknown }).wabaRefId : undefined);
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

/** Drafts, and templates Meta rejected, can be changed; anything Meta approved or is reviewing is copied instead. */
export const EDITABLE_STATUSES: readonly string[] = ["draft", "rejected"];

/**
 * Saves changes to a draft or a rejected template. Once Meta has the template (metaTemplateId), its name and language are
 * fixed: Meta edits a reviewed template in place and never renames it. Sending it again is submitTemplate.
 */
export async function updateTemplate(actor: Actor, id: string, raw: unknown) {
  const template = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!template) throw new HttpError(404, "Template not found.");
  if (!EDITABLE_STATUSES.includes(template.status)) throw new HttpError(409, "Only drafts and rejected templates can be changed. Make a copy to change this one.");
  const input: TemplateInput = validateTemplateInput(raw);
  const renamed = input.name !== template.name || input.language !== template.language;
  if (renamed && template.metaTemplateId) throw new HttpError(409, "Meta does not allow changing the name or language of a template it has reviewed. Make a copy to use a new name.");
  if (renamed) {
    const duplicate = await prisma.template.findFirst({
      where: { tenantId: actor.tenantId, wabaRefId: template.wabaRefId, name: input.name, language: input.language, id: { not: template.id } },
      select: { id: true },
    });
    if (duplicate) throw new HttpError(409, "A template with this name and language already exists.");
  }
  const headerMedia = headerMediaFrom(input.components, raw);
  return prisma.template.update({
    where: { id: template.id, tenantId: actor.tenantId },
    data: {
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components as Prisma.InputJsonValue,
      headerMedia: headerMedia ? (headerMedia as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
    },
  });
}

/** One template for its page: what the editor and the read-only view need, without tenant or account ids. */
export async function templateDetails(actor: Actor, id: string) {
  const t = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId } });
  if (!t) throw new HttpError(404, "Template not found.");
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejectionReason: t.rejectionReason,
    components: t.components,
    headerMedia: t.headerMedia,
    atMeta: t.metaTemplateId !== null,
    updatedAt: t.updatedAt,
  };
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
    // A rejected template Meta already has is edited in place (its name is taken at Meta); anything else is created.
    result =
      template.status === "rejected" && template.metaTemplateId
        ? await graphFetch<{ success?: boolean }>({
            tenantId: actor.tenantId,
            path: template.metaTemplateId,
            method: "POST",
            body: { category: template.category, components: template.components },
          }).then(() => ({ id: template.metaTemplateId ?? undefined, status: "PENDING" }))
        : await graphFetch<{ id?: string; status?: string }>({
            tenantId: actor.tenantId,
            path: `${waba.wabaId}/message_templates`,
            method: "POST",
            body: { name: template.name, language: template.language, category: template.category, components: template.components },
          });
  } catch (e) {
    throw metaFailure(e, "take the template for review");
  }
  return prisma.template.update({
    where: { id: template.id, tenantId: actor.tenantId },
    data: { metaTemplateId: result.id ?? null, status: result.status ? mapMetaStatus(result.status) : "pending", rejectionReason: null },
  });
}

/**
 * Every template of the account, page by page. `complete` is false when the page cap was reached, so the caller never takes a
 * template on a later page for one Meta no longer has. Named placeholders need no extra field: Meta's parameter_format is NAMED
 * exactly when the placeholders are names, which lib/broadcasts/mapping.ts reads from the text.
 */
async function fetchAllMetaTemplates(tenantId: string, wabaId: string): Promise<{ templates: MetaTemplate[]; complete: boolean }> {
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
    if (!after) return { templates: all, complete: true };
  }
  return { templates: all, complete: false };
}

const nameKey = (t: { name: string; language: string }) => `${t.name}\n${t.language}`;

/**
 * Local templates of one account that Meta no longer lists (deleted or archived in WhatsApp Manager). One Meta still has under
 * review would be refused at every send (132001), so it is turned off; a rejected one becomes a draft again, so it can be fixed
 * and sent as new. Drafts were never at Meta, and rows changed in the last few minutes may not be listed yet: both are left alone.
 */
async function retireMissing(actor: Actor, wabaRefId: string, listed: Set<string>, now: Date): Promise<number> {
  const local = await prisma.template.findMany({
    where: { tenantId: actor.tenantId, wabaRefId, status: { notIn: ["draft", "disabled"] }, updatedAt: { lt: new Date(now.getTime() - SYNC_GRACE_MS) } },
    select: { id: true, name: true, language: true, status: true },
  });
  const gone = local.filter((t) => !listed.has(nameKey(t)));
  const rejected = gone.filter((t) => t.status === "rejected").map((t) => t.id);
  const others = gone.filter((t) => t.status !== "rejected").map((t) => t.id);
  if (rejected.length) await prisma.template.updateMany({ where: { tenantId: actor.tenantId, id: { in: rejected } }, data: { status: "draft", metaTemplateId: null } });
  if (others.length) await prisma.template.updateMany({ where: { tenantId: actor.tenantId, id: { in: others } }, data: { status: "disabled" } });
  return others.length;
}

/** Brings every account's templates in line with Meta. `disabled` counts the templates turned off because Meta no longer has them. */
export async function syncTemplates(actor: Actor, now: Date = new Date()) {
  const wabas = await prisma.waba.findMany({ where: { tenantId: actor.tenantId } });
  if (wabas.length === 0) throw new HttpError(409, "Connect a WhatsApp Business account first.");
  let synced = 0;
  let disabled = 0;
  for (const waba of wabas) {
    // A rejected template can be fixed here (updateTemplate) before it is sent again. While Meta still calls it rejected, Meta
    // only has the old wording, so a sync keeps the local wording and type instead of undoing the fix.
    let fetched: Awaited<ReturnType<typeof fetchAllMetaTemplates>>;
    try {
      fetched = await fetchAllMetaTemplates(actor.tenantId, waba.wabaId);
    } catch (e) {
      throw metaFailure(e, "list your templates");
    }
    const metaTemplates = fetched.templates;
    const rejected = await prisma.template.findMany({ where: { tenantId: actor.tenantId, wabaRefId: waba.id, status: "rejected" }, select: { name: true, language: true } });
    const fixing = new Set(rejected.map(nameKey));
    for (const t of metaTemplates) {
      if (!t.name || !t.language) continue;
      const data = {
        category: t.category ?? "UTILITY",
        status: mapMetaStatus(t.status),
        components: (t.components ?? []) as Prisma.InputJsonValue,
        metaTemplateId: t.id ?? null,
        rejectionReason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
      };
      const keepLocal = data.status === "rejected" && fixing.has(`${t.name}\n${t.language}`);
      await prisma.template.upsert({
        where: { tenantId_wabaRefId_name_language: { tenantId: actor.tenantId, wabaRefId: waba.id, name: t.name, language: t.language } },
        create: { tenantId: actor.tenantId, wabaRefId: waba.id, name: t.name, language: t.language, ...data },
        update: keepLocal ? { status: data.status, metaTemplateId: data.metaTemplateId, rejectionReason: data.rejectionReason } : data,
      });
      synced++;
    }
    if (fetched.complete) disabled += await retireMissing(actor, waba.id, new Set(metaTemplates.filter((t) => t.name && t.language).map(nameKey)), now);
  }
  return { synced, disabled };
}

/**
 * Deletes a template here and at Meta. Meta deletes every language of a name unless the template's own id (hsm_id) is given, so
 * the id is always sent when known and only that language goes. Without an id Meta can only delete by name: then every language
 * of the name goes at Meta, and their copies here are removed too (the delete dialog says so). A template Meta no longer has is
 * simply removed here. Returns how many templates were removed.
 */
export async function deleteTemplate(actor: Actor, id: string): Promise<{ removed: number }> {
  const { template, waba } = await ownedTemplate(actor, id);
  const atMeta = template.status !== "draft";
  const byName = atMeta && !template.metaTemplateId;
  const doomed = byName
    ? (await prisma.template.findMany({ where: { tenantId: actor.tenantId, wabaRefId: waba.id, name: template.name, status: { not: "draft" } }, select: { id: true } })).map((t) => t.id)
    : [template.id];
  if (!doomed.includes(template.id)) doomed.push(template.id);
  const inUse = await prisma.broadcast.count({ where: { tenantId: actor.tenantId, templateId: { in: doomed } } });
  if (inUse > 0) throw new HttpError(409, doomed.length > 1 ? "A language of this template is used by a broadcast, so it cannot be deleted." : "This template is used by a broadcast and cannot be deleted.");
  if (atMeta) {
    const query: Record<string, string> = template.metaTemplateId ? { name: template.name, hsm_id: template.metaTemplateId } : { name: template.name };
    try {
      await graphFetch({ tenantId: actor.tenantId, path: `${waba.wabaId}/message_templates`, method: "DELETE", query });
    } catch (e) {
      if (!templateGone(e)) throw metaFailure(e, "delete the template");
    }
  }
  const { count } = await prisma.template.deleteMany({ where: { tenantId: actor.tenantId, id: { in: doomed } } });
  return { removed: count };
}

/** The portable shape of a template (no ids, status or account), for download and for importing into another workspace. */
export async function exportTemplate(actor: Actor, id: string) {
  const t = await prisma.template.findFirst({ where: { id, tenantId: actor.tenantId }, select: { name: true, language: true, category: true, components: true } });
  if (!t) throw new HttpError(404, "Template not found.");
  return { name: t.name, language: t.language, category: t.category, components: t.components };
}
