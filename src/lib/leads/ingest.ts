import type { Prisma } from "@/generated/prisma/client";
import { emitAttributeChanges, emitAutomationEvent, emitTagChanges } from "@/lib/automation/v2/emit";
import { assertWithinLimit } from "@/lib/billing";
import { recordChannelConsent } from "@/lib/contacts/consent";
import { queueConversion } from "@/lib/conversions";
import { prisma } from "@/lib/db";
import { graphFetchAs } from "@/lib/graph";
import { getAssetAccess } from "@/lib/meta-connect";
import { CAPABILITIES_KEY, CAPABILITY_TTL_MS, isUnknownFieldError, leadFieldList } from "@/lib/promote/meta";
import { isTestLead } from "@/lib/promote/test-leads";
import { describeError } from "@/lib/safe-error";
import { routeNewLead } from "./assignment";
import { emptyQuestionInfo, getFormSettings, recordFormDefinition, recordFormQuestionKeys, type FormQuestionInfo } from "./form-settings";
import { detectConsent, extractIdentity, mapFieldData, mapFieldNames, type Consent, type ConsentOptions, type Identity } from "./fields";
import { builtFormDefinitionKeys, fetchFormDefinitionKeys } from "./form-definition";
import { startSequenceForLead } from "./runner";
import { emitLeadCreated } from "@/lib/integrations/emitters";

export const LEAD_QUEUE = "lead-fetch";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type LeadJob = { leadgenId: string; pageId: string; formId?: string };

/** Lead.source (5.1, SQL CHECK Lead_source_check). A lead from an instant form is `instant_form`. */
export const LEAD_SOURCES = ["instant_form", "ctwa", "ctig", "ctm", "manual"] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number];

/** Lead.platform (5.1, SQL CHECK Lead_platform_check). Null while Meta does not return it (the capability probe, 4.1). */
export const LEAD_PLATFORMS = ["facebook", "instagram", "messenger", "whatsapp", "audience_network", "unknown"] as const;
export type LeadPlatform = (typeof LEAD_PLATFORMS)[number];

/** What a lead read returns: L6 (one lead, the webhook path) or one row of L5 (a form's leads, the backfill). */
export type GraphLead = {
  id?: string;
  created_time?: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
  field_data?: unknown;
  custom_disclaimer_responses?: unknown;
  platform?: unknown;
  is_organic?: unknown;
};

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

/** The webhook path: L6 for one lead with the workspace's own Page token, then storeLead. Null when the workspace already has the lead. */
export async function ingestForTenant(tenantId: string, assetId: string, job: LeadJob): Promise<string | null> {
  const existing = await prisma.lead.findFirst({ where: { tenantId, leadgenId: job.leadgenId }, select: { id: true } });
  if (existing) return null;

  const access = await getAssetAccess(tenantId, assetId);
  const { result: raw } = await withLeadPlatform((withPlatform) => graphFetchAs<GraphLead>(access.token, { path: job.leadgenId, query: { fields: leadFieldList(withPlatform) } }));
  return storeLead(tenantId, { assetId, pageMetaId: job.pageId, token: access.token }, raw, job);
}

// =====================================================================================================================
// The capability probe for the lead fields platform and is_organic (4.1, VERIFY V-P7)
// =====================================================================================================================

/** The name of the capability in PlatformSetting `promote:capabilities` (promote/meta.ts CAPABILITY_FIELDS). */
export const LEAD_PLATFORM_CAPABILITY = "lead_platform";
/** How long this process trusts what it learnt before it looks at the stored answer again. */
const CAPABILITY_MEMO_MS = 10 * 60_000;

let platformMemo: { supported: boolean; until: number } | null = null;

