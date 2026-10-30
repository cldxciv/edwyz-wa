import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { buildInvoiceView, invoiceMetaKey, issueInvoiceOnce, loadInvoiceView, snapshotMeta } from "@/lib/billing/invoice";
import { DEFAULT_SETTINGS, type PlatformSettings } from "@/lib/platform-settings";

const proformaSeller: PlatformSettings = { ...DEFAULT_SETTINGS, sellerGstin: "", sellerStateCode: "", sellerLegalName: "Edwyz", sellerAddress: "Bengaluru" };
const taxSeller: PlatformSettings = { ...DEFAULT_SETTINGS, sellerGstin: "29ABCDE1234F1Z5", sellerStateCode: "29", sellerLegalName: "Edwyz Technologies", sellerAddress: "1 MG Road\nBengaluru" };

const row = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  number: "EDW/2026-27/00001",
  status: "paid",
  planName: "Growth",
  amountPaise: 50000,
  gstRateBps: 1800,
  gstPaise: 9000,
  totalPaise: 59000,
  currency: "INR",
  customerName: "Acme",
  customerGstin: "29AAAAA0000A1Z5",
  customerAddress: "5 Park Street, Karnataka, 560001",
  periodStart: null,
  periodEnd: null,
  issuedAt: new Date("2026-11-01T05:00:00Z"),
  paidAt: new Date("2026-11-01T05:00:00Z"),
  ...over,
});

let store: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  store = new Map();
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (store.has(where.key) ? { value: store.get(where.key) } : null));
  db.platformSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    store.set(where.key, create.value);
    return {};
  });
  db.invoice.findUnique.mockResolvedValue(null);
  db.invoice.findFirst.mockResolvedValue(null);
  db.billingProfile.findUnique.mockResolvedValue(null);
  db.invoice.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "inv-new", ...data }));
});

const input = (paymentId: string, paidAt = "2026-11-01T00:00:00Z") => ({ tenantId: "t1", razorpayPaymentId: paymentId, totalPaise: 59000, currency: "INR", planName: "Growth", periodStart: null, periodEnd: null, paidAt: new Date(paidAt) });

describe("an invoice keeps the status and tax it was issued with", () => {
  it("an invoice issued as proforma stays a proforma, with the same number, after the seller GSTIN is set", async () => {
    let sellerSettings: Record<string, string> = { sellerGstin: "", sellerStateCode: "" };
    db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === "settings") return { value: sellerSettings };
      return store.has(where.key) ? { value: store.get(where.key) } : null;
    });
    const { invoice } = await issueInvoiceOnce(input("pay_1"));
    expect(store.get(invoiceMetaKey(invoice.number))).toMatchObject({ v: 1, proforma: true, sellerGstin: "" });

    // Later the seller registers. The stored invoice is rendered from its snapshot, not from today's settings.
    sellerSettings = { sellerGstin: "29ABCDE1234F1Z5", sellerStateCode: "29" };
    const view = await loadInvoiceView(row({ number: invoice.number }) as never);
    expect(view.proforma).toBe(true);
    expect(view.title).toBe("Proforma, not a tax invoice");
    expect(view.seller.gstin).toBeNull();
    // while the same row with no snapshot (an invoice from before snapshots) falls back to current settings
    expect(buildInvoiceView(row() as never, taxSeller).title).toBe("Tax invoice");
  });

  it("a tax invoice keeps its seller details and its CGST/SGST split when the seller later moves state", () => {
    const meta = snapshotMeta(taxSeller, "29");
    const moved = { ...taxSeller, sellerStateCode: "27", sellerGstin: "27ABCDE1234F1Z5", sellerLegalName: "New Name" };
    const view = buildInvoiceView(row() as never, moved, meta);
    expect(view.tax.kind).toBe("cgst_sgst");
    expect(view.seller).toEqual({ name: "Edwyz Technologies", address: "1 MG Road\nBengaluru", gstin: "29ABCDE1234F1Z5" });
    expect(buildInvoiceView(row() as never, moved).tax.kind).toBe("igst");
  });

  it("records the place of supply known at issue time", async () => {
    db.billingProfile.findUnique.mockResolvedValue({ legalName: "Acme", gstin: "27AAAAA0000A1Z5", addressLine: "5 Park", state: "Maharashtra", pincode: "400001" });
    const { invoice } = await issueInvoiceOnce(input("pay_2"));
    expect((store.get(invoiceMetaKey(invoice.number)) as { buyerStateCode: string }).buyerStateCode).toBe("27");
  });

  it("an unreadable snapshot is ignored instead of breaking the page", async () => {
    store.set(invoiceMetaKey("EDW/2026-27/00001"), { nonsense: true });
    const view = await loadInvoiceView(row() as never);
    expect(view.title).toMatch(/invoice|Proforma/);
  });

  it("a failed snapshot write does not lose the invoice", async () => {
    db.platformSetting.upsert.mockRejectedValue(new Error("db down"));
    const out = await issueInvoiceOnce(input("pay_3"));
    expect(out.created).toBe(true);
  });
});

describe("invoice numbering past 99999", () => {
  it("uses the plain lookup for ordinary sequences", async () => {
    db.invoice.findFirst.mockResolvedValue({ number: "EDW/2026-27/00041" });
    const { invoice } = await issueInvoiceOnce(input("pay_a"));
    expect(invoice.number).toBe("EDW/2026-27/00042");
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("looks up the numerically highest number once sequences get long, because string order breaks at 100000", async () => {
    // As text "EDW/2026-27/99999" sorts after "EDW/2026-27/100000".
    db.invoice.findFirst.mockResolvedValue({ number: "EDW/2026-27/99999" });
    db.$queryRaw.mockResolvedValue([{ number: "EDW/2026-27/100000" }]);
    const { invoice } = await issueInvoiceOnce(input("pay_b"));
    expect(invoice.number).toBe("EDW/2026-27/100001");
  });

  it("falls back to the plain lookup when the exact query finds nothing", async () => {
    db.invoice.findFirst.mockResolvedValue({ number: "EDW/2026-27/95000" });
    db.$queryRaw.mockResolvedValue([]);
    const { invoice } = await issueInvoiceOnce(input("pay_c"));
    expect(invoice.number).toBe("EDW/2026-27/95001");
  });
});
