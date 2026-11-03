import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { positionalCount, readPlaceholders } from "@/lib/templates/validate";
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

type Component = Record<string, unknown>;
const list = (components: unknown): Component[] => (Array.isArray(components) ? (components as Component[]).filter((c) => c && typeof c === "object") : []);

/**
 * The highest {{n}} in the template's message (0 when it has none), or null when the template uses named placeholders. Never
 * throws: synced templates are Meta's, and one with {{first_name}} must not break the reminder settings for every other template.
 */
export function bodyVariableCount(components: unknown): number | null {
  return positionalCount(list(components).find((c) => c.type === "BODY")?.text ?? "");
}

const REMINDER_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);

/**
 * Why an approved template cannot be a cart reminder, in the merchant's words, or null when it can. Reminders fill the message's
 * {{1}} first name, {{2}} cart total and {{3}} checkout link, and a website button's placeholder with the checkout link.
 */
export function reminderSupportReason(components: unknown): string | null {
  const all = list(components);
  const count = bodyVariableCount(components);
  if (count === null) return "It uses named placeholders. Reminders fill numbered ones: {{1}} first name, {{2}} cart total, {{3}} checkout link.";
  if (count > MAX_TEMPLATE_VARIABLES) return "It has more than 3 placeholders. Reminders fill only {{1}} first name, {{2}} cart total and {{3}} checkout link.";
  const header = all.find((c) => c.type === "HEADER");
  const format = typeof header?.format === "string" ? header.format.toUpperCase() : "TEXT";
  if (header && format !== "TEXT") return "It shows a picture, video, document or location at the top, which reminders cannot fill in yet.";
  if (header && readPlaceholders(header.text).format !== "none") return "Its header has a placeholder, which reminders cannot fill in.";
  if (all.some((c) => c.type === "CAROUSEL" || c.type === "LIMITED_TIME_OFFER")) return "Carousel and limited-time-offer templates cannot be used for reminders.";
  const buttons = (all.find((c) => c.type === "BUTTONS")?.buttons as Component[] | undefined) ?? [];
  for (const b of buttons) {
    const type = typeof b?.type === "string" ? b.type.toUpperCase() : "";
    if (type === "COPY_CODE") return "It has a coupon-code button, which reminders cannot fill in yet.";
    if (type && !REMINDER_BUTTONS.has(type)) return "It has a button that reminders cannot fill in. Use quick replies, a call button or a website button.";
    if (type === "URL" && typeof b.url === "string" && /^https:\/\/www\.whatsapp\.com\/otp\//i.test(b.url)) return "Login-code templates cannot be used for reminders.";
  }
  return null;
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
  const reason = reminderSupportReason(template.components);
  if (reason) throw new HttpError(400, `This template cannot be a reminder. ${reason}`);
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
