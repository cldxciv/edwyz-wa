import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  optimizerProposal: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  adSet: { findMany: vi.fn() },
  adCampaign: { findMany: vi.fn() },
  insightSnapshot: { findMany: vi.fn() },
  platformSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  // The caps shim reads the ads daily limit first (docs/SPEND-CONTROLS-SPEC.md 4.8); none here, so the legacy key decides.
  spendAllowance: { findUnique: vi.fn() },
  auditLog: { create: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
const ads = vi.hoisted(() => ({ pauseAd: vi.fn(), setAdSetBudget: vi.fn(), resumeAd: vi.fn() }));
const approvals = vi.hoisted(() => ({ createApproval: vi.fn(), getOptimizerClientDecisions: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/ads/actions", () => ads);
vi.mock("@/lib/approvals", () => approvals);
// The spending side (docs/SPEND-CONTROLS-SPEC.md 7.3): approvers, requests, learning records and the assistant's policy.
const spend = vi.hoisted(() => ({
  approverStatus: vi.fn(),
  createProposalApproval: vi.fn(),
  decideApproval: vi.fn(),
  pendingApprovalForProposal: vi.fn(),
  noteHumanDecision: vi.fn(),
  recordShadow: vi.fn(),
  assistantContext: vi.fn(),
}));
vi.mock("@/lib/spend/approvals", () => ({
  approverStatus: spend.approverStatus,
  createProposalApproval: spend.createProposalApproval,
  decideApproval: spend.decideApproval,
  pendingApprovalForProposal: spend.pendingApprovalForProposal,
}));
vi.mock("@/lib/spend/shadow", () => ({ noteHumanDecision: spend.noteHumanDecision, recordShadow: spend.recordShadow }));
vi.mock("@/lib/spend/mandates", () => ({ assistantContext: spend.assistantContext }));

import { PATCH, GET as getOne } from "@/app/api/optimizer/proposals/[id]/route";
import { GET as list } from "@/app/api/optimizer/proposals/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/optimizer/settings/route";
import { runForTenant } from "@/lib/optimizer/engine";
import { canTransition } from "@/lib/optimizer/service";
import { worker } from "@/lib/optimizer/worker";

const origin = "https://wa.edwyz.com";
const actor = (role: "owner" | "admin" | "agent", tenantId = "t1") => ({ userId: "u1", tenantId, role });
const req = (method: string, body?: unknown) =>
  new Request("https://wa.edwyz.com/api/optimizer/proposals/p1", { method, headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "p1" }) };

const shiftRow = (over = {}) => ({
  id: "p1",
  tenantId: "t1",
  kind: "shift_budget",
  targetMetaId: "s1",
  status: "proposed",
  createdAt: new Date(),
  appliedAt: null,
  revertPayload: null,
  payload: { fromAdSetMetaId: "s1", toAdSetMetaId: "s2", fromBudgetBefore: 100_000, fromBudgetAfter: 80_000, toBudgetBefore: 100_000, toBudgetAfter: 120_000 },
  ...over,
});
const pauseRow = (over = {}) => ({ ...shiftRow(), kind: "pause_ad", targetMetaId: "a1", payload: { adName: "A" }, ...over });
/** The person who approved or reverted, as the Spend Book records them (4.8): their own action on the Ad assistant's suggestion (2.3.10). */
const decider = { type: "user", userId: "u1", role: "admin", assistantKey: "ads_optimizer" };
type Verdict = "auto" | "shadow" | "needs_approval" | "refuse";
let verdict: Verdict = "needs_approval";
const policyCtx = () => ({
  now: new Date(),
  headroom: { sandbox: false },
  dayStartBudget: () => null,
  decide: vi.fn(() => ({ verdict, reason: verdict === "auto" ? "level_1_step" : "suggestion_only", level: verdict === "auto" ? 1 : 0, suggestion: verdict !== "auto", would: verdict === "shadow" ? "auto" : undefined })),
});
const applyReason = { reason: expect.stringMatching(/approved suggestion/) };
const undoReason = { reason: "Undid an applied suggestion." };

function settings(cap: number | null) {
  db.platformSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key.startsWith("ads:caps:") && cap !== null ? { value: { maxDailyBudgetMinor: cap } } : null));
  db.spendAllowance.findUnique.mockResolvedValue(null);
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.MAX_DAILY_BUDGET_MINOR;
  auth.getActor.mockResolvedValue(actor("admin"));
  db.optimizerProposal.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.create.mockResolvedValue({});
  settings(500_000);
  db.adSet.findMany.mockResolvedValue([
    { metaAdSetId: "s1", dailyBudgetMinor: 100_000 },
    { metaAdSetId: "s2", dailyBudgetMinor: 100_000 },
  ]);
  db.adCampaign.findMany.mockResolvedValue([]);
  approvals.getOptimizerClientDecisions.mockResolvedValue(new Map());
  ads.pauseAd.mockResolvedValue({ revertPayload: { was: "ACTIVE" } });
  ads.setAdSetBudget.mockResolvedValue({ revertPayload: { was: 1 } });
  spend.approverStatus.mockResolvedValue({ member: true, role: "admin", approver: true });
  spend.pendingApprovalForProposal.mockResolvedValue(null);
  spend.noteHumanDecision.mockResolvedValue(0);
  spend.createProposalApproval.mockResolvedValue({ approvalId: "sa1", expiresAt: new Date(), created: true, token: "t" });
  spend.recordShadow.mockResolvedValue({ id: "sr1", created: true });
  verdict = "needs_approval";
  spend.assistantContext.mockImplementation(async () => policyCtx());
});

