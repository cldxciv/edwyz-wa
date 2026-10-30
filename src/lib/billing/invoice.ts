import { prisma } from "@/lib/db";
import { getSettings, type PlatformSettings } from "@/lib/platform-settings";

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GST state codes keyed by lower-case state or union territory name. */
export const STATE_CODES: Record<string, string> = {
  "jammu and kashmir": "01", "himachal pradesh": "02", punjab: "03", chandigarh: "04", uttarakhand: "05", haryana: "06", delhi: "07",
  rajasthan: "08", "uttar pradesh": "09", bihar: "10", sikkim: "11", "arunachal pradesh": "12", nagaland: "13", manipur: "14",
  mizoram: "15", tripura: "16", meghalaya: "17", assam: "18", "west bengal": "19", jharkhand: "20", odisha: "21", chhattisgarh: "22",
  "madhya pradesh": "23", gujarat: "24", "dadra and nagar haveli and daman and diu": "26", maharashtra: "27", "andhra pradesh": "37",
  karnataka: "29", goa: "30", lakshadweep: "31", kerala: "32", "tamil nadu": "33", puducherry: "34", "andaman and nicobar islands": "35",
  telangana: "36", ladakh: "38",
};

export function isValidGstin(value: string): boolean {
  return GSTIN_PATTERN.test(value) && Object.values(STATE_CODES).includes(value.slice(0, 2));
}

export function stateCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase().replace(/&/g, "and");
  return STATE_CODES[key] ?? null;
}

/** Place of supply: the GSTIN prefix when the buyer has one, else the state named in the address text. */
export function buyerStateCode(gstin: string | null | undefined, address: string | null | undefined): string | null {
  if (gstin && isValidGstin(gstin)) return gstin.slice(0, 2);
  const text = (address ?? "").toLowerCase().replace(/&/g, "and");
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (text.includes(name) && name.length > bestLen) {
      best = code;
      bestLen = name.length;
    }
  }
  return best;
}

