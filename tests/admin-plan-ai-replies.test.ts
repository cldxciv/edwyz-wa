import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The admin plan editor's "AI replies an hour" (owner decision 3): Plan.features.aiRepliesPerHour, with the defaults prefilled. */

const db = vi.hoisted(() => ({ plan: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing", () => ({ syncPlanToRazorpay: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { applyRepliesPerHour, createPlan, parsePlanInput, updatePlan } from "@/lib/admin/plans";
import { EMPTY_PLAN, PlanForm, repliesPerHourFields, type PlanFormValues } from "@/components/admin/PlanForm";

const base = { code: "growth", name: "Growth", priceRupees: "2499", intervalMonths: "1" };

beforeEach(() => {
  vi.resetAllMocks();
  db.plan.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "np", ...data }));
  db.plan.update.mockImplementation(async ({ data }: { data: object }) => ({ id: "p1", ...data }));
});

describe("saving the field", () => {
  it("stores a whole number in Plan.features next to the other allowances", () => {
    const parsed = parsePlanInput({ ...base, features: '{"automationTriggersMonthly": 5000}', aiRepliesPerHour: "250" });
    expect(parsed.features).toEqual({ automationTriggersMonthly: 5000, aiRepliesPerHour: 250 });
  });

  it("the field wins over a value typed in the JSON; empty removes it so the plan's default applies", () => {
    expect(parsePlanInput({ ...base, features: '{"aiRepliesPerHour": 9}', aiRepliesPerHour: "300" }).features).toEqual({ aiRepliesPerHour: 300 });
    expect(parsePlanInput({ ...base, features: '{"aiRepliesPerHour": 9, "x": 1}', aiRepliesPerHour: "" }).features).toEqual({ x: 1 });
  });

  it("an older caller that does not send the field leaves the features as they are", () => {
    expect(parsePlanInput({ ...base, features: '{"aiRepliesPerHour": 9}' }).features).toEqual({ aiRepliesPerHour: 9 });
    expect(applyRepliesPerHour({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("refuses 0 (it would switch the AI agent off for the plan), negatives, fractions and absurd values", () => {
    for (const bad of ["0", "-1", "2.5", "abc", "100001"]) {
      expect(() => parsePlanInput({ ...base, aiRepliesPerHour: bad }), bad).toThrow(/AI replies an hour must be a whole number between 1 and 100000/);
    }
  });

  it("is saved on create and update", async () => {
    db.plan.findUnique.mockResolvedValueOnce(null);
    await createPlan("admin1", { ...base, aiRepliesPerHour: "200" });
    expect(db.plan.create.mock.calls[0][0].data.features).toEqual({ aiRepliesPerHour: 200 });
    db.plan.findUnique.mockResolvedValueOnce({ id: "p1", code: "growth", razorpayPlanId: null, pricePaise: 249_900, intervalMonths: 1 });
    await updatePlan("admin1", "p1", { ...base, aiRepliesPerHour: "450" });
    expect(db.plan.update.mock.calls[0][0].data.features).toEqual({ aiRepliesPerHour: 450 });
  });
});

describe("what the form shows", () => {
  const values = (over: Partial<PlanFormValues>): PlanFormValues => ({ ...EMPTY_PLAN, aiRepliesPerHour: undefined, ...over });

  it("a new plan starts at 60", () => {
    expect(EMPTY_PLAN.aiRepliesPerHour).toBe("60");
    expect(repliesPerHourFields(EMPTY_PLAN)).toEqual({ replies: "60", features: "{}" });
  });

  it("prefills the plan's value, else the default for its code or name, and leaves the key out of the JSON", () => {
    expect(repliesPerHourFields(values({ code: "pro", name: "Pro", features: '{"aiRepliesPerHour":90,"automationTriggersMonthly":10}' }))).toEqual({ replies: "90", features: '{"automationTriggersMonthly":10}' });
    expect(repliesPerHourFields(values({ code: "growth", name: "Growth", features: "{}" })).replies).toBe("200");
    expect(repliesPerHourFields(values({ code: "big", name: "Agency", features: "{}" })).replies).toBe("600");
    expect(repliesPerHourFields(values({ code: "starter", name: "Starter", features: "{}" })).replies).toBe("60");
    expect(repliesPerHourFields(values({ code: "pro", name: "Pro", features: "{}" })).replies).toBe("60");
    // JSON that does not parse is shown as it is, for the form's own check to explain.
    expect(repliesPerHourFields(values({ code: "growth", name: "Growth", features: "{oops" }))).toEqual({ replies: "200", features: "{oops" });
  });

  it("renders the labelled field with the default, its hint, and the JSON without the key", () => {
    const html = renderToStaticMarkup(createElement(PlanForm, { initial: values({ id: "p1", code: "growth", name: "Growth", features: '{"aiRepliesPerHour":200}' }) }));
    expect(html).toContain("AI replies an hour");
    expect(html).toMatch(/name="aiRepliesPerHour"[^>]*value="200"|value="200"[^>]*name="aiRepliesPerHour"/);
    expect(html).toContain("Defaults: Starter 60, Growth 200, Agency 600.");
    expect(html).not.toContain("aiRepliesPerHour&quot;");
    expect(html).toContain("Every module is on every plan");
  });
});
