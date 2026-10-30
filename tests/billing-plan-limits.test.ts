import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  plan: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing", () => ({ syncPlanToRazorpay: vi.fn() }));

import { applyPlanAction, createPlan, parsePlanInput, updatePlan } from "@/lib/admin/plans";
import { EMPTY_PLAN } from "@/components/admin/PlanForm";

const base = { code: "growth", name: "Growth", priceRupees: "999", intervalMonths: 1, features: "{}" };

beforeEach(() => {
  vi.resetAllMocks();
  db.plan.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "np", ...data }));
  db.plan.update.mockImplementation(async ({ data }: { data: object }) => ({ id: "p1", ...data }));
});

describe("plan limits set in the admin form", () => {
  it("reads the four growth limits, and treats empty as no limit", () => {
    const parsed = parsePlanInput({ ...base, aiCreditsMonthly: "500", adAccountLimit: "3", scheduledPostLimit: "120", connectedChannelLimit: "4" });
    expect(parsed).toMatchObject({ aiCreditsMonthly: 500, adAccountLimit: 3, scheduledPostLimit: 120, connectedChannelLimit: 4 });
    const open = parsePlanInput({ ...base, aiCreditsMonthly: "", adAccountLimit: "" });
    expect(open).toMatchObject({ aiCreditsMonthly: null, adAccountLimit: null, scheduledPostLimit: null, connectedChannelLimit: null });
  });

  it("refuses zero, negative, fractional and absurd values with a 400", () => {
    for (const bad of ["0", "-1", "2.5", "abc", "1e9"]) {
      expect(() => parsePlanInput({ ...base, aiCreditsMonthly: bad })).toThrow();
    }
    expect(() => parsePlanInput({ ...base, adAccountLimit: "100000" })).toThrow();
  });

  it("saves them on create and update", async () => {
    db.plan.findUnique.mockResolvedValueOnce(null);
    await createPlan("admin1", { ...base, scheduledPostLimit: "30" });
    expect(db.plan.create.mock.calls[0][0].data).toMatchObject({ scheduledPostLimit: 30, aiCreditsMonthly: null });
    db.plan.findUnique.mockResolvedValueOnce({ id: "p1", code: "growth", razorpayPlanId: null, pricePaise: 99900, intervalMonths: 1 });
    await updatePlan("admin1", "p1", { ...base, connectedChannelLimit: "2", adAccountLimit: "1" });
    expect(db.plan.update.mock.calls[0][0].data).toMatchObject({ connectedChannelLimit: 2, adAccountLimit: 1 });
  });

  it("a duplicated plan keeps every limit", async () => {
    db.plan.findUnique.mockResolvedValueOnce({
      id: "p1", code: "growth", name: "Growth", description: null, pricePaise: 99900, intervalMonths: 1, seatLimit: 5, contactLimit: 1000, monthlyBroadcastLimit: 2000,
      aiCreditsMonthly: 400, adAccountLimit: 2, scheduledPostLimit: 60, connectedChannelLimit: 3, features: {}, sortOrder: 0, _count: { subscriptions: 0 },
    });
    db.plan.findUnique.mockResolvedValue(null);
    await applyPlanAction("admin1", "p1", { action: "duplicate" });
    expect(db.plan.create.mock.calls[0][0].data).toMatchObject({ aiCreditsMonthly: 400, adAccountLimit: 2, scheduledPostLimit: 60, connectedChannelLimit: 3, seatLimit: 5, active: false });
  });

  it("the form starts with empty values for the new limits", () => {
    expect(EMPTY_PLAN).toMatchObject({ aiCreditsMonthly: "", adAccountLimit: "", scheduledPostLimit: "", connectedChannelLimit: "" });
  });
});
