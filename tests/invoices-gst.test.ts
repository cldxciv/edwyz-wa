import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  billingProfile: { findUnique: vi.fn() },
  platformSetting: { findUnique: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);

import { GET as downloadRoute } from "@/app/api/billing/invoices/[id]/download/route";
import { buildInvoiceView, financialYear, formatInvoiceNumber, issueInvoiceOnce, nextSequence } from "@/lib/billing/invoice";
import { invoiceFilename, renderInvoiceHtml } from "@/lib/billing/invoice-html";
import { HttpError } from "@/lib/tenancy";
import { DEFAULT_SETTINGS, type PlatformSettings } from "@/lib/platform-settings";

const seller: PlatformSettings = { ...DEFAULT_SETTINGS, sellerGstin: "29ABCDE1234F1Z5", sellerStateCode: "29", sellerLegalName: "Edwyz Technologies Private Limited", sellerAddress: "1 MG Road\nBengaluru" };
const invoice = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  number: "EDW/2026-27/00007",
  status: "paid",
  planName: "Growth",
  amountPaise: 50000,
  gstRateBps: 1800,
  gstPaise: 9000,
  totalPaise: 59000,
  currency: "INR",
  customerName: "Acme Traders",
  customerGstin: "29AAAAA0000A1Z5",
  customerAddress: "5 Park Street, Karnataka, 560001",
  periodStart: new Date("2026-11-01T00:00:00Z"),
  periodEnd: new Date("2026-12-01T00:00:00Z"),
  issuedAt: new Date("2026-11-01T05:00:00Z"),
  paidAt: new Date("2026-11-01T05:00:00Z"),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.platformSetting.findUnique.mockResolvedValue(null);
});

describe("numbering", () => {
  it("restarts the sequence each April in India time", () => {
    expect(financialYear(new Date("2027-03-31T18:29:59Z"))).toBe("2026-27");
    expect(financialYear(new Date("2027-03-31T18:30:00Z"))).toBe("2027-28");
    expect(financialYear(new Date("2099-12-31T00:00:00Z"))).toBe("2099-00");
    expect(formatInvoiceNumber("EDW", "2027-28", 1)).toBe("EDW/2027-28/00001");
    expect(nextSequence("EDW/2026-27/00041")).toBe(42);
    expect(nextSequence("garbage")).toBe(1);
  });

  it("starts at 1 in a new financial year and continues within one, using the configured prefix", async () => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue(null);
    db.platformSetting.findUnique.mockResolvedValue({ value: { invoicePrefix: "WA" } });
    db.invoice.create.mockImplementation(async ({ data }: { data: object }) => data);

    db.invoice.findFirst.mockResolvedValue(null);
    const first = await issueInvoiceOnce({ tenantId: "t1", razorpayPaymentId: "pay_a", totalPaise: 59000, currency: "INR", planName: "Growth", periodStart: null, periodEnd: null, paidAt: new Date("2027-04-01T00:00:00Z") });
    expect(first.created).toBe(true);
    expect(first.invoice.number).toBe("WA/2027-28/00001");
    expect(db.invoice.findFirst.mock.calls[0][0].where).toEqual({ number: { startsWith: "WA/2027-28/" } });

    db.invoice.findFirst.mockResolvedValue({ number: "WA/2027-28/00009" });
    const next = await issueInvoiceOnce({ tenantId: "t1", razorpayPaymentId: "pay_b", totalPaise: 59000, currency: "INR", planName: "Growth", periodStart: null, periodEnd: null, paidAt: new Date("2027-04-02T00:00:00Z") });
    expect(next.invoice.number).toBe("WA/2027-28/00010");
  });

  it("snapshots the buyer, splits the inclusive total and records the rate in force", async () => {
    db.invoice.findUnique.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(null);
    db.billingProfile.findUnique.mockResolvedValue({ legalName: "Acme Traders", gstin: "29AAAAA0000A1Z5", addressLine: "5 Park Street", state: "Karnataka", pincode: "560001" });
    db.invoice.create.mockImplementation(async ({ data }: { data: object }) => data);
    const { invoice: inv } = await issueInvoiceOnce({ tenantId: "t1", razorpayPaymentId: "pay_c", totalPaise: 59000, currency: "INR", planName: "Growth", periodStart: null, periodEnd: null, paidAt: new Date("2026-11-01T00:00:00Z") });
    expect(inv).toMatchObject({ amountPaise: 50000, gstPaise: 9000, totalPaise: 59000, gstRateBps: 1800, customerName: "Acme Traders", customerAddress: "5 Park Street, Karnataka, 560001", status: "paid" });
  });
});

