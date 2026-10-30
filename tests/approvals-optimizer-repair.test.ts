import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  optimizerProposal: { updateMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  adCampaign: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => ({ queueEmail: vi.fn() }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { getOptimizerClientDecisions, repairStuckOptimizerProposalsOnce } from "@/lib/approvals";
import { HANDLERS, money } from "@/lib/approvals/summary";
import { BANNED_COPY_WORDS, containsBannedWord } from "@/lib/spend/copy";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("one-time repair of proposals stuck in approved", () => {
  it("repairs once, records the marker, and does nothing on later calls", async () => {
    let marker: unknown = null;
    db.platformSetting.findUnique.mockImplementation(async () => marker);
    db.platformSetting.upsert.mockImplementation(async ({ create }: { create: { value: unknown } }) => void (marker = create.value));
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 3 });

    expect(await repairStuckOptimizerProposalsOnce()).toBe(3);
    expect(db.optimizerProposal.updateMany).toHaveBeenCalledTimes(1);
    const where = db.optimizerProposal.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "approved", decidedByUserId: null, appliedAt: null });
    expect(db.optimizerProposal.updateMany.mock.calls[0][0].data).toEqual({ status: "proposed" });
    expect(marker).toMatchObject({ repaired: 3 });

    expect(await repairStuckOptimizerProposalsOnce()).toBe(0);
    expect(await repairStuckOptimizerProposalsOnce()).toBe(0);
    expect(db.optimizerProposal.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a crash before the marker is written just repeats the idempotent repair next time", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.optimizerProposal.updateMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 0 });
    db.platformSetting.upsert.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});
    await expect(repairStuckOptimizerProposalsOnce()).rejects.toThrow("db down");
    expect(await repairStuckOptimizerProposalsOnce()).toBe(0);
    expect(db.platformSetting.upsert).toHaveBeenCalledTimes(2);
  });
});

describe("client decisions for many proposals", () => {
  it("reads them in one query, scoped by the tenant's keys", async () => {
    db.platformSetting.findMany.mockResolvedValue([
      { key: "approval:optimizer_proposal:t1:p1", value: { decision: "approved", approved: true, at: "2026-10-01T00:00:00.000Z" } },
      { key: "approval:optimizer_proposal:t1:p2", value: { decision: "changes_requested", approved: false, at: "2026-10-02T00:00:00.000Z" } },
      { key: "approval:optimizer_proposal:t1:p3", value: { nonsense: true } },
    ]);
    const out = await getOptimizerClientDecisions("t1", ["p1", "p2", "p3", "p4"]);
    expect(db.platformSetting.findMany).toHaveBeenCalledTimes(1);
    expect(db.platformSetting.findMany.mock.calls[0][0].where.key.in).toEqual([
      "approval:optimizer_proposal:t1:p1", "approval:optimizer_proposal:t1:p2", "approval:optimizer_proposal:t1:p3", "approval:optimizer_proposal:t1:p4",
    ]);
    expect([...out.keys()]).toEqual(["p1", "p2"]);
    expect(out.get("p1")).toMatchObject({ decision: "approved", approved: true });
    expect(out.get("p2")).toMatchObject({ decision: "changes_requested", approved: false });
  });

  it("does not query when there is nothing to look up", async () => {
    expect((await getOptimizerClientDecisions("t1", [])).size).toBe(0);
    expect(db.platformSetting.findMany).not.toHaveBeenCalled();
  });
});

describe("approval summaries format money with the currency exponent (docs/SPEND-CONTROLS-SPEC.md 7.3)", () => {
  it("never divides by 100 blindly", () => {
    expect(money(50_000, "INR")).toBe("₹500");
    expect(money(50_050, "INR")).toBe("₹500.50");
    expect(money(1_500, "JPY")).toBe("¥1,500");
    expect(money(1_234, "KWD")).toMatch(/^KWD\s1\.234$/);
    expect(money(50_000, "not-a-code")).toBe("₹500");
  });

  it("the client's campaign summary shows the daily budget in its own currency", async () => {
    db.adCampaign.findFirst.mockResolvedValue({ name: "Tokyo launch", objective: "OUTCOME_LEADS", dailyBudgetMinor: 3_000, currency: "JPY", startsAt: null, endsAt: null });
    const summary = await HANDLERS.ad_campaign.load("t1", "c1");
    expect(summary?.rows).toContainEqual({ label: "Daily budget", value: "¥3,000" });
  });
});

describe("the demo seed's text passes the spend copy check (docs/SPEND-CONTROLS-SPEC.md 8.4)", () => {
  const seed = readFileSync(path.resolve(__dirname, "../scripts/seed-demo.mjs"), "utf8");
  // Every user-visible sentence the seed writes for the optimizer and the spending ledger.
  const texts = [...seed.matchAll(/(?:rationale|reason|summary)\s*:\s*"([^"]+)"/g), ...seed.matchAll(/OPT1_RATIONALE\s*=\s*"([^"]+)"/g), ...seed.matchAll(/\["led\d+",[^\]]*?"([A-Z][^"]{8,})"/g)].map((m) => m[1]);

  it("writes plain-language rationale with formatted money", () => {
    expect(texts).toContain("Spent ₹31 in 7 days with no results.");
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(containsBannedWord(t), `${t} contains one of ${BANNED_COPY_WORDS.join(", ")}`).toBeNull();
  });

  it("seeds the spending sample data: a SpendControl row, ads INR 2,000 a day and 20,000 a month, WhatsApp INR 5,000 a month, sandbox ledger rows", () => {
    expect(seed).toMatch(/put\("SpendControl", \{ tenantId: tid/);
    expect(seed).toMatch(/pot: "ads", currency: "INR", dailyLimitMinor: 200000, monthlyLimitMinor: 2000000/);
    expect(seed).toMatch(/pot: "messaging", currency: "INR", dailyLimitMinor: null, monthlyLimitMinor: 500000/);
    expect(seed).toMatch(/put\("SpendLedger", \{[\s\S]*?sandbox: true/);
  });
});
