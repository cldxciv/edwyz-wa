import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const db = vi.hoisted(() => ({ plan: { findMany: vi.fn() } }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/platform-settings", () => ({ getSettings: async () => ({ trialDays: 7, graceDays: 3, gstRateBps: 1800, sellerGstin: "" }) }));

import { listActivePlans } from "@/lib/billing/service";
import { GET as getPlans } from "@/app/api/billing/plans/route";
import PricingPage from "@/app/(site)/pricing/page";

beforeEach(() => vi.resetAllMocks());

describe("listActivePlans", () => {
  it("selects the AI credit and ad account limits next to the existing fields, active plans only, in display order", async () => {
    db.plan.findMany.mockResolvedValue([]);
    await listActivePlans();
    const args = db.plan.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ active: true });
    expect(args.orderBy).toEqual([{ sortOrder: "asc" }, { createdAt: "asc" }]);
    for (const field of ["id", "code", "name", "description", "pricePaise", "currency", "intervalMonths", "seatLimit", "contactLimit", "monthlyBroadcastLimit", "features", "aiCreditsMonthly", "adAccountLimit"]) {
      expect(args.select[field]).toBe(true);
    }
  });

  it("returns plan rows unchanged, keeping null and zero limits distinct", async () => {
    const rows = [{ id: "p", aiCreditsMonthly: null, adAccountLimit: 0 }];
    db.plan.findMany.mockResolvedValue(rows);
    expect(await listActivePlans()).toBe(rows);
  });
});

describe("listActivePlans consumers with realistic rows", () => {
  // Shaped like what the select returns: Decimal-free scalars, nulls and zeros, a JSON features value.
  const rows = [
    { id: "t", code: "trial", name: "Trial", description: null, pricePaise: 0, currency: "INR", intervalMonths: 1, seatLimit: 2, contactLimit: 100, monthlyBroadcastLimit: 0, aiCreditsMonthly: 0, adAccountLimit: 0, features: null },
    { id: "s", code: "starter", name: "Starter", description: "For one shop", pricePaise: 99900, currency: "INR", intervalMonths: 1, seatLimit: 3, contactLimit: null, monthlyBroadcastLimit: 5000, aiCreditsMonthly: null, adAccountLimit: 4, features: ["Inbox"] },
    { id: "g", code: "growth", name: "Growth", description: null, pricePaise: 249900, currency: "INR", intervalMonths: 1, seatLimit: null, contactLimit: 50000, monthlyBroadcastLimit: null, aiCreditsMonthly: 2500, adAccountLimit: null, features: [] },
  ];

  it("serves every limit to the in-app plan chooser, nulls and zeros intact", async () => {
    db.plan.findMany.mockResolvedValue(rows);
    auth.getActor.mockResolvedValue({ userId: "u", tenantId: "t1", role: "admin" });
    const res = await getPlans(new Request("https://wa.edwyz.com/api/billing/plans"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.plans).toEqual(rows);
    expect(body.plans[1]).toMatchObject({ aiCreditsMonthly: null, adAccountLimit: 4, contactLimit: null });
    expect(body.plans[0]).toMatchObject({ aiCreditsMonthly: 0, adAccountLimit: 0 });
  });

  it("renders the public pricing page from the same rows without claiming unlimited AI or an ad account cap", async () => {
    db.plan.findMany.mockResolvedValue(rows);
    const out = renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
    expect(out).toContain("Rs 999");
    expect(out).toContain("Rs 2,499");
    expect(out).not.toContain("Trial");
    expect(out).toContain("2,500");
    expect(out).toContain("No fixed limit");
    expect(out).toMatch(/fair-use limit/i);
    expect(out).not.toMatch(/unlimited (team|contacts|broadcast|ad|AI)/i);
    expect(out).not.toMatch(/connected ad accounts|\d ad accounts?|limit on ad accounts/i);
  });
});