describe("tax lines on the document", () => {
  it("same state as the seller gives CGST and SGST that add up to the GST", () => {
    const v = buildInvoiceView(invoice() as never, seller);
    expect(v.proforma).toBe(false);
    expect(v.title).toBe("Tax invoice");
    expect(v.tax).toEqual({ kind: "cgst_sgst", cgstPaise: 4500, sgstPaise: 4500 });
  });

  it("another state gives IGST", () => {
    const v = buildInvoiceView(invoice({ customerGstin: "27AAAAA0000A1Z5", customerAddress: "Pune, Maharashtra" }) as never, seller);
    expect(v.tax).toEqual({ kind: "igst", igstPaise: 9000 });
  });

  it("an unknown buyer state is treated as inter-state (IGST), never guessed as local", () => {
    const v = buildInvoiceView(invoice({ customerGstin: null, customerAddress: "Somewhere" }) as never, seller);
    expect(v.tax.kind).toBe("igst");
  });

  it("is a proforma until the seller has both a GSTIN and a state code, and then hides the seller GSTIN", () => {
    for (const s of [DEFAULT_SETTINGS, { ...seller, sellerStateCode: "" }, { ...seller, sellerGstin: " " }]) {
      const v = buildInvoiceView(invoice() as never, s);
      expect(v.proforma).toBe(true);
      expect(v.title).toBe("Proforma, not a tax invoice");
      expect(v.seller.gstin).toBeNull();
    }
  });

  it("a zero-GST invoice has no tax lines", () => {
    expect(buildInvoiceView(invoice({ gstPaise: 0, amountPaise: 59000, gstRateBps: 0 }) as never, seller).tax.kind).toBe("none");
  });
});

describe("downloadable html", () => {
  const html = (inv = invoice(), s = seller) => renderInvoiceHtml(buildInvoiceView(inv as never, s));

  it("is a complete standalone page with no script and no external resource", () => {
    const out = html();
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).not.toMatch(/<script|<link |src=|https?:\/\/(?!www\.w3)/);
    expect(out).toContain("<title>Tax invoice EDW/2026-27/00007</title>");
  });

  it("shows seller and buyer details, the period and CGST and SGST at half the rate each", () => {
    const out = html();
    expect(out).toContain("Edwyz Technologies Private Limited");
    expect(out).toContain("GSTIN: 29ABCDE1234F1Z5");
    expect(out).toContain("1 MG Road<br>Bengaluru");
    expect(out).toContain("Acme Traders");
    expect(out).toContain("GSTIN: 29AAAAA0000A1Z5");
    expect(out).toContain("CGST (9%)");
    expect(out).toContain("SGST (9%)");
    expect(out).toContain("Rs 590.00");
    expect(out).toContain("01 Nov 2026 to 01 Dec 2026");
  });

  it("shows IGST for inter-state sales", () => {
    const out = html(invoice({ customerGstin: "27AAAAA0000A1Z5" }));
    expect(out).toContain("IGST (18%)");
    expect(out).not.toContain("CGST");
  });

  it("labels a proforma plainly and says why", () => {
    const out = html(invoice(), DEFAULT_SETTINGS);
    expect(out).toContain("Proforma, not a tax invoice");
    expect(out).toContain("not a tax invoice. The seller has not added GST registration details yet.");
    expect(out).toContain("Indicative GST (18%)");
    expect(out).not.toContain("GSTIN: 29ABCDE");
  });

  it("escapes everything a customer typed", () => {
    const out = html(invoice({ customerName: '<img src=x onerror=alert(1)>', customerAddress: "a & b\n<b>c</b>" }));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>c</b>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("a &amp; b<br>&lt;b&gt;c&lt;/b&gt;");
  });

  it("builds a safe filename from the number", () => {
    expect(invoiceFilename("EDW/2026-27/00007")).toBe("invoice-EDW-2026-27-00007.html");
    expect(invoiceFilename('x"; filename="evil.exe')).not.toMatch(/["; ]/);
  });
});

describe("download route", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (id = "i1") => downloadRoute(new Request(`https://wa.edwyz.com/api/billing/invoices/${id}/download`), ctx(id));

  it("gives an owner or admin their own invoice as an attachment, scoped to the workspace", async () => {
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "admin" });
    db.invoice.findFirst.mockResolvedValue(invoice());
    const res = await get();
    expect(res.status).toBe(200);
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { id: "i1", tenantId: "t1" } });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="invoice-EDW-2026-27-00007.html"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Acme Traders");
  });

  it("404s another workspace's invoice", async () => {
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t2", role: "owner" });
    db.invoice.findFirst.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(db.invoice.findFirst.mock.calls[0][0].where.tenantId).toBe("t2");
  });

  it("refuses agents and signed-out visitors", async () => {
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "agent" });
    expect((await get()).status).toBe(403);
    auth.getActor.mockRejectedValue(new HttpError(401, "Not signed in."));
    expect((await get()).status).toBe(401);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });
});