const activeCampaign = (total: number) => ({ id: `c${total}`, dailyBudgetMinor: total, adSets: [{ dailyBudgetMinor: total }] });

describe("state machine", () => {
  it("allows only valid transitions", () => {
    expect(canTransition("proposed", "approved")).toBe(true);
    expect(canTransition("proposed", "applied")).toBe(false);
    expect(canTransition("rejected", "applied")).toBe(false);
    expect(canTransition("applied", "reverting")).toBe(true);
    expect(canTransition("reverted", "applied")).toBe(false);
    expect(canTransition("expired", "approved")).toBe(false);
  });
});

describe("no auto-apply", () => {
  it("the daily run only creates proposals and never calls ad actions", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 0 });
    db.optimizerProposal.findMany.mockResolvedValue([]);
    db.optimizerProposal.create.mockResolvedValue({ id: "p_new" });
    db.adCampaign.findMany.mockResolvedValue([
      {
        metaCampaignId: "c1",
        currency: "INR",
        adSets: [{ metaAdSetId: "s1", name: "S", dailyBudgetMinor: 100_000, ads: [{ metaAdId: "a1", name: "A", creative: {} }] }],
      },
    ]);
    const d = new Date();
    db.insightSnapshot.findMany.mockImplementation(async ({ where }: { where: { entityType: string } }) =>
      where.entityType === "ad" ? [{ entityMetaId: "a1", date: d, spendMinor: 500_000, impressions: 0, clicks: 0, results: 0, frequency: null }] : [],
    );
    const res = await runForTenant("t1");
    expect(res.created).toBe(1);
    expect(db.optimizerProposal.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", kind: "pause_ad" });
    expect(ads.pauseAd).not.toHaveBeenCalled();
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
    expect(db.insightSnapshot.findMany.mock.calls.every((c) => c[0].where.tenantId === "t1")).toBe(true);
    // Without a mandate the proposal is a suggestion: a spending request goes to the admins, in plain money.
    expect(res.routed).toEqual([{ id: "p_new", verdict: "needs_approval" }]);
    expect(spend.createProposalApproval).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", proposalId: "p_new", proposalKind: "pause_ad", direction: "lower", summary: "Pause the ad 'A'", reason: "Spent ₹5,000 in 7 days with no results." }));
  });
  it("is registered as a daily periodic task with no queues", () => {
    expect(worker.periodic[0].everyMs).toBe(86_400_000);
    expect(worker.queues).toEqual({});
  });
});