/** Forgets what this process learnt about the lead platform fields (tests, and a release that changes the Graph version). */
export function forgetLeadPlatformCapability(): void {
  platformMemo = null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True, false, or null when nothing fresh is known: the process's memo, else the stored answer while it is younger than 7 days. */
async function knownLeadPlatform(now: number): Promise<boolean | null> {
  if (platformMemo && platformMemo.until > now) return platformMemo.supported;
  try {
    const row = await prisma.platformSetting.findFirst({ where: { key: CAPABILITIES_KEY }, select: { value: true } });
    const entry = isObject(row?.value) ? row.value[LEAD_PLATFORM_CAPABILITY] : null;
    if (isObject(entry) && typeof entry.supported === "boolean" && typeof entry.checkedAt === "string") {
      const at = Date.parse(entry.checkedAt);
      if (Number.isFinite(at) && now - at < CAPABILITY_TTL_MS) {
        platformMemo = { supported: entry.supported, until: Math.min(now + CAPABILITY_MEMO_MS, at + CAPABILITY_TTL_MS) };
        return entry.supported;
      }
    }
  } catch {
    // Unknown: the read asks for the fields and learns.
  }
  return null;
}

/** Stores "Meta has no platform and is_organic on leads" for 7 days, next to the other capability answers. */
async function rememberNoLeadPlatform(now: number): Promise<void> {
  platformMemo = { supported: false, until: now + CAPABILITY_MEMO_MS };
  try {
    const row = await prisma.platformSetting.findFirst({ where: { key: CAPABILITIES_KEY }, select: { value: true } });
    const value = { ...(isObject(row?.value) ? row.value : {}), [LEAD_PLATFORM_CAPABILITY]: { supported: false, checkedAt: new Date(now).toISOString() } } as Prisma.InputJsonObject;
    await prisma.platformSetting.upsert({ where: { key: CAPABILITIES_KEY }, create: { key: CAPABILITIES_KEY, value }, update: { value } });
  } catch {
    // The probe simply runs again in another process, or after the memo.
  }
}

/**
 * Runs a lead read (L5 or L6) with `platform` and `is_organic` unless Meta is known not to have them. On error #100 the read is
 * made once more without them, and that answer is stored for 7 days (PlatformSetting `promote:capabilities`, the key and shape
 * promote/meta.ts uses), so a missing field costs one extra call a week. A read that works with the fields is only remembered in
 * this process: asking for them costs nothing extra, so nothing is written for every lead. A failure of the second read is thrown
 * and not stored.
 */
export async function withLeadPlatform<T>(read: (withPlatform: boolean) => Promise<T>, now: number = Date.now()): Promise<{ result: T; withPlatform: boolean }> {
  if ((await knownLeadPlatform(now)) === false) return { result: await read(false), withPlatform: false };
  try {
    const result = await read(true);
    platformMemo = { supported: true, until: now + CAPABILITY_MEMO_MS };
    return { result, withPlatform: true };
  } catch (e) {
    if (!isUnknownFieldError(e)) throw e;
    const result = await read(false);
    await rememberNoLeadPlatform(now);
    return { result, withPlatform: false };
  }
}

// =====================================================================================================================
// Storing a lead
// =====================================================================================================================

const PLATFORM_NAMES: Readonly<Record<string, LeadPlatform>> = {
  fb: "facebook",
  facebook: "facebook",
  ig: "instagram",
  instagram: "instagram",
  msg: "messenger",
  messenger: "messenger",
  wa: "whatsapp",
  whatsapp: "whatsapp",
  an: "audience_network",
  audience_network: "audience_network",
};

/** Meta's lead `platform` ("fb", "ig", or a full name) as a Lead.platform value; unknown text is "unknown", nothing is null. */
export function leadPlatform(value: unknown): LeadPlatform | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return PLATFORM_NAMES[value.trim().toLowerCase()] ?? "unknown";
}

/** Meta's lead `is_organic` as a boolean, or null when it is missing or unreadable. */
export function leadIsOrganic(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

const TICKED = new Set(["1", "true", "yes", "checked"]);

/**
 * A lead's custom_disclaimer_responses ([{checkbox_key, is_checked}], the consent boxes of the form's custom disclaimer) as answers
 * keyed like field_data: "yes" for a ticked box and "no" for one left unticked, so the consent rules read them like any other answer.
 */
export function disclaimerAnswers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) return out;
  for (const r of raw.slice(0, 20)) {
    if (!isObject(r) || typeof r.checkbox_key !== "string" || !r.checkbox_key.trim()) continue;
    const v = r.is_checked;
    const ticked = v === true || v === 1 || (typeof v === "string" && TICKED.has(v.trim().toLowerCase()));
    out[r.checkbox_key.trim().toLowerCase().slice(0, 100)] = ticked ? "yes" : "no";
  }
  return out;
}

const metaId = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? (ID.test(String(v)) ? String(v) : null) : null);

/** The Page a lead came through: its MetaAsset id (for the LeadForm row), its Meta id (the test-lead list is per Page) and its token. */
export type LeadPage = { assetId: string; pageMetaId: string; token: string };

const NO_CONSENT: Consent = { given: false, text: null };

