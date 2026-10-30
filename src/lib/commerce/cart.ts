import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/contacts/phone";
import { firstReminderAt, type CartStage } from "./schedule";
import { gapsFor, getSettings } from "./settings";

export type CartInput = {
  externalId: string;
  altIds: string[];
  phone: string;
  firstName: string | null;
  lines: { title: string; quantity: number; price: string | null }[];
  totalMinor: number | null;
  currency: string | null;
  checkoutUrl: string | null;
  stage: CartStage;
  completed: boolean;
  eventAt: Date;
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
};

function pickPhone(body: Record<string, unknown>): string | null {
  const candidates = [body.phone, rec(body.customer).phone, rec(body.shipping_address).phone, rec(body.billing_address).phone];
  for (const c of candidates) {
    const normalized = typeof c === "string" ? normalizePhone(c) : null;
    if (normalized) return normalized;
  }
  return null;
}

function pickFirstName(body: Record<string, unknown>): string | null {
  return text(rec(body.customer).first_name, 40) ?? text(rec(body.shipping_address).first_name, 40) ?? text(rec(body.billing_address).first_name, 40);
}

function toMinor(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 20_000_000) return null;
  return Math.round(n * 100);
}

function pickEventAt(body: Record<string, unknown>, now: Date): Date {
  const raw = typeof body.updated_at === "string" ? Date.parse(body.updated_at) : NaN;
  if (!Number.isFinite(raw) || raw > now.getTime()) return now;
  return new Date(raw);
}

function pickLines(body: Record<string, unknown>) {
  const list = Array.isArray(body.line_items) ? body.line_items.slice(0, 20) : [];
  return list.map((item) => {
    const i = rec(item);
    const quantity = Number(i.quantity);
    return { title: text(i.title, 120) ?? "Item", quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1, price: text(i.price, 20) };
  });
}

function pickCheckoutUrl(value: unknown): string | null {
  const url = text(value, 2000);
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Parses a checkouts/create or checkouts/update body. Returns null when there is no identifier or no usable phone. */
export function parseCheckout(body: Record<string, unknown>, now = new Date()): CartInput | null {
  const token = text(body.token, 120);
  const id = text(body.id, 40);
  const externalId = token ?? id;
  const phone = pickPhone(body);
  if (!externalId || !phone) return null;
  return {
    externalId,
    altIds: [token, id].filter((v): v is string => Boolean(v) && v !== externalId),
    phone,
    firstName: pickFirstName(body),
    lines: pickLines(body),
    totalMinor: toMinor(body.total_price),
    currency: text(body.currency ?? body.presentment_currency, 3)?.toUpperCase() ?? null,
    checkoutUrl: pickCheckoutUrl(body.abandoned_checkout_url),
    stage: rec(body.shipping_address).address1 ? "checkout" : "cart",
    completed: Boolean(body.completed_at),
    eventAt: pickEventAt(body, now),
  };
}

/** Order bodies reference the checkout they came from. */
export function checkoutIdsFromOrder(body: Record<string, unknown>): string[] {
  return [text(body.checkout_token, 120), text(body.checkout_id, 40)].filter((v): v is string => Boolean(v));
}

async function findContactId(tenantId: string, phone: string): Promise<string | null> {
  const contact = await prisma.contact.findFirst({ where: { tenantId, phone }, select: { id: true } });
  return contact?.id ?? null;
}

type Scope = { tenantId: string; storeId: string };

export async function markRecovered(scope: Scope, externalIds: string[]): Promise<number> {
  if (externalIds.length === 0) return 0;
  const { count } = await prisma.abandonedCart.updateMany({
    where: { ...scope, externalId: { in: externalIds }, status: "open" },
    data: { status: "recovered", nextReminderAt: null },
  });
  return count;
}

/** Idempotent: a redelivered event rewrites the same values. Closed carts are never reopened. */
export async function ingestCheckout(scope: Scope, input: CartInput): Promise<"created" | "updated" | "ignored" | "recovered"> {
  if (input.completed) {
    return (await markRecovered(scope, [input.externalId, ...input.altIds])) > 0 ? "recovered" : "ignored";
  }
  const existing = await prisma.abandonedCart.findFirst({
    where: { ...scope, externalId: { in: [input.externalId, ...input.altIds] } },
    select: { id: true, status: true, remindersSent: true, nextReminderAt: true },
  });
  const settings = await getSettings(scope.tenantId, scope.storeId);
  const candidate = settings.enabled ? firstReminderAt(input.eventAt, gapsFor(settings, input.stage)) : null;
  const common = {
    contactId: await findContactId(scope.tenantId, input.phone),
    phone: input.phone,
    items: { firstName: input.firstName, lines: input.lines },
    totalMinor: input.totalMinor,
    currency: input.currency,
    checkoutUrl: input.checkoutUrl,
    stage: input.stage,
  };

  if (!existing) {
    await prisma.abandonedCart.create({ data: { ...scope, externalId: input.externalId, ...common, nextReminderAt: candidate } });
    return "created";
  }
  if (existing.status !== "open") return "ignored";

  const keepEarlier = existing.remindersSent > 0 || !candidate;
  const nextReminderAt = keepEarlier ? existing.nextReminderAt : existing.nextReminderAt && existing.nextReminderAt > candidate ? existing.nextReminderAt : candidate;
  await prisma.abandonedCart.updateMany({
    where: { id: existing.id, ...scope, status: "open" },
    data: { ...common, nextReminderAt },
  });
  return "updated";
}
