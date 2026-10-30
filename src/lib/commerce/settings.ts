import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { templateVariables } from "@/lib/templates/validate";
import { unsupportedReason } from "@/lib/broadcasts/components";
import { DEFAULT_GAPS_MIN, validGaps } from "./schedule";

export type CommerceSettings = {
  enabled: boolean;
  templateId: string | null;
  phoneNumberId: string | null;
  cartGapsMin: number[];
  checkoutGapsMin: number[];
};

export const DEFAULT_SETTINGS: CommerceSettings = {
  enabled: false,
  templateId: null,
  phoneNumberId: null,
  cartGapsMin: DEFAULT_GAPS_MIN.cart,
  checkoutGapsMin: DEFAULT_GAPS_MIN.checkout,
};

/** Template body variables are mapped by position: 1 customer first name, 2 cart total, 3 checkout URL. */
export const MAX_TEMPLATE_VARIABLES = 3;

const key = (tenantId: string, storeId: string) => `commerce:settings:${tenantId}:${storeId}`;

export const gapsFor = (settings: CommerceSettings, stage: string): number[] =>
  stage === "cart" ? settings.cartGapsMin : settings.checkoutGapsMin;

function coerce(raw: unknown): CommerceSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    templateId: typeof r.templateId === "string" ? r.templateId : null,
    phoneNumberId: typeof r.phoneNumberId === "string" ? r.phoneNumberId : null,
    cartGapsMin: validGaps(r.cartGapsMin) ?? DEFAULT_SETTINGS.cartGapsMin,
    checkoutGapsMin: validGaps(r.checkoutGapsMin) ?? DEFAULT_SETTINGS.checkoutGapsMin,
  };
}

export async function getSettings(tenantId: string, storeId: string): Promise<CommerceSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: key(tenantId, storeId) } });
  return coerce(row?.value);
}

export async function deleteSettings(tenantId: string, storeId: string) {
  await prisma.platformSetting.deleteMany({ where: { key: key(tenantId, storeId) } });
}

export function bodyVariableCount(components: unknown): number {
  const list = Array.isArray(components) ? components : [];
  const body = list.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "BODY") as { text?: string } | undefined;
  const vars = templateVariables(body?.text ?? "");
  return vars.length ? Math.max(...vars) : 0;
}

function optionalId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) throw new HttpError(400, `${field} is invalid.`);
  return value;
}

function gapsInput(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  const gaps = validGaps(value);
  if (!gaps) throw new HttpError(400, `${field} must be 3 whole numbers of minutes between 1 and 4320.`);
  return gaps;
}

async function assertTemplate(tenantId: string, templateId: string) {
  const template = await prisma.template.findFirst({ where: { id: templateId, tenantId }, select: { status: true, components: true } });
  if (!template) throw new HttpError(400, "Template not found.");
  if (template.status !== "approved") throw new HttpError(400, "The template must be approved by Meta.");
  if (bodyVariableCount(template.components) > MAX_TEMPLATE_VARIABLES) {
    throw new HttpError(400, "The template can use at most 3 variables: first name, cart total, checkout link.");
  }
  const reason = unsupportedReason(template.components);
  if (reason) throw new HttpError(400, reason);
}

export async function saveSettings(tenantId: string, storeId: string, raw: Record<string, unknown>): Promise<CommerceSettings> {
  const current = await getSettings(tenantId, storeId);
  const templateId = optionalId(raw.templateId, "templateId");
  const phoneNumberId = optionalId(raw.phoneNumberId, "phoneNumberId");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
  const next: CommerceSettings = {
    enabled: (raw.enabled as boolean | undefined) ?? current.enabled,
    templateId: templateId === undefined ? current.templateId : templateId,
    phoneNumberId: phoneNumberId === undefined ? current.phoneNumberId : phoneNumberId,
    cartGapsMin: gapsInput(raw.cartGapsMin, "cartGapsMin") ?? current.cartGapsMin,
    checkoutGapsMin: gapsInput(raw.checkoutGapsMin, "checkoutGapsMin") ?? current.checkoutGapsMin,
  };
  if (next.templateId) await assertTemplate(tenantId, next.templateId);
  if (next.phoneNumberId) {
    const phone = await prisma.phoneNumber.findFirst({ where: { id: next.phoneNumberId, tenantId }, select: { id: true } });
    if (!phone) throw new HttpError(400, "Phone number not found.");
  }
  if (next.enabled && (!next.templateId || !next.phoneNumberId)) {
    throw new HttpError(400, "Choose a template and a WhatsApp number before turning reminders on.");
  }
  await prisma.platformSetting.upsert({
    where: { key: key(tenantId, storeId) },
    create: { key: key(tenantId, storeId), value: next },
    update: { value: next },
  });
  return next;
}