/**
 * Stores one lead read from Meta for one workspace, from the webhook (L6) or the backfill (one row of L5). Null when the lead was
 * not stored: the unique key (tenantId, leadgenId) keeps exactly one Lead when the webhook and the backfill race on the same lead,
 * and only the call that created it routes it, queues its conversion and starts its sequence (11.2 risk 16).
 *
 * - The lead keeps Meta's ad, ad set and campaign ids, `platform` and `is_organic` when Meta returned them, source instant_form,
 *   and Meta's created_time (never later than now).
 * - A test lead (D33: its id is in the Page's test-lead list, or an answer starts with "Edwyz test lead" or "<test lead") is stored
 *   with isTest, in every workspace that has the Page, and nothing else happens: no contact, no routing notice, no conversion
 *   event, no lead.created event and no sequence. Nobody is messaged.
 * - The consent boxes of the form's custom disclaimer count as answers. For a form built in Edwyz only its WhatsApp box
 *   `whatsapp_opt_in` decides WhatsApp consent (its spec says whether it has one), and consent is never assumed (D35); the
 *   owner's other boxes and questions are kept as data.
 * - Only a lead whose WhatsApp consent was detected on the form (and whose contact had not opted out before) starts a lead
 *   sequence, the welcome. The others keep needs_opt_in (unless the contact opted in elsewhere) and get no sequence (3.11, D35).
 */
