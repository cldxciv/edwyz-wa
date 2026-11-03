import { type BuiltComponent, type VariableMap, buildRecipientComponents, templateSlots } from "@/lib/broadcasts/mapping";
import { mayReceive } from "@/lib/contacts/opt-out";
import { prisma } from "@/lib/db";
import { sendTemplateMessage } from "@/lib/inbox/service";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { HttpError } from "@/lib/tenancy";
import { getSettings, gapsFor, reminderSupportReason, type CommerceSettings } from "./settings";
import { isExpired, nextReminderAfter } from "./schedule";

const BATCH = 20;
const DEFER_MS = 30 * 60_000;
const RETRY_MS = 10 * 60_000;

type CartRow = {
  id: string;
  tenantId: string;
  storeId: string;
  phone: string | null;
  items: unknown;
  totalMinor: number | null;
  currency: string | null;
  checkoutUrl: string | null;
  stage: string;
  remindersSent: number;
  nextReminderAt: Date | null;
  createdAt: Date;
};

export function formatTotal(totalMinor: number | null, currency: string | null): string {
  if (totalMinor === null) return "your items";
  const amount = totalMinor / 100;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency ?? "INR" }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toFixed(2)}`.trim();
  }
}

function firstNameOf(items: unknown, contactName: string | null): string {
  const stored = items && typeof items === "object" ? (items as { firstName?: unknown }).firstName : null;
  const raw = typeof stored === "string" && stored.trim() ? stored : (contactName ?? "");
  return raw.trim().split(/\s+/)[0] || "there";
}

type ReminderValues = { firstName: string; total: string; url: string };

/**
 * What a website button's {{1}} becomes: the part of the checkout link after the button's fixed start. A button that is just the
 * store's address ("https://shop.example/{{1}}") gets the checkout link's path, which works on a custom domain too. Null when the
 * checkout link does not fit the button.
 */
export function checkoutSuffix(buttonUrl: string, checkoutUrl: string): string | null {
  const base = buttonUrl.split("{{")[0];
  if (base && checkoutUrl.startsWith(base) && checkoutUrl.length > base.length) return checkoutUrl.slice(base.length);
  try {
    const button = new URL(base);
    const checkout = new URL(checkoutUrl);
    if (button.pathname !== "/" || button.search) return null;
    const rest = `${checkout.pathname}${checkout.search}`.replace(/^\/+/, "");
    return rest || null;
  } catch {
    return null;
  }
}

/** The reminder's fixed value mapping: {{1}} first name, {{2}} cart total, {{3}} checkout link, and the checkout link in website buttons. */
function reminderMap(templateComponents: unknown, values: ReminderValues): VariableMap | null {
  const byPosition: Record<string, string> = { "1": values.firstName, "2": values.total, "3": values.url };
  const buttons = (Array.isArray(templateComponents) ? templateComponents : []).find((c) => c && (c as { type?: string }).type === "BUTTONS") as { buttons?: { url?: unknown }[] } | undefined;
  const map: VariableMap = {};
  for (const slot of templateSlots(templateComponents)) {
    if (slot.kind === "body" && byPosition[slot.key]) map[slot.key] = { source: "static", value: byPosition[slot.key] };
    else if (slot.kind === "button_url") {
      const url = buttons?.buttons?.[slot.buttonIndex]?.url;
      const suffix = typeof url === "string" ? checkoutSuffix(url, values.url) : null;
      if (!suffix) return null;
      map[slot.key] = { source: "static", value: suffix };
    } else return null;
  }
  return map;
}

/**
 * The send components of a reminder, through the same value mapping broadcasts use. Throws HttpError(422) when the template cannot
 * be filled (settings refuse such templates; this catches one changed at Meta since, or a checkout link that does not fit its button).
 */
export function buildReminderComponents(templateComponents: unknown, values: ReminderValues): BuiltComponent[] {
  const reason = reminderSupportReason(templateComponents);
  const map = reason ? null : reminderMap(templateComponents, values);
  const built = map ? buildRecipientComponents(templateComponents, { name: null, attributes: {} }, map, "fail") : null;
  if (!built?.ok) throw new HttpError(422, reason ?? "The reminder template could not be filled in for this cart.");
  return built.components;
}

const setStatus = (cart: CartRow, status: string) =>
  prisma.abandonedCart.updateMany({ where: { id: cart.id, tenantId: cart.tenantId, status: "open" }, data: { status, nextReminderAt: null } });

const defer = (cart: CartRow, ms: number, now: Date) =>
  prisma.abandonedCart.updateMany({
    where: { id: cart.id, tenantId: cart.tenantId, status: "open", remindersSent: cart.remindersSent },
    data: { nextReminderAt: new Date(now.getTime() + ms) },
  });

async function usableTemplate(tenantId: string, settings: CommerceSettings) {
  if (!settings.enabled || !settings.templateId || !settings.phoneNumberId) return null;
  const template = await prisma.template.findFirst({
    where: { id: settings.templateId, tenantId, status: "approved" },
    select: { name: true, language: true, components: true },
  });
  return template;
}

/**
 * Claims the cart by moving it to its next state in one conditional update, so two workers cannot both win.
 * At most once: a reminder is counted before it is queued and handed back only when queuing fails transiently.
 */
async function claim(cart: CartRow, settings: CommerceSettings, now: Date): Promise<boolean> {
  const sent = cart.remindersSent + 1;
  const due = cart.nextReminderAt ?? now;
  const next = nextReminderAfter(due, sent, gapsFor(settings, cart.stage));
  const { count } = await prisma.abandonedCart.updateMany({
    where: { id: cart.id, tenantId: cart.tenantId, status: "open", remindersSent: cart.remindersSent, nextReminderAt: cart.nextReminderAt },
    data: { remindersSent: sent, nextReminderAt: next },
  });
  return count === 1;
}

const giveBack = (cart: CartRow, now: Date) =>
  prisma.abandonedCart.updateMany({
    where: { id: cart.id, tenantId: cart.tenantId, status: "open", remindersSent: cart.remindersSent + 1 },
    data: { remindersSent: cart.remindersSent, nextReminderAt: new Date(now.getTime() + RETRY_MS) },
  });

export type Outcome = "sent" | "expired" | "opted_out" | "replied" | "deferred" | "lost_claim" | "failed";

export async function processCart(cart: CartRow, now: Date): Promise<Outcome> {
  if (!(await tenantMayRunBackground(cart.tenantId))) {
    await defer(cart, DEFER_MS, now);
    return "deferred";
  }
  // A disabled store, or one demoted until its owner proves control again, sends nothing; its carts wait (and age out) instead.
  const store = await prisma.shopifyStore.findFirst({ where: { id: cart.storeId, tenantId: cart.tenantId, status: "active" }, select: { id: true } });
  if (!store) {
    await defer(cart, DEFER_MS, now);
    return "deferred";
  }
  if (!cart.phone || isExpired(cart.createdAt, now)) {
    await setStatus(cart, "expired");
    return "expired";
  }
  const settings = await getSettings(cart.tenantId, cart.storeId);
  const template = await usableTemplate(cart.tenantId, settings);
  if (!template || !settings.phoneNumberId) {
    await defer(cart, DEFER_MS, now);
    return "deferred";
  }

  const contact = await prisma.contact.findFirst({
    where: { tenantId: cart.tenantId, phone: cart.phone },
    select: { id: true, name: true, optIn: true, optedOutAt: true },
  });
  // A cart reminder is marketing whatever its template says (Meta counts cart recovery as marketing), so it needs the WhatsApp
  // opt-in recorded in Edwyz (a Shopify marketing consent never counts) and no opt-out (lib/contacts/opt-out.ts).
  if (!contact || !contact.optIn || !mayReceive(contact, "marketing")) {
    await setStatus(cart, "opted_out");
    return "opted_out";
  }
  const replied = await prisma.conversation.findFirst({
    where: { tenantId: cart.tenantId, contactId: contact.id, lastInboundAt: { gt: cart.createdAt } },
    select: { id: true },
  });
  if (replied) {
    await setStatus(cart, "replied");
    return "replied";
  }
  if (!cart.checkoutUrl) {
    await setStatus(cart, "expired");
    return "expired";
  }

  if (!(await claim(cart, settings, now))) return "lost_claim";
  try {
    const components = buildReminderComponents(template.components, {
      firstName: firstNameOf(cart.items, contact.name),
      total: formatTotal(cart.totalMinor, cart.currency),
      url: cart.checkoutUrl,
    });
    await sendTemplateMessage({
      tenantId: cart.tenantId,
      phoneNumberId: settings.phoneNumberId,
      contactId: contact.id,
      templateName: template.name,
      language: template.language,
      components,
      origin: "commerce",
    });
    return "sent";
  } catch (error) {
    if (error instanceof HttpError) {
      await prisma.abandonedCart.updateMany({ where: { id: cart.id, tenantId: cart.tenantId, status: "open" }, data: { status: "expired", nextReminderAt: null } });
      return "failed";
    }
    await giveBack(cart, now);
    return "failed";
  }
}

/** Sends due reminders in small batches. Safe to run in several processes. */
export async function processDueReminders(now = new Date(), limit = BATCH): Promise<Record<Outcome, number>> {
  const due = await prisma.abandonedCart.findMany({
    where: { status: "open", nextReminderAt: { lte: now } },
    orderBy: { nextReminderAt: "asc" },
    take: limit,
    select: {
      id: true, tenantId: true, storeId: true, phone: true, items: true, totalMinor: true, currency: true,
      checkoutUrl: true, stage: true, remindersSent: true, nextReminderAt: true, createdAt: true,
    },
  });
  const tally: Record<Outcome, number> = { sent: 0, expired: 0, opted_out: 0, replied: 0, deferred: 0, lost_claim: 0, failed: 0 };
  for (const cart of due) {
    try {
      tally[await processCart(cart, now)] += 1;
    } catch {
      tally.failed += 1;
    }
  }
  return tally;
}

/** Closes open carts older than the lifetime that were never reminded, so they leave the due scan. */
export async function expireOldCarts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.abandonedCart.updateMany({
    where: { status: "open", createdAt: { lt: cutoff } },
    data: { status: "expired", nextReminderAt: null },
  });
  return count;
}