describe("decide route", () => {
  it("requires admin or owner", async () => {
    auth.getActor.mockResolvedValue(actor("agent"));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(403);
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
  it("requires the confirm flag", async () => {
    const res = await PATCH(req("PATCH", { action: "approve" }), ctx);
    expect(res.status).toBe(400);
    expect(db.optimizerProposal.updateMany).not.toHaveBeenCalled();
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and unknown actions", async () => {
    const bad = new Request("https://wa.edwyz.com/x", { method: "PATCH", headers: { origin: "https://evil.example" }, body: "{}" });
    expect((await PATCH(bad, ctx)).status).toBeGreaterThanOrEqual(400);
    expect((await PATCH(req("PATCH", { action: "nuke" }), ctx)).status).toBe(400);
  });
  it("applies a pause, stores revertPayload, appliedAt and audits", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    const res = await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx);
    expect(res.status).toBe(200);
    expect(ads.pauseAd).toHaveBeenCalledWith("t1", "a1", decider, applyReason);
    const final = db.optimizerProposal.updateMany.mock.calls.find((c) => c[0].data.status === "applied");
    expect(final?.[0].data.appliedAt).toBeInstanceOf(Date);
    expect(final?.[0].data.revertPayload).toMatchObject({ kind: "pause_ad", native: { was: "ACTIVE" } });
    expect(final?.[0].where).toMatchObject({ tenantId: "t1" });
    const actions = db.auditLog.create.mock.calls.map((c) => c[0].data.action);
    expect(actions).toEqual(expect.arrayContaining(["optimizer.proposal_approved", "optimizer.proposal_applied"]));
  });
  it("does not apply a proposal that is not open", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "rejected" }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
  it("loses a double-click race without applying twice", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
  it("expires an old proposal instead of applying", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ createdAt: new Date(Date.now() - 8 * 86_400_000) }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
  it("marks the proposal failed when Meta rejects the change", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    ads.pauseAd.mockRejectedValue(new Error("boom"));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(502);
    expect(db.optimizerProposal.updateMany.mock.calls.some((c) => c[0].data.status === "failed")).toBe(true);
  });
  it("rejects a proposal", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    expect((await PATCH(req("PATCH", { action: "reject" }), ctx)).status).toBe(200);
    expect(ads.pauseAd).not.toHaveBeenCalled();
    expect(db.auditLog.create.mock.calls[0][0].data.action).toBe("optimizer.proposal_rejected");
  });
  it("marks advisory proposals done without touching Meta", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ kind: "new_angle" }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.pauseAd).not.toHaveBeenCalled();
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("creates a client approval link", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    approvals.createApproval.mockResolvedValue({ id: "ap1", url: "https://wa.edwyz.com/approve/x" });
    const res = await PATCH(req("PATCH", { action: "request_approval" }), ctx);
    expect(approvals.createApproval).toHaveBeenCalledWith("t1", { subjectType: "optimizer_proposal", subjectId: "p1" });
    expect((await res.json()).approval.url).toContain("approve");
  });
});

