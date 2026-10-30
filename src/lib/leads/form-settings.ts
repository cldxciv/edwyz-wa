import { prisma } from "@/lib/db";

export type FormSettings = { consentAssumed: boolean };

const keyFor = (tenantId: string, formId: string) => `leads:form-settings:${tenantId}:${formId}`;

const parse = (value: unknown): FormSettings => ({ consentAssumed: (value as { consentAssumed?: unknown } | null)?.consentAssumed === true });

/** Per-form settings live in PlatformSetting because LeadForm has no settings column. The default is everything off. */
export async function getFormSettings(tenantId: string, formId: string): Promise<FormSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: keyFor(tenantId, formId) } });
  return parse(row?.value);
}

export async function getFormSettingsMany(tenantId: string, formIds: string[]): Promise<Map<string, FormSettings>> {
  if (formIds.length === 0) return new Map();
  const rows = (await prisma.platformSetting.findMany({ where: { key: { in: formIds.map((id) => keyFor(tenantId, id)) } } })) ?? [];
  return new Map(rows.map((r) => [r.key.slice(keyFor(tenantId, "").length), parse(r.value)]));
}

export async function setFormSettings(tenantId: string, formId: string, settings: FormSettings): Promise<void> {
  const value = { consentAssumed: settings.consentAssumed };
  await prisma.platformSetting.upsert({ where: { key: keyFor(tenantId, formId) }, create: { key: keyFor(tenantId, formId), value }, update: { value } });
}

const MAX_QUESTION_KEYS = 100;
const questionKeyFor = (tenantId: string, formId: string) => `leads:form-questions:${tenantId}:${formId}`;

/** What is stored per form: the question names seen in its leads, and the consent questions read from the Meta form definition (null until the definition has been read). */
export type FormQuestionInfo = { keys: string[]; consentKeys: string[] | null; channelKeys: string[]; definedAt: number | null };

export const emptyQuestionInfo = (keys: string[] = []): FormQuestionInfo => ({ keys, consentKeys: null, channelKeys: [], definedAt: null });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string").slice(0, MAX_QUESTION_KEYS) : []);

const parseInfo = (value: unknown): FormQuestionInfo => {
  const v = (value ?? {}) as { keys?: unknown; consentKeys?: unknown; channelKeys?: unknown; definedAt?: unknown };
  const defined = Array.isArray(v.consentKeys) && typeof v.definedAt === "number" && Number.isFinite(v.definedAt);
  return { keys: strings(v.keys), consentKeys: defined ? strings(v.consentKeys) : null, channelKeys: defined ? strings(v.channelKeys) : [], definedAt: defined ? (v.definedAt as number) : null };
};

const toValue = (info: FormQuestionInfo) => ({
  keys: info.keys,
  ...(info.consentKeys && info.definedAt !== null ? { consentKeys: info.consentKeys, channelKeys: info.channelKeys, definedAt: info.definedAt } : {}),
});

/** Stored question information of each form. Unknown forms are absent from the map. */
export async function getFormQuestionInfoMany(tenantId: string, formIds: string[]): Promise<Map<string, FormQuestionInfo>> {
  if (formIds.length === 0) return new Map();
  const prefix = questionKeyFor(tenantId, "");
  const rows = (await prisma.platformSetting.findMany({ where: { key: { in: formIds.map((id) => questionKeyFor(tenantId, id)) } } })) ?? [];
  return new Map(rows.map((r) => [r.key.slice(prefix.length), parseInfo(r.value)]));
}

/** Question names of each form as seen in its leads. Unknown forms are absent from the map. */
export async function getFormQuestionKeysMany(tenantId: string, formIds: string[]): Promise<Map<string, string[]>> {
  return new Map([...(await getFormQuestionInfoMany(tenantId, formIds))].map(([id, info]) => [id, info.keys]));
}

const save = (tenantId: string, formId: string, info: FormQuestionInfo) => {
  const value = toValue(info);
  return prisma.platformSetting.upsert({ where: { key: questionKeyFor(tenantId, formId) }, create: { key: questionKeyFor(tenantId, formId), value }, update: { value } });
};

/**
 * Remembers the question names a form's leads carry, starting with its first lead, so later decisions about consent can tell
 * which questions the form defines even when a lead leaves an optional one out. Returns the merged record, keeping any
 * definition already read. Kept apart from the per-form settings so an ingest never overwrites what an admin just saved there.
 */
export async function recordFormQuestionKeys(tenantId: string, formId: string, seen: string[], known: FormQuestionInfo | undefined): Promise<FormQuestionInfo> {
  const before = known ?? (await getFormQuestionInfoMany(tenantId, [formId])).get(formId) ?? emptyQuestionInfo();
  const merged = { ...before, keys: [...new Set([...before.keys, ...seen])].slice(0, MAX_QUESTION_KEYS) };
  if (merged.keys.length !== before.keys.length || before.keys.length === 0) await save(tenantId, formId, merged);
  return merged;
}

/** Stores what the Meta form definition says about consent next to the question names, with the time it was read. */
export async function recordFormDefinition(tenantId: string, formId: string, before: FormQuestionInfo, def: { questionKeys: string[]; consentKeys: string[]; channelKeys: string[] }, now = Date.now()): Promise<FormQuestionInfo> {
  const next: FormQuestionInfo = {
    keys: [...new Set([...before.keys, ...def.questionKeys])].slice(0, MAX_QUESTION_KEYS),
    consentKeys: def.consentKeys.slice(0, MAX_QUESTION_KEYS),
    channelKeys: def.channelKeys.slice(0, MAX_QUESTION_KEYS),
    definedAt: now,
  };
  await save(tenantId, formId, next);
  return next;
}
