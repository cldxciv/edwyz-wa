import { beforeEach, describe, expect, it, vi } from "vitest";

const limits = vi.hoisted(() => ({ usageLines: vi.fn(), usagePlan: vi.fn() }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/billing/limits", () => limits);

import { GET } from "@/app/api/billing/usage/route";
import { meterNote, meterSummary, meterTitle, planFacts, usageBannerText } from "@/components/billing/helpers";

const line = (kind: string, used: number, limit: number | null) => ({ kind, label: kind, used, limit, percent: limit ? Math.min(100, Math.floor((used * 100) / limit)) : null, monthly: false });
const get = () => GET(new Request("https://wa.edwyz.com/api/billing/usage"));

beforeEach(() => {
  vi.resetAllMocks();
  auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "owner" });
  limits.usagePlan.mockResolvedValue({ state: "active", planName: "Pro" });
});

describe("GET /api/billing/usage", () => {
  it("returns every line and the ones at 80 percent or more, for this workspace only", async () => {
    limits.usageLines.mockResolvedValue([line("aiCredits", 90, 100), line("seats", 1, 10), line("adAccounts", 1, 1)]);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(3);
    expect(body.alerts.map((a: { kind: string; level: number }) => [a.kind, a.level])).toEqual([["adAccounts", 100], ["aiCredits", 80]]);
    expect(limits.usageLines).toHaveBeenCalledWith("t1");
    expect(body.plan).toEqual({ state: "active", planName: "Pro" });
  });

  it("is for owners and admins only", async () => {
    auth.getActor.mockResolvedValue({ userId: "u1", tenantId: "t1", role: "agent" });
    expect((await get()).status).toBe(403);
    expect(limits.usageLines).not.toHaveBeenCalled();
  });
});

describe("usage helpers", () => {
  it("titles, summaries and notes read in plain words", () => {
    expect(meterTitle({ kind: "aiCredits", label: "x" })).toBe("AI credits this month");
    expect(meterTitle({ kind: "unknown", label: "Other" })).toBe("Other");
    expect(meterSummary({ used: 1200, limit: 5000 })).toBe("1,200 of 5,000 used");
    expect(meterSummary({ used: 3, limit: null })).toBe("3 used, no limit");
    expect(meterNote(79)).toBeNull();
    expect(meterNote(80)).toBe("Almost full");
    expect(meterNote(100)).toBe("Limit reached");
    expect(meterNote(null)).toBeNull();
  });

  it("the banner is quiet below 80 percent, amber from 80 and red once a limit is reached", () => {
    expect(usageBannerText([])).toBeNull();
    expect(usageBannerText([line("aiCredits", 85, 100)])).toMatchObject({ tone: "warn", text: expect.stringContaining("ai credits this month") });
    const reached = usageBannerText([line("aiCredits", 100, 100), line("seats", 9, 10)]);
    expect(reached?.tone).toBe("bad");
    expect(reached?.text).toContain("ai credits this month");
    expect(reached?.text).not.toContain("team seats");
  });

  it("plan facts include the new limits when the plan carries them", () => {
    const plan = { pricePaise: 1, currency: "INR", intervalMonths: 1, seatLimit: 3, contactLimit: null, monthlyBroadcastLimit: null, aiCreditsMonthly: null, adAccountLimit: 1, scheduledPostLimit: 30, connectedChannelLimit: 2 };
    const facts = Object.fromEntries(planFacts(plan).map((f) => [f.label, f.value]));
    expect(facts).toMatchObject({ "AI credits a month": "Platform default", "Ad accounts": "1", "Scheduled posts a month": "30", "Social channels": "2" });
  });
});
