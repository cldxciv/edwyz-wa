import type { Prisma } from "@/generated/prisma/client";
import { emitAttributeChanges, emitAutomationEvent, emitTagChanges } from "@/lib/automation/v2/emit";
import { assertWithinLimit } from "@/lib/billing";
import { recordChannelConsent } from "@/lib/contacts/consent";
import { prisma } from "@/lib/db";
import { graphFetchAs } from "@/lib/graph";
import { getAssetAccess } from "@/lib/meta-connect";
import { describeError } from "@/lib/safe-error";
import { routeNewLead } from "./assignment";
import { emptyQuestionInfo, getFormSettings, recordFormDefinition, recordFormQuestionKeys, type FormQuestionInfo } from "./form-settings";
import { detectConsent, extractIdentity, mapFieldData, mapFieldNames, type Consent, type ConsentOptions, type Identity } from "./fields";
import { fetchFormDefinitionKeys } from "./form-definition";
import { startSequenceForLead } from "./runner";
import { emitLeadCreated } from "@/lib/integrations/emitters";

export const LEAD_QUEUE = "lead-fetch";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LEAD_FIELDS = "id,created_time,ad_id,campaign_id,form_id,field_data";

export type LeadJob = { leadgenId: string; pageId: string; formId?: string };

type GraphLead = { id?: string; created_time?: string; ad_id?: string; campaign_id?: string; form_id?: string; field_data?: unknown };

/** Pulls leadgen ids out of a Meta webhook payload. Nothing else from the payload is kept. */
export function extractLeadJobs(payload: unknown): LeadJob[] {
  const body = payload as { object?: unknown; entry?: unknown };
  if (!body || body.object !== "page" || !Array.isArray(body.entry)) return [];
  const jobs = new Map<string, LeadJob>();
  for (const entry of body.entry as { changes?: unknown }[]) {
    for (const change of Array.isArray(entry?.changes) ? (entry.changes as { field?: unknown; value?: Record<string, unknown> }[]) : []) {
      if (change?.field !== "leadgen") continue;
      const v = change.value ?? {};
      const leadgenId = String(v.leadgen_id ?? "");
      const pageId = String(v.page_id ?? "");
      if (!ID.test(leadgenId) || !ID.test(pageId)) continue;
      const formId = ID.test(String(v.form_id ?? "")) ? String(v.form_id) : undefined;
      jobs.set(leadgenId, { leadgenId, pageId, formId });
    }
  }
  return [...jobs.values()];
}

export function parseLeadJob(payload: unknown): LeadJob | null {
  const p = payload as Partial<LeadJob> | null;
  if (!p || !ID.test(String(p.leadgenId)) || !ID.test(String(p.pageId))) return null;
  return { leadgenId: p.leadgenId as string, pageId: p.pageId as string, formId: p.formId };
}

/** Queue handler. Every tenant that connected this page gets its own copy, fetched with its own page token. */
export async function handleLeadJob(payload: unknown): Promise<void> {
  const job = parseLeadJob(payload);
  if (!job) return;
  const assets = await prisma.metaAsset.findMany({ where: { type: "page", externalId: job.pageId, status: "active" }, select: { id: true, tenantId: true } });
  let failed: unknown = null;
  for (const asset of assets) {
    try {
      await ingestForTenant(asset.tenantId, asset.id, job);
    } catch (e) {
      console.error("[leads] ingest failed:", describeError(e));
      failed = e;
    }
  }
  if (failed) throw failed;
}

export async function ingestForTenant(tenantId: string, assetId: string, job: LeadJob): Promise<string | null> {
  const existing = await prisma.lead.findFirst({ where: { tenantId, leadgenId: job.leadgenId }, select: { id: true } });
  if (existing) return null;

  const access = await getAssetAccess(tenantId, assetId);
  const raw = await graphFetchAs<GraphLead>(access.token, { path: job.leadgenId, query: { fields: LEAD_FIELDS } });
  const fields = mapFieldData(raw?.field_data);
  const metaFormId = raw?.form_id ?? job.formId;
  const form = metaFormId
    ? await prisma.leadForm.upsert({
        where: { tenantId_metaFormId: { tenantId, metaFormId } },
        create: { tenantId, pageAssetId: assetId, metaFormId },
        update: {},
      })
    : null;
  const identity = extractIdentity(fields);
  const settings = form ? await getFormSettings(tenantId, form.id) : { consentAssumed: false };
  const presentKeys = mapFieldNames(raw?.field_data);
  const known = form ? await rememberQuestions(tenantId, form.id, presentKeys) : emptyQuestionInfo(presentKeys);
  const consent = detectConsent(fields, form?.consentText, await consentOptions(tenantId, form?.id, access.token, metaFormId, known, settings.consentAssumed));
  const campaignMetaId = raw?.campaign_id ? String(raw.campaign_id) : null;
  const createdAt = raw?.created_time ? new Date(raw.created_time) : new Date();
  const contactId = await upsertContact(tenantId, identity, consent, campaignMetaId, createdAt);

  let lead;
  try {
    lead = await prisma.lead.create({
      data: {
        tenantId,
        leadFormId: form?.id ?? null,
        leadgenId: job.leadgenId,
        contactId,
        fields: fields as Prisma.InputJsonObject,
        campaignMetaId,
        adMetaId: raw?.ad_id ? String(raw.ad_id) : null,
        consentText: consent.given ? consent.text : null,
        consentAt: consent.given ? validDate(createdAt) : null,
      },
    });
  } catch {
    return null;
  }
  await routeNewLead(tenantId, lead).catch((e) => console.error("[leads] routing failed:", describeError(e)));
  await emitLeadCreated(tenantId, lead, metaFormId ?? null).catch(() => console.error("[leads] could not emit the lead.created event"));
  await startSequenceForLead(tenantId, lead).catch((e) => console.error("[leads] sequence start failed:", describeError(e)));
  return lead.id;
}