describe("cap safety on apply", () => {
  it("applies a valid shift in two steps with undo data", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(1, "t1", "s1", 80_000, decider, applyReason);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(2, "t1", "s2", 120_000, decider, { ...applyReason, shiftFromAdSetId: "s1" });
    const final = db.optimizerProposal.updateMany.mock.calls.find((c) => c[0].data.status === "applied");
    expect(final?.[0].data.revertPayload.steps).toHaveLength(2);
  });
  it("refuses when no cap is set", async () => {
    settings(null);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("refuses a tampered payload above 20 percent or above the cap", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow({ payload: { ...shiftRow().payload, fromBudgetAfter: 50_000, toBudgetAfter: 150_000 } }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    settings(110_000);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("still applies a zero-sum shift when the workspace is already over its cap: the raise names the cut it follows (P3-01)", async () => {
    db.adCampaign.findMany.mockResolvedValue([activeCampaign(200_000), activeCampaign(200_001), activeCampaign(200_002)]);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(1, "t1", "s1", 80_000, decider, applyReason);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(2, "t1", "s2", 120_000, decider, { ...applyReason, shiftFromAdSetId: "s1" });
  });
  it("undoes the cut and fails the proposal when the cap clamps the raise (P3-01)", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    ads.setAdSetBudget
      .mockResolvedValueOnce({ revertPayload: {}, appliedDailyBudgetMinor: 80_000, clamped: false })
      .mockResolvedValueOnce({ revertPayload: {}, appliedDailyBudgetMinor: 110_000, clamped: true })
      .mockResolvedValue({ revertPayload: {}, appliedDailyBudgetMinor: 1, clamped: false });
    const res = await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx);
    expect(res.status).toBe(409);
    expect(db.optimizerProposal.updateMany.mock.calls.some((c) => c[0].data.status === "failed")).toBe(true);
    expect(db.optimizerProposal.updateMany.mock.calls.some((c) => c[0].data.status === "applied")).toBe(false);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(3, "t1", "s2", 100_000, decider, applyReason);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(4, "t1", "s1", 100_000, decider, { reason: "Undid the first half of a budget move that could not finish." });
  });
  it("allows a shift when the workspace total stays within the cap (P3-01)", async () => {
    db.adCampaign.findMany.mockResolvedValue([activeCampaign(200_000), activeCampaign(200_000)]);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenCalledTimes(2);
  });
  it("does not treat the platform ceiling alone as a configured cap", async () => {
    settings(null);
    process.env.MAX_DAILY_BUDGET_MINOR = "500000";
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("refuses when live budgets changed since the proposal", async () => {
    db.adSet.findMany.mockResolvedValue([{ metaAdSetId: "s1", dailyBudgetMinor: 90_000 }, { metaAdSetId: "s2", dailyBudgetMinor: 100_000 }]);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("undoes the first step when the second fails", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    ads.setAdSetBudget.mockResolvedValueOnce({ revertPayload: {} }).mockRejectedValueOnce(new Error("x")).mockResolvedValue({ revertPayload: {} });
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(502);
    expect(ads.setAdSetBudget).toHaveBeenLastCalledWith("t1", "s1", 100_000, decider, { reason: "Undid the first half of a budget move that could not finish." });
  });
});

describe("revert", () => {
  const applied = (over = {}) =>
    shiftRow({
      status: "applied",
      appliedAt: new Date(Date.now() - 86_400_000),
      revertPayload: { kind: "shift_budget", steps: [{ adSetMetaId: "s2", budgetBefore: 100_000, native: {} }, { adSetMetaId: "s1", budgetBefore: 100_000, native: {} }] },
      ...over,
    });
  it("restores budgets from the stored payload", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied());
    ads.setAdSetBudget.mockResolvedValueOnce({ revertPayload: { dailyBudgetMinor: 120_000 }, appliedDailyBudgetMinor: 100_000, clamped: false }).mockResolvedValue({ revertPayload: { dailyBudgetMinor: 80_000 }, appliedDailyBudgetMinor: 100_000, clamped: false });
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(1, "t1", "s2", 100_000, decider, undoReason);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(2, "t1", "s1", 100_000, decider, { ...undoReason, shiftFromAdSetId: "s2" });
    expect(db.optimizerProposal.updateMany.mock.calls.map((c) => c[0].data.status)).toEqual(["reverting", "reverted"]);
  });
  it("the restoring raise names the cut made just before it, so the book counts the freed budget (P3-01)", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied());
    ads.setAdSetBudget.mockResolvedValueOnce({ revertPayload: { dailyBudgetMinor: 120_000 }, appliedDailyBudgetMinor: 100_000, clamped: false }).mockResolvedValue({ revertPayload: { dailyBudgetMinor: 80_000 }, appliedDailyBudgetMinor: 100_000, clamped: false });
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(2, "t1", "s1", 100_000, decider, { ...undoReason, shiftFromAdSetId: "s2" });
  });
  it("a first undo step that raises names no cut", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied({ revertPayload: { kind: "shift_budget", steps: [{ adSetMetaId: "s1", budgetBefore: 100_000, native: {} }, { adSetMetaId: "s2", budgetBefore: 100_000, native: {} }] } }));
    ads.setAdSetBudget.mockResolvedValueOnce({ revertPayload: { dailyBudgetMinor: 80_000 }, appliedDailyBudgetMinor: 100_000, clamped: false }).mockResolvedValue({ revertPayload: { dailyBudgetMinor: 120_000 }, appliedDailyBudgetMinor: 100_000, clamped: false });
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(1, "t1", "s1", 100_000, decider, undoReason);
    expect(ads.setAdSetBudget).toHaveBeenNthCalledWith(2, "t1", "s2", 100_000, decider, undoReason);
  });
  it("does not mark a proposal reverted when a restoring step is clamped (P3-01)", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied());
    ads.setAdSetBudget.mockResolvedValueOnce({ revertPayload: { dailyBudgetMinor: 120_000 }, appliedDailyBudgetMinor: 100_000, clamped: false }).mockResolvedValue({ revertPayload: { dailyBudgetMinor: 80_000 }, appliedDailyBudgetMinor: 90_000, clamped: true });
    const res = await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no room to restore/);
    expect(db.optimizerProposal.updateMany.mock.calls.map((c) => c[0].data.status)).toEqual(["reverting", "applied"]);
  });
  it("needs the confirm flag and an applied proposal within 14 days", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied());
    expect((await PATCH(req("PATCH", { action: "revert" }), ctx)).status).toBe(400);
    db.optimizerProposal.findFirst.mockResolvedValue(applied({ appliedAt: new Date(Date.now() - 15 * 86_400_000) }));
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(409);
    db.optimizerProposal.findFirst.mockResolvedValue(applied({ status: "proposed" }));
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(409);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
  });
  it("puts the proposal back to applied when the undo fails", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied());
    ads.setAdSetBudget.mockRejectedValue(new Error("x"));
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(502);
    expect(db.optimizerProposal.updateMany.mock.calls.map((c) => c[0].data.status)).toEqual(["reverting", "applied"]);
  });
  it("reverts a pause through resumeAd", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(applied({ kind: "pause_ad", revertPayload: { kind: "pause_ad", adMetaId: "a1", native: { was: "ACTIVE" } } }));
    ads.resumeAd.mockResolvedValue(undefined);
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(200);
    // Reverting a pause turns the ad back on: a raise, made as the person reverting.
    expect(ads.resumeAd).toHaveBeenCalledWith("t1", "a1", { was: "ACTIVE" }, decider);
  });
});