export async function storeLead(tenantId: string, page: LeadPage, raw: GraphLead | null, hint: { leadgenId: string; formId?: string }, now: Date = new Date()): Promise<string | null> {
  const fieldData = raw?.field_data;
  const answers = mapFieldData(fieldData);
  const boxes = disclaimerAnswers(raw?.custom_disclaimer_responses);
  const fields: Record<string, string> = { ...boxes, ...answers };
  const metaFormId = metaId(raw?.form_id) ?? hint.formId;
  const form = metaFormId
    ? await prisma.leadForm.upsert({
        where: { tenantId_metaFormId: { tenantId, metaFormId } },
        create: { tenantId, pageAssetId: page.assetId, metaFormId },
        update: {},
      })
    : null;
  const identity = extractIdentity(fields);
  const settings = form ? await getFormSettings(tenantId, form.id) : { consentAssumed: false };
  const isTest = await isTestLead({ pageMetaId: page.pageMetaId, leadId: hint.leadgenId, fields: Array.isArray(fieldData) ? (fieldData as { values?: unknown }[]) : answers }, now);
  const presentKeys = [...new Set([...mapFieldNames(fieldData), ...Object.keys(boxes)])];
  const known = form ? await rememberQuestions(tenantId, form.id, presentKeys) : emptyQuestionInfo(presentKeys);
  const consent = isTest ? NO_CONSENT : await leadConsent(tenantId, form ?? undefined, fields, page.token, metaFormId, known, settings.consentAssumed);
  const campaignMetaId = metaId(raw?.campaign_id);
  const created = raw?.created_time ? new Date(raw.created_time) : now;
  const createdAt = Number.isNaN(created.getTime()) || created.getTime() > now.getTime() ? now : created;
  const contact = isTest ? null : await upsertContact(tenantId, identity, consent, campaignMetaId, createdAt);

  let lead;
  try {
    lead = await prisma.lead.create({
      data: {
        tenantId,
        leadFormId: form?.id ?? null,
        leadgenId: hint.leadgenId,
        contactId: contact?.id ?? null,
        fields: fields as Prisma.InputJsonObject,
        campaignMetaId,
        adMetaId: metaId(raw?.ad_id),
        adsetMetaId: metaId(raw?.adset_id),
        source: "instant_form",
        platform: leadPlatform(raw?.platform),
        isOrganic: leadIsOrganic(raw?.is_organic),
        isTest,
        consentText: consent.given ? consent.text : null,
        consentAt: consent.given ? createdAt : null,
        createdAt,
      },
    });
  } catch {
    return null;
  }
  // D33: a test lead is listed (tagged Test) and nothing else happens.
  if (isTest) return lead.id;
  await routeNewLead(tenantId, lead).catch((e) => console.error("[leads] routing failed:", describeError(e)));
  // The first stage of the lead for Meta's conversion leads optimisation (the worker sends it with the Meta lead id).
  await queueConversion(tenantId, { leadId: lead.id, contactId: contact?.id ?? undefined, eventName: "Lead", eventTime: createdAt });
  await emitLeadCreated(tenantId, lead, metaFormId ?? null).catch(() => console.error("[leads] could not emit the lead.created event"));
  if (contact?.welcome) await startSequenceForLead(tenantId, lead).catch((e) => console.error("[leads] sequence start failed:", describeError(e)));
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

type FormRow = { id: string; origin?: string | null; spec?: unknown; consentText?: string | null };

/**
 * The lead's WhatsApp consent. A form built in Edwyz is read from the spec it was built from, so its WhatsApp box is known without
 * a Meta call: only that box's answer counts (the owner's other boxes and questions are left out of the check, so an unticked
 * "email offers" box cannot undo a ticked WhatsApp box), a form without the box gives no consent, and consent is never assumed for
 * it (D35), whatever a stored setting says. Any other form goes through consentOptions.
 */
async function leadConsent(tenantId: string, form: FormRow | undefined, fields: Record<string, string>, token: string, metaFormId: string | undefined, known: FormQuestionInfo, consentAssumed: boolean): Promise<Consent> {
  const built = form?.origin === "created" ? builtFormDefinitionKeys(form.spec) : null;
  if (built) {
    const own = Object.fromEntries(built.consentKeys.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    return detectConsent(own, form?.consentText, { consentAssumed: false, presentKeys: built.consentKeys, formConsentKeys: built.consentKeys, formChannelKeys: [], formHasConsentField: built.consentKeys.length > 0 });
  }
  return detectConsent(fields, form?.consentText, await consentOptions(tenantId, form, token, metaFormId, known, consentAssumed));
}

/**
 * Which questions of a form not built in Edwyz record consent. The question names come from the stored names of the form's leads
 * and this lead's answers; the labels come from the form definition read from Meta, because a consent question can have an opaque
 * key ("question_1" labelled "Receive WhatsApp updates"). The definition is read when it has not been read in the last 24 hours and
 * then stored; an unreadable definition falls back to the stored one, and with neither the form is simply not known to have no
 * consent question. consentAssumed (a tenant's statement that the form's consent text covers every lead) is honoured only when a
 * definition has been read and defines no consent question; unknown never assumes consent.
 */
async function consentOptions(tenantId: string, form: FormRow | undefined, token: string, metaFormId: string | undefined, known: FormQuestionInfo, consentAssumed: boolean): Promise<ConsentOptions> {
  const base: ConsentOptions = { consentAssumed: form?.origin === "created" ? false : consentAssumed, presentKeys: known.keys };
  let info = known;
  const fresh = info.definedAt !== null && Date.now() - info.definedAt < DEFINITION_TTL_MS;
  if (!fresh && metaFormId) {
    const def = await fetchFormDefinitionKeys(token, metaFormId);
    if (def) {
      info = { keys: [...new Set([...known.keys, ...def.questionKeys])], consentKeys: def.consentKeys, channelKeys: def.channelKeys, definedAt: Date.now() };
      if (form) await recordFormDefinition(tenantId, form.id, known, def).catch(() => undefined);
    }
  }
  if (info.consentKeys === null) return base;
  return { ...base, formConsentKeys: info.consentKeys, formChannelKeys: info.channelKeys, formHasConsentField: info.consentKeys.length + info.channelKeys.length > 0 };
}

function validDate(d: Date): Date {
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * The lead's contact, and whether the lead may get the WhatsApp welcome: consent detected on this lead (D35) and not withdrawn
 * before (an opted-out contact is never opted in again by a form).
 */
type ContactResult = { id: string; welcome: boolean };

const isUniqueViolation = (e: unknown) => isObject(e) && e.code === "P2002";

async function upsertContact(tenantId: string, identity: Identity, consent: Consent, campaignMetaId: string | null, at: Date, retried = false): Promise<ContactResult | null> {
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
    return { id: existing.id, welcome: consent.given && !existing.optedOutAt };
  }
  try {
    await assertWithinLimit(tenantId, "contacts");
  } catch {
    return null;
  }
  let created: { id: string };
  try {
    created = await prisma.contact.create({
      data: {
        tenantId,
        phone: identity.phone,
        name: identity.name,
        tags: consent.given ? tags : [...tags, "needs_opt_in"],
        attributes,
        ...(consent.given ? { optIn: true, optInSource: "lead_form", optInAt: when } : {}),
      },
    });
  } catch (e) {
    // The webhook and the backfill can race on the same person: the other one made the contact a moment ago.
    if (isUniqueViolation(e) && !retried) return upsertContact(tenantId, identity, consent, campaignMetaId, at, true);
    throw e;
  }
  if (consent.given) await recordChannelConsent(tenantId, created.id, { source: "lead_form", via: "lead_form" });
  void emitAutomationEvent({ type: "contact_created", tenantId, contactId: created.id });
  return { id: created.id, welcome: consent.given };
}