/** A form's question names are stored the first time a lead of it is seen and extended when new ones appear. A storage failure falls back to this lead's own names. */
async function rememberQuestions(tenantId: string, formId: string, seen: string[]): Promise<FormQuestionInfo> {
  try {
    return await recordFormQuestionKeys(tenantId, formId, seen, undefined);
  } catch {
    return emptyQuestionInfo(seen);
  }
}

/** How long a form definition read from Meta is trusted before it is read again. Lead forms rarely change, and every lead would otherwise cost one more Meta call. */
export const DEFINITION_TTL_MS = 24 * 3_600_000;

/**
 * Which questions of the form record consent. The question names come from the stored names of the form's leads and this lead's
 * answers; the labels come from the form definition read from Meta, because a consent question can have an opaque key
 * ("question_1" labelled "Receive WhatsApp updates"). The definition is read when it has not been read in the last 24 hours and
 * then stored; an unreadable definition falls back to the stored one, and with neither the form is simply not known to have no
 * consent question. consentAssumed (a tenant's statement that the form's consent text covers every lead) is honoured only when a
 * definition has been read and defines no consent question; unknown never assumes consent.
 */
async function consentOptions(tenantId: string, formId: string | undefined, token: string, metaFormId: string | undefined, known: FormQuestionInfo, consentAssumed: boolean): Promise<ConsentOptions> {
  const base: ConsentOptions = { consentAssumed, presentKeys: known.keys };
  let info = known;
  const fresh = info.definedAt !== null && Date.now() - info.definedAt < DEFINITION_TTL_MS;
  if (!fresh && metaFormId) {
    const def = await fetchFormDefinitionKeys(token, metaFormId);
    if (def) {
      info = { keys: [...new Set([...known.keys, ...def.questionKeys])], consentKeys: def.consentKeys, channelKeys: def.channelKeys, definedAt: Date.now() };
      if (formId) await recordFormDefinition(tenantId, formId, known, def).catch(() => undefined);
    }
  }
  if (info.consentKeys === null) return base;
  return { ...base, formConsentKeys: info.consentKeys, formChannelKeys: info.channelKeys, formHasConsentField: info.consentKeys.length + info.channelKeys.length > 0 };
}

function validDate(d: Date): Date {
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function upsertContact(tenantId: string, identity: Identity, consent: Consent, campaignMetaId: string | null, at: Date): Promise<string | null> {
  if (!identity.phone) return null;
  const when = validDate(at);
  const tags = ["lead", ...(campaignMetaId ? [`campaign:${campaignMetaId}`] : [])];
  const attributes = { leadSource: "meta_lead_form", ...(identity.email ? { email: identity.email } : {}) };
  const existing = await prisma.contact.findFirst({ where: { tenantId, phone: identity.phone } });
  if (existing) {
    const canOptIn = consent.given && !existing.optIn && !existing.optedOutAt;
    const needs = !existing.optIn && !canOptIn;
    const merged = [...new Set([...existing.tags, ...tags, ...(needs ? ["needs_opt_in"] : [])])].filter((t) => canOptIn ? t !== "needs_opt_in" : true);
    await prisma.contact.updateMany({
      where: { id: existing.id, tenantId },
      data: {
        tags: merged,
        ...(existing.name ? {} : { name: identity.name }),
        attributes: { ...(existing.attributes as object), ...attributes },
        ...(canOptIn ? { optIn: true, optInSource: "lead_form", optInAt: when } : {}),
      },
    });
    if (canOptIn) await recordChannelConsent(tenantId, existing.id, { source: "lead_form", via: "lead_form" });
    const base = { tenantId, contactId: existing.id };
    void emitTagChanges(base, existing.tags, merged);
    void emitAttributeChanges(base, (existing.attributes ?? {}) as Record<string, unknown>, { ...(existing.attributes as object), ...attributes });
    return existing.id;
  }
  try {
    await assertWithinLimit(tenantId, "contacts");
  } catch {
    return null;
  }
  const created = await prisma.contact.create({
    data: {
      tenantId,
      phone: identity.phone,
      name: identity.name,
      tags: consent.given ? tags : [...tags, "needs_opt_in"],
      attributes,
      ...(consent.given ? { optIn: true, optInSource: "lead_form", optInAt: when } : {}),
    },
  });
  if (consent.given) await recordChannelConsent(tenantId, created.id, { source: "lead_form", via: "lead_form" });
  void emitAutomationEvent({ type: "contact_created", tenantId, contactId: created.id });
  return created.id;
}