describe("tenant isolation and settings", () => {
  it("scopes every proposal read to the actor tenant", async () => {
    auth.getActor.mockResolvedValue(actor("admin", "t9"));
    db.optimizerProposal.findFirst.mockResolvedValue(null);
    expect((await getOne(req("GET"), ctx)).status).toBe(404);
    expect(db.optimizerProposal.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", tenantId: "t9" });
    db.optimizerProposal.findMany.mockResolvedValue([]);
    await list(new Request("https://wa.edwyz.com/api/optimizer/proposals?status=applied&kind=pause_ad&tenantId=t1"));
    expect(db.optimizerProposal.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t9", status: "applied", kind: "pause_ad" });
    expect((await PATCH(req("PATCH", { action: "reject" }), ctx)).status).toBe(404);
    expect(db.optimizerProposal.updateMany).not.toHaveBeenCalled();
  });
  it("rejects bad filters", async () => {
    expect((await list(new Request("https://wa.edwyz.com/api/optimizer/proposals?status=zzz"))).status).toBe(400);
  });
  it("reads and writes settings under the tenant key, owner only", async () => {
    const put = (body: unknown) => putSettings(new Request("https://wa.edwyz.com/api/optimizer/settings", { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await put({ cprMultiple: 3 })).status).toBe(403);
    auth.getActor.mockResolvedValue(actor("owner", "t7"));
    db.platformSetting.upsert.mockResolvedValue({});
    expect((await put({ cprMultiple: 3 })).status).toBe(200);
    expect(db.platformSetting.upsert.mock.calls[0][0].where.key).toBe("optimizer:t7");
    expect((await put({ maxShiftPct: 40 })).status).toBe(400);
    const got = await (await getSettings(new Request("https://wa.edwyz.com/api/optimizer/settings"))).json();
    expect(got.settings.maxShiftPct).toBe(20);
  });
});

describe("approved proposals (growth-limits)", () => {
  it("allows approved to applied, failed or rejected, and nothing else", () => {
    expect(canTransition("approved", "applied")).toBe(true);
    expect(canTransition("approved", "failed")).toBe(true);
    expect(canTransition("approved", "rejected")).toBe(true);
    expect(canTransition("approved", "proposed")).toBe(false);
    expect(canTransition("approved", "expired")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
  });

  it("an admin can reject an approved proposal that was never applied", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "approved" }));
    expect((await PATCH(req("PATCH", { action: "reject" }), ctx)).status).toBe(200);
    const where = db.optimizerProposal.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "p1", tenantId: "t1", status: "approved" });
    expect(where.OR).toHaveLength(2);
    expect(db.optimizerProposal.updateMany.mock.calls[0][0].data).toMatchObject({ status: "rejected", decidedByUserId: "u1" });
  });

  it("confirming an approved proposal again finishes applying it without a second approval step", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "approved", decidedByUserId: "u1" }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.pauseAd).toHaveBeenCalledWith("t1", "a1", decider, applyReason);
    const moves = db.optimizerProposal.updateMany.mock.calls.map((c) => [c[0].where.status, c[0].data.status]);
    // the first update claims the apply (it only stamps appliedAt), the second records the result
    expect(moves).toEqual([["approved", undefined], ["approved", "applied"]]);
  });

  it("two confirms on an approved row never both apply: the loser of the claim is refused", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "approved", decidedByUserId: "u1" }));
    db.optimizerProposal.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });

  it("refuses to reject an approved row while its apply step is still running", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "approved", appliedAt: new Date() }));
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req("PATCH", { action: "reject" }), ctx)).status).toBe(409);
  });

  it("if a reject still lands during the apply, the row is corrected to applied instead of staying rejected", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    db.optimizerProposal.updateMany
      .mockResolvedValueOnce({ count: 1 }) // proposed -> approved
      .mockResolvedValueOnce({ count: 0 }) // approved -> applied lost to a reject
      .mockResolvedValueOnce({ count: 1 }); // rejected -> applied
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    const last = db.optimizerProposal.updateMany.mock.calls[2][0];
    expect(last.where).toMatchObject({ status: "rejected" });
    expect(last.data).toMatchObject({ status: "applied" });
  });

  it("still refuses a proposal that is already applied or rejected", async () => {
    for (const status of ["applied", "rejected", "failed"]) {
      db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status }));
      expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
    }
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });

  it("lists several statuses at once, with the client decision stored apart from the proposal", async () => {
    db.optimizerProposal.findMany.mockResolvedValue([pauseRow({ id: "p1", status: "proposed" }), pauseRow({ id: "p2", status: "approved" })]);
    approvals.getOptimizerClientDecisions.mockResolvedValue(new Map([["p1", { decision: "approved", approved: true, at: "2026-10-27T00:00:00.000Z" }]]));
    const res = await list(new Request("https://wa.edwyz.com/api/optimizer/proposals?status=proposed,approved"));
    expect(res.status).toBe(200);
    expect(db.optimizerProposal.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: { in: ["proposed", "approved"] } });
    const body = await res.json();
    expect(body.proposals.map((p: { id: string; status: string; clientDecision: unknown }) => [p.id, p.status, p.clientDecision !== null])).toEqual([["p1", "proposed", true], ["p2", "approved", false]]);
    expect(approvals.getOptimizerClientDecisions).toHaveBeenCalledWith("t1", ["p1", "p2"]);
  });

  it("rejects a list filter with an unknown status", async () => {
    expect((await list(new Request("https://wa.edwyz.com/api/optimizer/proposals?status=proposed,zzz"))).status).toBe(400);
  });

  it("the worker repairs old stuck rows once a day", () => {
    expect(worker.periodic.map((t) => t.name)).toContain("optimizer.repair-stuck-approved");
  });
});

