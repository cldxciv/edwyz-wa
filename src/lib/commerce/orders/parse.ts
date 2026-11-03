/**
 * A WhatsApp cart as order lines (docs/specs/META-CATALOG-COMMERCE-SPEC.md 2.13, 3.3 H1, 4.4 OrderLine and 5.3 step 1).
 * Pure: no database, no network.
 *
 * Takes Meta's webhook `order` object as sent (`{catalog_id, text, product_items: [{product_retailer_id, quantity,
 * item_price, currency}]}`) or the ParsedOrder that describeOrder already made from it. Prices become minor units
 * (item_price is a JSON number or a decimal string in major units, VERIFY V-C18); a quantity is a whole number of at least 1;
 * at most 100 lines are kept, with a note when the cart had more. Everything in it came from the customer, so codes and the
 * note are cleaned and bounded, and a bad number never becomes a price.
 */
import type { ParsedOrder } from "@/lib/webhooks/payload";
import { webhookPriceToMinor } from "../catalog/money";
import type { OrderLine } from "../catalog/types";

/** Lines kept per order (7: "Webhook order lines capped (100)"). */
export const MAX_ORDER_LINES = 100;
/** No line may ask for more than this many of one product. */
export const MAX_LINE_QUANTITY = 100_000;
/** CommerceOrder.customerNote is at most 1,000 characters. */
export const MAX_ORDER_NOTE = 1000;

export type ParsedOrderLines = {
  /** The catalog the cart came from (Meta's id), or null. */
  catalogId: string | null;
  /** At most 100 lines, in the cart's order. Title and photo are filled from the product mirror later. */
  lines: OrderLine[];
  /** Items in the whole cart (quantities added up), including lines past the first 100. */
  itemCount: number;
  /** The cart's total in minor units, only when every line has a price in one currency. */
  totalMinor: string | null;
  currency: string | null;
  /** The customer's note, cleaned (untrusted: show it as their words). */
  customerNote: string | null;
  /** Lines past the first 100, which are counted but not kept. */
  droppedLines: number;
  /** Lines with no usable product code, which are left out. */
  invalidLines: number;
  /** A line for the order page when lines were left out, or null. */
  note: string | null;
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

/** A product code from the cart: printable, no spaces or "/", at most 100 characters; null when there is none. */
function codeOf(value: unknown): string | null {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
  const code = raw.replace(/[\s/\p{Cc}\p{Cf}]+/gu, "").slice(0, 100);
  return code || null;
}

/** A whole quantity from 1 to MAX_LINE_QUANTITY: fractions are cut, anything unusable is 1. */
export function orderQuantity(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_LINE_QUANTITY);
}

/** A currency code from the cart, or null. */
function currencyOf(value: unknown): string | null {
  const c = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/** The customer's note: control characters (other than line breaks) removed, at most 1,000 characters, null when empty. */
function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  return t ? [...t].slice(0, MAX_ORDER_NOTE).join("") : null;
}

type RawLine = { code: unknown; quantity: unknown; price: unknown; currency: unknown };

function rawLines(order: unknown): { catalogId: unknown; text: unknown; lines: RawLine[] } {
  const o = rec(order);
  if (Array.isArray(o.product_items)) {
    return {
      catalogId: o.catalog_id,
      text: o.text,
      lines: o.product_items.map((i) => {
        const r = rec(i);
        return { code: r.product_retailer_id, quantity: r.quantity, price: r.item_price, currency: r.currency };
      }),
    };
  }
  // describeOrder's ParsedOrder.
  const parsed = o as Partial<ParsedOrder>;
  return {
    catalogId: parsed.catalogId,
    text: parsed.text,
    lines: (Array.isArray(parsed.items) ? parsed.items : []).map((i) => {
      const r = rec(i);
      return { code: r.productRetailerId, quantity: r.quantity, price: r.itemPrice, currency: r.currency };
    }),
  };
}

/** Turns a webhook order (raw or describeOrder's ParsedOrder) into order lines, a count, a total and the customer's note. */
export function parseOrderLines(order: unknown): ParsedOrderLines {
  const raw = rawLines(order);
  const all: OrderLine[] = [];
  let invalidLines = 0;
  for (const line of raw.lines) {
    const retailerId = codeOf(line.code);
    if (!retailerId) {
      invalidLines += 1;
      continue;
    }
    const currency = currencyOf(line.currency);
    const price = webhookPriceToMinor(line.price, currency);
    all.push({ retailerId, quantity: orderQuantity(line.quantity), unitPriceMinor: price === null ? null : price.toString(), currency, title: null, imageUrl: null });
  }

  const itemCount = all.reduce((n, l) => n + l.quantity, 0);
  const currencies = new Set(all.map((l) => l.currency));
  const priced = all.length > 0 && all.every((l) => l.unitPriceMinor !== null) && currencies.size === 1;
  const totalMinor = priced ? all.reduce((sum, l) => sum + BigInt(l.unitPriceMinor as string) * BigInt(l.quantity), 0n).toString() : null;
  const droppedLines = Math.max(0, all.length - MAX_ORDER_LINES);
  const notes: string[] = [];
  if (droppedLines > 0) notes.push(`This order had ${all.length} products. Edwyz kept the first ${MAX_ORDER_LINES}; the total counts them all.`);
  if (invalidLines > 0) notes.push(`${invalidLines} ${invalidLines === 1 ? "line" : "lines"} of the cart had no product code and ${invalidLines === 1 ? "was" : "were"} left out.`);
  const catalogId = codeOf(raw.catalogId);
  return {
    catalogId,
    lines: all.slice(0, MAX_ORDER_LINES),
    itemCount,
    totalMinor,
    currency: priced ? (all[0].currency as string) : null,
    customerNote: noteOf(raw.text),
    droppedLines,
    invalidLines,
    note: notes.length ? notes.join(" ") : null,
  };
}

/** A line's total in minor units, or null when its price is unknown. */
export function lineTotalMinor(line: Pick<OrderLine, "unitPriceMinor" | "quantity">): string | null {
  return line.unitPriceMinor === null ? null : (BigInt(line.unitPriceMinor) * BigInt(line.quantity)).toString();
}