/** April to March financial year in India Standard Time, as "2026-27". */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 3_600_000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(5, "0")}`;
}

export function nextSequence(lastNumber: string | null): number {
  if (!lastNumber) return 1;
  const n = Number(lastNumber.split("/").pop());
  return Number.isInteger(n) && n > 0 ? n + 1 : 1;
}

/** Splits a GST-inclusive total into taxable value and GST. Taxable is rounded to the nearest paisa and GST is the remainder. */
export function splitInclusive(totalPaise: number, gstRateBps: number): { amountPaise: number; gstPaise: number; totalPaise: number } {
  const amountPaise = Math.round((totalPaise * 10_000) / (10_000 + gstRateBps));
  return { amountPaise, gstPaise: totalPaise - amountPaise, totalPaise };
}

export type TaxLines =
  | { kind: "cgst_sgst"; cgstPaise: number; sgstPaise: number }
  | { kind: "igst"; igstPaise: number }
  | { kind: "none" };

export function taxLines(gstPaise: number, sellerStateCode: string, buyerState: string | null): TaxLines {
  if (gstPaise === 0) return { kind: "none" };
  const trimmed = sellerStateCode.trim();
  const seller = trimmed ? trimmed.padStart(2, "0") : "";
  if (seller && buyerState && seller === buyerState) {
    const cgstPaise = Math.floor(gstPaise / 2);
    return { kind: "cgst_sgst", cgstPaise, sgstPaise: gstPaise - cgstPaise };
  }
  return { kind: "igst", igstPaise: gstPaise };
}

/** An invoice is a tax invoice only when the seller has both a GSTIN and a state code configured. */
export function isProforma(settings: Pick<PlatformSettings, "sellerGstin" | "sellerStateCode">): boolean {
  return !settings.sellerGstin.trim() || !settings.sellerStateCode.trim();
}

export function documentTitle(settings: Pick<PlatformSettings, "sellerGstin" | "sellerStateCode">): string {
  return isProforma(settings) ? "Proforma, not a tax invoice" : "Tax invoice";
}

type InvoiceRow = {
  number: string;
  status: string;
  planName: string;
  amountPaise: number;
  gstRateBps: number;
  gstPaise: number;
  totalPaise: number;
  currency: string;
  customerName: string | null;
  customerGstin: string | null;
  customerAddress: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  issuedAt: Date;
  paidAt: Date | null;
};

/**
 * What was true when the invoice was issued, kept apart from the Invoice row (which has no columns for it) in a PlatformSetting row
 * keyed by the invoice number. A document later shows the status, seller details and tax split it was issued with, so setting the
 * seller GSTIN afterwards never turns an old proforma into a tax invoice and moving the seller state never re-splits old tax.
 * Invoices issued before this existed have no snapshot and fall back to the current settings.
 */
export type InvoiceMeta = {
  v: 1;
  proforma: boolean;
  sellerName: string;
  sellerAddress: string;
  sellerGstin: string;
  sellerStateCode: string;
  /** Place of supply when issued; null when the buyer's state was unknown. */
  buyerStateCode: string | null;
};

export const invoiceMetaKey = (number: string) => `invoice-meta:${number}`;

export function snapshotMeta(settings: PlatformSettings, buyerState: string | null): InvoiceMeta {
  return {
    v: 1,
    proforma: isProforma(settings),
    sellerName: settings.sellerLegalName,
    sellerAddress: settings.sellerAddress,
    sellerGstin: settings.sellerGstin,
    sellerStateCode: settings.sellerStateCode,
    buyerStateCode: buyerState,
  };
}

function isInvoiceMeta(value: unknown): value is InvoiceMeta {
  const m = value as Partial<InvoiceMeta> | null;
  return Boolean(m && m.v === 1 && typeof m.proforma === "boolean" && typeof m.sellerStateCode === "string" && typeof m.sellerGstin === "string");
}

export async function readInvoiceMeta(number: string): Promise<InvoiceMeta | null> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: invoiceMetaKey(number) } });
    return isInvoiceMeta(row?.value) ? row.value : null;
  } catch {
    return null;
  }
}

async function writeInvoiceMeta(number: string, meta: InvoiceMeta): Promise<void> {
  try {
    await prisma.platformSetting.upsert({ where: { key: invoiceMetaKey(number) }, create: { key: invoiceMetaKey(number), value: meta }, update: { value: meta } });
  } catch {
    console.warn("[billing] could not store the invoice snapshot");
  }
}

export function buildInvoiceView(invoice: InvoiceRow, settings: PlatformSettings, meta?: InvoiceMeta | null) {
  const proforma = meta ? meta.proforma : isProforma(settings);
  const sellerGstin = meta ? meta.sellerGstin : settings.sellerGstin;
  const sellerState = meta ? meta.sellerStateCode : settings.sellerStateCode;
  const buyerState = meta ? meta.buyerStateCode : buyerStateCode(invoice.customerGstin, invoice.customerAddress);
  return {
    title: proforma ? "Proforma, not a tax invoice" : "Tax invoice",
    proforma,
    seller: {
      name: meta ? meta.sellerName : settings.sellerLegalName,
      address: meta ? meta.sellerAddress : settings.sellerAddress,
      gstin: proforma ? null : sellerGstin,
    },
    buyer: { name: invoice.customerName, gstin: invoice.customerGstin, address: invoice.customerAddress },
    tax: taxLines(invoice.gstPaise, sellerState, buyerState),
    invoice,
  };
}

/** The document for one stored invoice, using the snapshot taken when it was issued. */
export async function loadInvoiceView(invoice: InvoiceRow) {
  const [settings, meta] = await Promise.all([getSettings(), readInvoiceMeta(invoice.number)]);
  return buildInvoiceView(invoice, settings, meta);
}

export function formatMoney(paise: number, currency = "INR"): string {
  const value = (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "INR" ? `Rs ${value}` : `${currency} ${value}`;
}

export type IssueInput = {
  tenantId: string;
  razorpayPaymentId: string;
  totalPaise: number;
  currency: string;
  planName: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date;
};

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Sequences from this number on are looked up exactly, because string order stops matching number order once the width grows past 99999. */
const EXACT_LOOKUP_FROM = 90_000;

/** The highest invoice number issued so far under this prefix and financial year. */
async function lastNumberIn(head: string): Promise<string | null> {
  const last = await prisma.invoice.findFirst({ where: { number: { startsWith: head } }, orderBy: { number: "desc" }, select: { number: true } });
  if (!last || nextSequence(last.number) - 1 < EXACT_LOOKUP_FROM) return last?.number ?? null;
  const rows = await prisma.$queryRaw<{ number: string }[]>`SELECT "number" FROM "Invoice" WHERE starts_with("number", ${head}) ORDER BY length("number") DESC, "number" DESC LIMIT 1`;
  return rows[0]?.number ?? last.number;
}

/** Creates one paid invoice per Razorpay payment id. Returns the existing invoice when the payment was already invoiced. */
export async function issueInvoice(input: IssueInput) {
  return (await issueInvoiceOnce(input)).invoice;
}

/** Same as issueInvoice, and says whether this call created the invoice (so a receipt is sent once, not on every webhook retry). */
export async function issueInvoiceOnce(input: IssueInput) {
  const existing = await prisma.invoice.findUnique({ where: { razorpayPaymentId: input.razorpayPaymentId } });
  if (existing) return { invoice: existing, created: false };
  const [settings, profile] = await Promise.all([getSettings(), prisma.billingProfile.findUnique({ where: { tenantId: input.tenantId } })]);
  const split = splitInclusive(input.totalPaise, settings.gstRateBps);
  const fy = financialYear(input.paidAt);
  const head = `${settings.invoicePrefix}/${fy}/`;

  const buyerAddress = profile ? [profile.addressLine, profile.state, profile.pincode].filter(Boolean).join(", ") : null;
  const meta = snapshotMeta(settings, buyerStateCode(profile?.gstin, buyerAddress));

  for (let attempt = 0; attempt < 5; attempt++) {
    const number = formatInvoiceNumber(settings.invoicePrefix, fy, nextSequence(await lastNumberIn(head)));
    try {
      const invoice = await prisma.invoice.create({
        data: {
          tenantId: input.tenantId,
          number,
          status: "paid",
          planName: input.planName,
          ...split,
          gstRateBps: settings.gstRateBps,
          currency: input.currency,
          customerName: profile?.legalName ?? null,
          customerGstin: profile?.gstin ?? null,
          customerAddress: buyerAddress,
          razorpayPaymentId: input.razorpayPaymentId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          issuedAt: input.paidAt,
          paidAt: input.paidAt,
        },
      });
      await writeInvoiceMeta(number, meta);
      return { invoice, created: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await prisma.invoice.findUnique({ where: { razorpayPaymentId: input.razorpayPaymentId } });
      if (raced) return { invoice: raced, created: false };
    }
  }
  throw new Error("Could not allocate an invoice number");
}