describe("spending approvals and the assistant's policy (docs/SPEND-CONTROLS-SPEC.md 7.3)", () => {
  const raiseRow = (over = {}) => ({ ...shiftRow(), kind: "raise_budget", targetMetaId: "s2", payload: { adSetMetaId: "s2", adSetName: "Best", budgetBefore: 100_000, budgetAfter: 120_000 }, ...over });

  it("a raising proposal needs the owner or a named approver; an admin who is not one is refused before anything changes", async () => {
    spend.approverStatus.mockResolvedValue({ member: true, role: "admin", approver: false });
    db.optimizerProposal.findFirst.mockResolvedValue(raiseRow());
    const res = await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only the owner, or an admin the owner named as an approver/);
    expect(ads.setAdSetBudget).not.toHaveBeenCalled();
    expect(db.optimizerProposal.updateMany).not.toHaveBeenCalled();
  });

  it("a pause and a net-zero shift may be approved by any admin", async () => {
    spend.approverStatus.mockResolvedValue({ member: true, role: "admin", approver: false });
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow());
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenCalledTimes(2);
    expect(spend.approverStatus).not.toHaveBeenCalled();
  });

  it("an approver applies a raise through the Spend Book as their own action, with the Ad assistant on the ledger", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(raiseRow());
    (db.adSet as Record<string, unknown>).findFirst = vi.fn(async () => ({ dailyBudgetMinor: 100_000 }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(ads.setAdSetBudget).toHaveBeenCalledWith("t1", "s2", 120_000, decider, { reason: expect.stringMatching(/approved suggestion/) });
    expect(spend.noteHumanDecision).toHaveBeenCalledWith("t1", { proposalId: "p1" }, "approved", "u1");
  });

  it("with a spending request waiting, approving or rejecting decides that request (so it applies once, from either page)", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow());
    spend.pendingApprovalForProposal.mockResolvedValue({ id: "sa9" });
    spend.decideApproval.mockResolvedValue({ status: "applied", text: "Approved and applied.", approval: {} });
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(200);
    expect(spend.decideApproval).toHaveBeenCalledWith("t1", "sa9", "approve", "app", { type: "user", userId: "u1", role: "admin" });
    expect(ads.pauseAd).not.toHaveBeenCalled();
    spend.decideApproval.mockResolvedValue({ status: "failed", text: "The ad set changed since this was asked.", approval: {} });
    const failed = await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx);
    expect(failed.status).toBe(409);
    expect((await failed.json()).error).toBe("The ad set changed since this was asked.");
    spend.decideApproval.mockResolvedValue({ status: "declined", text: "Declined.", approval: {} });
    expect((await PATCH(req("PATCH", { action: "reject" }), ctx)).status).toBe(200);
    expect(spend.decideApproval).toHaveBeenLastCalledWith("t1", "sa9", "decline", "app", { type: "user", userId: "u1", role: "admin" });
  });

  it("reverting a pause is a raise and needs an approver; reverting a shift does not", async () => {
    spend.approverStatus.mockResolvedValue({ member: true, role: "admin", approver: false });
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ status: "applied", appliedAt: new Date(), revertPayload: { kind: "pause_ad", adMetaId: "a1", native: {} } }));
    const res = await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx);
    expect(res.status).toBe(403);
    expect(ads.resumeAd).not.toHaveBeenCalled();
    db.optimizerProposal.findFirst.mockResolvedValue(shiftRow({ status: "applied", appliedAt: new Date(), revertPayload: { kind: "shift_budget", steps: [{ adSetMetaId: "s2", budgetBefore: 100_000 }, { adSetMetaId: "s1", budgetBefore: 100_000 }] } }));
    ads.setAdSetBudget.mockResolvedValue({ revertPayload: { dailyBudgetMinor: 120_000 }, appliedDailyBudgetMinor: 100_000, clamped: false });
    expect((await PATCH(req("PATCH", { action: "revert", confirm: true }), ctx)).status).toBe(200);
  });

  it("an admin can ask the approvers about a suggestion they may not approve", async () => {
    db.optimizerProposal.findFirst.mockResolvedValue(raiseRow());
    (db.adCampaign as Record<string, unknown>).findFirst = vi.fn(async () => ({ currency: "INR" }));
    const res = await PATCH(req("PATCH", { action: "ask_approver" }), ctx);
    expect(res.status).toBe(200);
    expect(spend.createProposalApproval).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "p1", direction: "raise", summary: "Raise the daily budget of 'Best' from ₹1,000 to ₹1,200", actor: { type: "user", userId: "u1", role: "admin" } }));
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ kind: "new_angle" }));
    expect((await PATCH(req("PATCH", { action: "ask_approver" }), ctx)).status).toBe(409);
  });

  it("suggestions expire after 12 hours, not days", async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 0 });
    const now = new Date("2026-10-28T12:00:00Z");
    await runForTenant("t1", now);
    expect(db.optimizerProposal.updateMany.mock.calls[0][0].where.createdAt.lt).toEqual(new Date(now.getTime() - 12 * 3_600_000));
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ createdAt: new Date(Date.now() - 13 * 3_600_000) }));
    expect((await PATCH(req("PATCH", { action: "approve", confirm: true }), ctx)).status).toBe(409);
  });

  const dailyRun = async () => {
    db.platformSetting.findUnique.mockResolvedValue(null);
    db.optimizerProposal.updateMany.mockResolvedValue({ count: 1 });
    db.optimizerProposal.findMany.mockResolvedValue([]);
    db.optimizerProposal.create.mockResolvedValue({ id: "p_new" });
    db.optimizerProposal.findFirst.mockResolvedValue(pauseRow({ id: "p_new" }));
    db.adCampaign.findMany.mockResolvedValue([{ metaCampaignId: "c1", currency: "INR", adSets: [{ metaAdSetId: "s1", name: "S", dailyBudgetMinor: 100_000, ads: [{ metaAdId: "a1", name: "A", creative: {} }] }] }]);
    db.insightSnapshot.findMany.mockImplementation(async ({ where }: { where: { entityType: string } }) =>
      where.entityType === "ad" ? [{ entityMetaId: "a1", date: new Date(), spendMinor: 500_000, impressions: 0, clicks: 0, results: 0, frequency: null }] : [],
    );
    return runForTenant("t1");
  };

  it("the daily run applies an automatic proposal as the Ad assistant", async () => {
    verdict = "auto";
    const res = await dailyRun();
    expect(res.routed).toEqual([{ id: "p_new", verdict: "auto", applied: true }]);
    expect(ads.pauseAd).toHaveBeenCalledWith("t1", "a1", { type: "assistant", assistantKey: "ads_optimizer" }, applyReason);
    expect(spend.createProposalApproval).not.toHaveBeenCalled();
  });

  it("while learning, the daily run records what it would have done and still asks a person", async () => {
    verdict = "shadow";
    const res = await dailyRun();
    expect(res.routed).toEqual([{ id: "p_new", verdict: "shadow" }]);
    expect(spend.recordShadow).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "p_new", assistantKey: "ads_optimizer", would: "auto", actionKind: "pause_ad" }));
    expect(spend.createProposalApproval).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "p_new" }));
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });

  it("a refusal leaves the proposal as it is", async () => {
    verdict = "refuse";
    const res = await dailyRun();
    expect(res.routed).toEqual([{ id: "p_new", verdict: "refuse" }]);
    expect(spend.createProposalApproval).not.toHaveBeenCalled();
    expect(ads.pauseAd).not.toHaveBeenCalled();
  });
});
