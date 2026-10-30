import { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/auth/audit";
import { queueConversion } from "@/lib/conversions";
import { prisma } from "@/lib/db";
import { csvRow, BOM } from "@/lib/reports/csv";
import { HttpError, type Actor } from "@/lib/tenancy";
import { getFormQuestionInfoMany, getFormSettingsMany, setFormSettings, type FormQuestionInfo } from "./form-settings";
import { consentKind, isLeadStatus, isUnspecificConsentKey, type LeadStatus } from "./fields";
import { parseAppliesTo, parseSteps } from "./steps";

const MAX_LIMIT = 100;
const EXPORT_MAX = 10_000;

export type ListQuery = { status?: string; formId?: string; campaign?: string; assignedToId?: string; from?: string; to?: string; cursor?: string; limit?: number };

function parseDate(v: string | undefined, label: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${label} must be a valid date.`);
  return d;
}

function buildWhere(tenantId: string, q: ListQuery): Prisma.LeadWhereInput {
  if (q.status && !isLeadStatus(q.status)) throw new HttpError(400, "Unknown status.");
  const from = parseDate(q.from, "from");
  const to = parseDate(q.to, "to");
  return {
    tenantId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.formId ? { leadFormId: q.formId } : {}),
    ...(q.campaign ? { campaignMetaId: q.campaign } : {}),
    ...(q.assignedToId ? { assignedToId: q.assignedToId === "none" ? null : q.assignedToId } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

type LeadRecord = {
  id: string; leadFormId: string | null; contactId: string | null; fields: unknown; campaignMetaId: string | null; adMetaId: string | null;
  consentText: string | null; consentAt: Date | null; status: string; assignedToId: string | null; firstResponseAt: Date | null; createdAt: Date;
};

async function decorate(tenantId: string, rows: LeadRecord[]) {
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const formIds = [...new Set(rows.map((r) => r.leadFormId).filter((x): x is string => Boolean(x)))];
  const [contacts, forms] = await Promise.all([
    contactIds.length ? prisma.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, name: true, phone: true, optIn: true, optedOutAt: true } }) : [],
    formIds.length ? prisma.leadForm.findMany({ where: { tenantId, id: { in: formIds } }, select: { id: true, name: true, metaFormId: true } }) : [],
  ]);
  const byContact = new Map(contacts.map((c) => [c.id, c]));
  const byForm = new Map(forms.map((f) => [f.id, f]));
  return rows.map((r) => {
    const contact = r.contactId ? (byContact.get(r.contactId) ?? null) : null;
    const form = r.leadFormId ? (byForm.get(r.leadFormId) ?? null) : null;
    const fields = (r.fields && typeof r.fields === "object" ? r.fields : {}) as Record<string, string>;
    return {
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      firstResponseAt: r.firstResponseAt,
      responseSeconds: r.firstResponseAt ? Math.max(0, Math.round((r.firstResponseAt.getTime() - r.createdAt.getTime()) / 1000)) : null,
      campaignMetaId: r.campaignMetaId,
      adMetaId: r.adMetaId,
      form: form ? { id: form.id, name: form.name ?? form.metaFormId } : null,
      source: "meta_lead_form",
      contact,
      needsOptIn: !contact || !contact.optIn,
      name: contact?.name ?? fields.full_name ?? fields.name ?? null,
      email: fields.email ?? null,
      assignedToId: r.assignedToId,
      consentText: r.consentText,
      consentAt: r.consentAt,
    };
  });
}

export async function listLeads(tenantId: string, q: ListQuery) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), MAX_LIMIT);
  const rows = (await prisma.lead.findMany({
    where: buildWhere(tenantId, q),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  })) as LeadRecord[];
  const page = rows.slice(0, limit);
  return { items: await decorate(tenantId, page), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

export async function getLead(tenantId: string, id: string) {
  const row = (await prisma.lead.findFirst({ where: { id, tenantId } })) as LeadRecord | null;
  if (!row) throw new HttpError(404, "Lead not found.");
  const [item] = await decorate(tenantId, [row]);
  const runs = await prisma.leadSequenceRun.findMany({ where: { tenantId, leadId: id }, include: { sequence: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 10 });
  return {
    lead: {
      ...item,
      fields: row.fields,
      sequences: runs.map((r) => ({ id: r.id, name: r.sequence.name, status: r.status, stepIndex: r.stepIndex, nextRunAt: r.nextRunAt })),
    },
  };
}

export async function updateLead(actor: Actor, id: string, patch: { status?: unknown; assignedToId?: unknown }) {
  const { tenantId } = actor;
  const current = await prisma.lead.findFirst({ where: { id, tenantId } });
  if (!current) throw new HttpError(404, "Lead not found.");
  const data: Prisma.LeadUpdateManyMutationInput & { assignedToId?: string | null } = {};
  if (patch.status !== undefined) {
    if (!isLeadStatus(patch.status)) throw new HttpError(400, "Unknown status.");
    data.status = patch.status;
  }
  if (patch.assignedToId !== undefined) {
    if (actor.role === "agent") throw new HttpError(403, "Only admins can reassign leads.");
    if (patch.assignedToId !== null) {
      if (typeof patch.assignedToId !== "string") throw new HttpError(400, "assignedToId must be a user id or null.");
      const member = await prisma.membership.findFirst({ where: { tenantId, userId: patch.assignedToId }, select: { id: true } });
      if (!member) throw new HttpError(400, "That user is not a member of this workspace.");
    }
    data.assignedToId = patch.assignedToId as string | null;
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to update.");
  await prisma.lead.updateMany({ where: { id, tenantId }, data });
  if (data.assignedToId !== undefined && current.contactId) {
    await prisma.conversation.updateMany({ where: { tenantId, contactId: current.contactId }, data: { assignedToId: data.assignedToId, assignedAt: new Date() } });
  }
  if (data.status && data.status !== current.status) {
    await audit({ tenantId, userId: actor.userId, action: "lead.status", target: id, meta: { from: current.status, to: data.status as string } });
    await fireConversion(tenantId, id, current.contactId, data.status as LeadStatus);
  }
  return getLead(tenantId, id);
}

async function fireConversion(tenantId: string, leadId: string, contactId: string | null, status: LeadStatus) {
  const eventName = status === "qualified" ? "QualifiedLead" : status === "won" ? "Purchase" : null;
  if (!eventName) return;
  try {
    await queueConversion(tenantId, { leadId, contactId: contactId ?? undefined, eventName });
  } catch {
    console.error("[leads] could not queue the conversion event");
  }
}

type FormRow = { id: string; metaFormId: string; name: string | null; consentText: string | null; status: string; createdAt: Date };

export const CONSENT_ASSUMED_NOTE =
  "Assume consent applies only to a form that has no consent question. If the form asks a consent question (a checkbox or a custom disclaimer whose name or label is about marketing, messages, WhatsApp, updates, offers, contact or opt-in), each lead must answer it with an explicit yes; a lead that leaves it out or answers anything else is not opted in, whatever this setting says. Terms, privacy and data-processing checkboxes are not consent questions. Until the form's definition has been read from Meta (it is read with the form's first lead, and again every 24 hours), consent is not assumed.";

function presentForm(f: FormRow, consentAssumed: boolean, info: FormQuestionInfo | undefined) {
  const keys = info?.keys ?? [];
  // Same rules as the lead worker: names from the form's leads, labels from the stored form definition.
  const consentQuestionKeys = [...new Set([...(info?.consentKeys ?? []), ...(info?.channelKeys ?? []), ...keys.filter((k) => consentKind(k) !== null || isUnspecificConsentKey(k))])];
  const definitionRead = info?.definedAt != null;
  return {
    id: f.id,
    metaFormId: f.metaFormId,
    name: f.name,
    consentText: f.consentText,
    consentAssumed,
    consentTextNotUsed: Boolean(f.consentText?.trim()) && !consentAssumed,
    consentAssumedNote: CONSENT_ASSUMED_NOTE,
    questionKeys: keys,
    consentQuestionKeys,
    consentDefinitionRead: definitionRead,
    consentAssumedApplies: consentAssumed && definitionRead && consentQuestionKeys.length === 0,
    status: f.status,
    createdAt: f.createdAt,
  };
}

export async function listForms(tenantId: string) {
  const forms = await prisma.leadForm.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 });
  const ids = forms.map((f) => f.id);
  const [settings, questions] = await Promise.all([getFormSettingsMany(tenantId, ids), getFormQuestionInfoMany(tenantId, ids)]);
  return forms.map((f) => presentForm(f, settings.get(f.id)?.consentAssumed ?? false, questions.get(f.id)));
}

async function getForm(tenantId: string, id: string) {
  const form = await prisma.leadForm.findFirst({ where: { id, tenantId } });
  if (!form) return undefined;
  const [settings, questions] = await Promise.all([getFormSettingsMany(tenantId, [id]), getFormQuestionInfoMany(tenantId, [id])]);
  return presentForm(form, settings.get(id)?.consentAssumed ?? false, questions.get(id));
}

const META_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Registers a Meta lead form before its first lead arrives, so its consent settings apply to that first lead. Idempotent per (workspace, Meta form id). */
export async function createForm(actor: Actor, input: { metaFormId?: unknown; pageAssetId?: unknown; name?: unknown; consentText?: unknown; consentAssumed?: unknown }) {
  if (typeof input.metaFormId !== "string" || !META_ID.test(input.metaFormId)) throw new HttpError(400, "metaFormId is the lead form id from Meta.");
  if (typeof input.pageAssetId !== "string" || !META_ID.test(input.pageAssetId)) throw new HttpError(400, "pageAssetId must be one of your connected Pages.");
  if (input.consentAssumed !== undefined && typeof input.consentAssumed !== "boolean") throw new HttpError(400, "consentAssumed must be true or false.");
  const page = await prisma.metaAsset.findFirst({ where: { id: input.pageAssetId, tenantId: actor.tenantId, type: "page" }, select: { id: true } });
  if (!page) throw new HttpError(404, "Page not found.");
  const form = await prisma.leadForm.upsert({
    where: { tenantId_metaFormId: { tenantId: actor.tenantId, metaFormId: input.metaFormId } },
    create: { tenantId: actor.tenantId, pageAssetId: page.id, metaFormId: input.metaFormId },
    update: {},
  });
  if (input.consentText === undefined && input.name === undefined && input.consentAssumed === undefined) return getForm(actor.tenantId, form.id);
  return updateForm(actor, form.id, { consentText: input.consentText, name: input.name, consentAssumed: input.consentAssumed });
}

export async function updateForm(actor: Actor, id: string, patch: { consentText?: unknown; name?: unknown; consentAssumed?: unknown }) {
  const data: { consentText?: string | null; name?: string | null } = {};
  if (patch.consentText !== undefined) {
    if (patch.consentText !== null && (typeof patch.consentText !== "string" || patch.consentText.length > 1000)) throw new HttpError(400, "consentText must be text up to 1000 characters.");
    data.consentText = patch.consentText === null || !(patch.consentText as string).trim() ? null : (patch.consentText as string).trim();
  }
  if (patch.name !== undefined) {
    if (patch.name !== null && (typeof patch.name !== "string" || patch.name.length > 120)) throw new HttpError(400, "name must be text up to 120 characters.");
    data.name = (patch.name as string | null)?.trim() || null;
  }
  if (patch.consentAssumed !== undefined && typeof patch.consentAssumed !== "boolean") throw new HttpError(400, "consentAssumed must be true or false.");
  if (Object.keys(data).length === 0 && patch.consentAssumed === undefined) throw new HttpError(400, "Nothing to update.");
  const owned = await prisma.leadForm.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } });
  if (!owned) throw new HttpError(404, "Form not found.");
  if (Object.keys(data).length > 0) await prisma.leadForm.updateMany({ where: { id, tenantId: actor.tenantId }, data });
  if (typeof patch.consentAssumed === "boolean") await setFormSettings(actor.tenantId, id, { consentAssumed: patch.consentAssumed });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.form_updated", target: id, ...(typeof patch.consentAssumed === "boolean" ? { meta: { consentAssumed: patch.consentAssumed } } : {}) });
  return getForm(actor.tenantId, id);
}

type SequenceInput = { name?: unknown; enabled?: unknown; steps?: unknown; appliesTo?: unknown };

function sequenceData(input: SequenceInput, partial: boolean) {
  const data: { name?: string; enabled?: boolean; steps?: Prisma.InputJsonValue; appliesTo?: Prisma.InputJsonValue } = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw new HttpError(400, "name is required (up to 120 characters).");
    data.name = input.name.trim();
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    data.enabled = input.enabled;
  }
  if (!partial || input.steps !== undefined) data.steps = parseSteps(input.steps) as unknown as Prisma.InputJsonValue;
  if (input.appliesTo !== undefined) {
    const a = parseAppliesTo(input.appliesTo);
    data.appliesTo = (a ?? Prisma.JsonNull) as Prisma.InputJsonValue;
  }
  return data;
}

async function assertStepRefs(tenantId: string, steps: unknown) {
  for (const s of parseSteps(steps)) {
    if (s.templateId && !(await prisma.template.findFirst({ where: { id: s.templateId, tenantId }, select: { id: true } }))) throw new HttpError(400, "A step uses a template that was not found.");
    if (s.chatbotId && !(await prisma.chatbot.findFirst({ where: { id: s.chatbotId, tenantId }, select: { id: true } }))) throw new HttpError(400, "A step uses a chatbot that was not found.");
  }
}

async function assertAppliesToForm(tenantId: string, appliesTo: Prisma.InputJsonValue | undefined) {
  const leadFormId = appliesTo && typeof appliesTo === "object" && !Array.isArray(appliesTo) ? (appliesTo as { leadFormId?: unknown }).leadFormId : undefined;
  if (typeof leadFormId !== "string") return;
  if (!(await prisma.leadForm.findFirst({ where: { id: leadFormId, tenantId }, select: { id: true } }))) throw new HttpError(400, "That lead form was not found.");
}

export const listSequences =(tenantId: string) => prisma.leadSequence.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 });

export async function getSequence(tenantId: string, id: string) {
  const s = await prisma.leadSequence.findFirst({ where: { id, tenantId } });
  if (!s) throw new HttpError(404, "Sequence not found.");
  return s;
}

export async function createSequence(actor: Actor, input: SequenceInput) {
  const data = sequenceData(input, false);
  await assertStepRefs(actor.tenantId, data.steps);
  await assertAppliesToForm(actor.tenantId, data.appliesTo);
  const created = await prisma.leadSequence.create({ data: { tenantId: actor.tenantId, name: data.name!, enabled: data.enabled ?? true, steps: data.steps!, ...(data.appliesTo && data.appliesTo !== (Prisma.JsonNull as unknown) ? { appliesTo: data.appliesTo } : {}) } });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.sequence_created", target: created.id });
  return created;
}

export async function updateSequence(actor: Actor, id: string, input: SequenceInput) {
  await getSequence(actor.tenantId, id);
  const data = sequenceData(input, true);
  if (data.steps) await assertStepRefs(actor.tenantId, data.steps);
  await assertAppliesToForm(actor.tenantId, data.appliesTo);
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to update.");
  await prisma.leadSequence.updateMany({ where: { id, tenantId: actor.tenantId }, data: data as Prisma.LeadSequenceUpdateManyMutationInput });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.sequence_updated", target: id });
  return getSequence(actor.tenantId, id);
}

export async function deleteSequence(actor: Actor, id: string) {
  const { count } = await prisma.leadSequence.deleteMany({ where: { id, tenantId: actor.tenantId } });
  if (count === 0) throw new HttpError(404, "Sequence not found.");
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "lead.sequence_deleted", target: id });
}

export async function exportLeadsCsv(tenantId: string, q: ListQuery): Promise<string> {
  const rows = (await prisma.lead.findMany({ where: buildWhere(tenantId, q), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: EXPORT_MAX })) as LeadRecord[];
  const items = await decorate(tenantId, rows);
  let out = BOM + csvRow(["created_at", "status", "name", "email", "phone", "form", "campaign_id", "ad_id", "first_response_at", "response_seconds", "opted_in", "consent_at"]);
  for (const i of items) {
    out += csvRow([i.createdAt, i.status, i.name, i.email, i.contact?.phone, i.form?.name, i.campaignMetaId, i.adMetaId, i.firstResponseAt, i.responseSeconds, i.needsOptIn ? "no" : "yes", i.consentAt]);
  }
  return out;
}
