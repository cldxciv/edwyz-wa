import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * Spending approvals (docs/SPEND-CONTROLS-SPEC.md 7.3, 7.4, 2.3.6, 2.3.10, 4.16) through the real Spend Book, approvals module,
 * optimizer service and routes on the in-memory spend database. The ads actions are stand-ins that call the real book
 * (reserveAds / settleAds / recordLowering), so "re-runs reserveAds" is the real thing; Meta is never called.
 */

process.env.SESSION_SECRET = "s".repeat(40);
process.env.EMAIL_VERIFICATION_REQUIRED = "false";
process.env.SITE_URL = "https://wa.test";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  calls: [] as { fn: string; args: unknown[] }[],
  keyN: 0,
  billing: "active" as "active" | "locked",
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })) }));
vi.mock("@/lib/approvals", () => ({ createApproval: vi.fn(), getOptimizerClientDecisions: vi.fn(async () => new Map()) }));
vi.mock("@/lib/billing", async () => {
  const { HttpError } = await import("@/lib/tenancy");
  return {
    assertTenantCanWrite: vi.fn(async () => {
      if (h.billing === "locked") throw new HttpError(402, "Your subscription is inactive.");
    }),
  };
});
vi.mock("@/lib/ads/actions", async () => {
  const book = await import("@/lib/spend/book");
  const set = (metaAdSetId: string) => h.db.rows("adSet").find((r) => r.metaAdSetId === metaAdSetId)!;
  return {
    setAdSetBudget: vi.fn(async (tenantId: string, metaAdSetId: string, minor: number, actor: never, opts: Record<string, unknown> = {}) => {
      h.calls.push({ fn: "setAdSetBudget", args: [tenantId, metaAdSetId, minor, actor, opts] });
      const row = set(metaAdSetId);
      const prev = Number(row.dailyBudgetMinor);
      if (minor > prev) {
        const permit = await book.reserveAds(tenantId, { kind: "raise_budget", adSetId: String(row.id), metaAdSetId, toMinor: BigInt(minor) }, actor, {
          idempotencyKey: String(opts.idempotencyKey ?? `k${++h.keyN}`),
          reason: String(opts.reason ?? "Raised"),
          approvalId: opts.approvalId as string | undefined,
          env: { SPEND_ENFORCE: "enforce" },
        });
        await book.settleAds(permit, "applied");
      } else {
        await book.recordLowering(tenantId, { kind: "cut_budget", metaObjectId: metaAdSetId, toMinor: BigInt(minor) }, actor, String(opts.reason ?? "Lowered"), async () => undefined);
      }
      row.dailyBudgetMinor = minor;
      return { revertPayload: { action: "set_adset_budget", metaAdSetId, dailyBudgetMinor: prev }, appliedDailyBudgetMinor: minor, clamped: false };
    }),
    pauseAd: vi.fn(async (...args: unknown[]) => {
      h.calls.push({ fn: "pauseAd", args });
      return { revertPayload: { action: "resume_ad", metaAdId: args[1], previousStatus: "active" } };
    }),
    pauseAdSet: vi.fn(async (...args: unknown[]) => {
      h.calls.push({ fn: "pauseAdSet", args });
      return { revertPayload: {} };
    }),
    resumeAd: vi.fn(async (...args: unknown[]) => {
      h.calls.push({ fn: "resumeAd", args });
      return { revertPayload: {} };
    }),
  };
});

import { POST as approvalsPost, GET as approvalsGet } from "@/app/api/spend/approvals/route";
import { POST as decidePost } from "@/app/api/spend/approvals/[id]/route";
import { GET as tokenGet, POST as tokenPost } from "@/app/api/spend/approvals/token/route";
import { signAccessToken } from "@/lib/auth/tokens";
import { approveProposal, revertProposal, APPROVER_ONLY_PROPOSAL, APPROVER_ONLY_REVERT } from "@/lib/optimizer/service";
import {
  APPROVER_ONLY,
  CHANGED_SINCE_ASKED,
  createProposalApproval,
  decideApproval,
  decideByToken,
  displayStatus,
  expiredText,
  failureText,
  listApprovals,
  NOT_A_MEMBER,
  noLongerFitsText,
  parseAdsIntent,
  statusLine,
  supersedeChangedApprovals,
  toApprovalDTO,
  toApprovalRow,
  viewByToken,
} from "@/lib/spend/approvals";
import { AdsNeedsApprovalError, reserveAds, resetBookForTests } from "@/lib/spend/book";
import { SpendBlockedError } from "@/lib/spend/errors";
import { resetSpendStateCache, setWorkspaceFreeze } from "@/lib/spend/kill";
import { periodic, runApprovalsSweep } from "@/lib/spend/tasks/approvals";
import type { AdsRaiseIntent, SpendActor } from "@/lib/spend/types";

// Wednesday 28 Oct 2026, 12:00 in Asia/Kolkata.
const NOW = new Date("2026-10-28T06:30:00Z");
const HOUR = 3_600_000;
const T = "t1";
const ORIGIN = "https://wa.test";
const INR = (rupees: number) => BigInt(rupees * 100);
type Who = { userId: string; tenantId: string; role: "owner" | "admin" | "agent" };
const OWNER: Who = { userId: "u_owner", tenantId: T, role: "owner" };
const APPROVER: Who = { userId: "u_admin", tenantId: T, role: "admin" };
const ADMIN2: Who = { userId: "u_admin2", tenantId: T, role: "admin" };
const AGENT: Who = { userId: "u_agent", tenantId: T, role: "agent" };
const assistant: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };
const user = (w: Who) => ({ type: "user" as const, userId: w.userId, role: w.role });

const rows = (name: string) => h.db.rows(name);
const ledger = (phase?: string) => rows("spendLedger").filter((r) => !phase || r.phase === phase);
const approvalRow = (id: string) => rows("spendApproval").find((r) => r.id === id)!;
const callsOf = (fn: string) => h.calls.filter((c) => c.fn === fn);

function seed() {
  h.db.seed("tenant", [{ id: T, name: "Shop", slug: "shop", status: "active", billingExempt: false }]);
  h.db.seed("user", [OWNER, APPROVER, ADMIN2, AGENT].map((w, i) => ({ id: w.userId, name: ["Priya Shah", "Arjun Rao", "Meera Iyer", "Kabir Das"][i], email: `${w.userId}@x.test` })));
  h.db.seed("membership", [OWNER, APPROVER, ADMIN2, AGENT].map((m) => ({ id: `m_${m.userId}`, ...m })));
  h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, connectionId: "mc1", type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata" }, sandbox: false, createdAt: new Date("2026-01-01") }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "acc1", timezone: "Asia/Kolkata", approverUserIds: [APPROVER.userId] }]);
  h.db.seed("spendAllowance", [{ id: "sa1", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: INR(5_000), monthlyLimitMinor: INR(50_000) }]);
  h.db.seed("adCampaign", [{ id: "c1", tenantId: T, adAccountAssetId: "acc1", metaCampaignId: "m_c1", name: "Diwali leads", template: "lead_generation", objective: "OUTCOME_LEADS", status: "active", dailyBudgetMinor: 100_000, currency: "INR", endsAt: null, origin: "human", assistantKey: null, lifetimeBudgetMinor: null, sandbox: false }]);
  h.db.seed("adSet", [{ id: "c1s", tenantId: T, campaignId: "c1", metaAdSetId: "m_c1s", name: "Delhi", status: "active", targeting: {}, dailyBudgetMinor: 100_000, lifetimeBudgetMinor: null }]);
  h.db.seed("ad", [{ id: "c1a", tenantId: T, adSetId: "c1s", metaAdId: "m_c1a", name: "Ad", status: "active", creative: {} }]);
  h.db.seed("spendCommitment", [
    { id: "cm_c1", tenantId: T, adAccountAssetId: "acc1", campaignId: "c1", adSetId: "c1s", metaObjectId: "m_c1s", objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: INR(1_000), dayKey: new Date(Date.UTC(2026, 9, 28)), dayStartBudgetMinor: INR(1_000), peakDailyBudgetMinor: INR(1_000), weekStart: new Date(Date.UTC(2026, 9, 25)), weekPeakDailyBudgetMinor: INR(1_000), status: "live" },
  ]);
}

const raise = (rupees: number): AdsRaiseIntent => ({ kind: "raise_budget", adSetId: "c1s", metaAdSetId: "m_c1s", toMinor: INR(rupees) });

/** The ad assistant asks to raise c1's budget; without a mandate that is a suggestion waiting for an approver. */
async function assistantAsks(rupees = 1_100): Promise<{ id: string; token: string }> {
  const e = await reserveAds(T, raise(rupees), assistant, { idempotencyKey: `ask${++h.keyN}`, reason: "Cost per lead is ₹62, well below your ₹100 target", env: { SPEND_ENFORCE: "enforce" } }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AdsNeedsApprovalError);
  const err = e as AdsNeedsApprovalError;
  return { id: err.approvalId, token: err.token };
}

function req(path: string, who: Who | null, body?: unknown, method = "POST") {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
  if (who) headers.authorization = `Bearer ${signAccessToken({ sub: who.userId, tid: who.tenantId, role: who.role })}`;
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(() => {
  // getActor reads the membership by its compound key with the user and workspace: give the base fake that lookup.
  const membership = h.db.prisma.membership as unknown as Row;
  membership.findUnique = async ({ where }: Row) => {
    const key = (where as Row).tenantId_userId as Row;
    const m = rows("membership").find((r) => r.tenantId === key.tenantId && r.userId === key.userId);
    return m ? { ...m, user: { disabledAt: null, emailVerifiedAt: new Date("2026-01-01") }, tenant: { deletedAt: null } } : null;
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db.reset();
  h.calls = [];
  h.billing = "active";
  resetSpendStateCache();
  resetBookForTests();
  seed();
});
afterEach(() => vi.useRealTimers());

// =====================================================================================================================

describe("approving an assistant's request (7.3)", () => {
  it("re-runs reserveAds as the assistant with the approvalId (skipping only the autonomy step) and applies it through ads/actions", async () => {
    const { id } = await assistantAsks();
    const out = await decideApproval(T, id, "approve", "app", user(OWNER));
    expect(out.status).toBe("applied");
    expect(out.text).toBe("Approved and applied.");
    const [call] = callsOf("setAdSetBudget");
    expect(call.args.slice(0, 4)).toEqual([T, "m_c1s", 110_000, { type: "assistant", assistantKey: "ads_optimizer", approvalId: id }]);
    expect(call.args[4]).toMatchObject({ approvalId: id, idempotencyKey: `approval:${id}` });
    const requested = ledger("requested").find((r) => r.action === "ads.adset.budget_raise")!;
    expect(requested).toMatchObject({ actorType: "assistant", assistantKey: "ads_optimizer", approvalId: id });
    expect(ledger("applied").some((r) => r.correlationId === requested.correlationId)).toBe(true);
    expect(approvalRow(id)).toMatchObject({ status: "applied", decidedByUserId: OWNER.userId, decidedVia: "app" });
    expect(ledger("info").map((r) => r.action)).toEqual(expect.arrayContaining(["approval.create", "approval.approve", "approval.apply"]));
  });

  it("fails with 'The ad set changed since this was asked.' when the fingerprint no longer matches, and changes nothing", async () => {
    const { id } = await assistantAsks();
    rows("spendCommitment")[0].dailyBudgetMinor = INR(900);
    const out = await decideApproval(T, id, "approve", "app", user(OWNER));
    expect(out.status).toBe("failed");
    expect(out.text).toBe(CHANGED_SINCE_ASKED);
    expect(approvalRow(id)).toMatchObject({ status: "failed", failureReason: "The ad set changed since this was asked." });
    expect(callsOf("setAdSetBudget")).toHaveLength(0);
    expect(out.approval.expiryText).toBe("Approved, but not applied: The ad set changed since this was asked.");
  });

  it("fails with 'No longer fits your limits: ₹Y left, needs ₹X' when the limits filled up meanwhile", async () => {
    const { id } = await assistantAsks();
    // Another ad set spent ₹3,200 today: 3,200 + 1,750 at worst for c1 leaves ₹50; the raise could add ₹175.
    h.db.seed("spendDaily", [{ tenantId: T, pot: "ads", scopeType: "adset", scopeId: "m_other", day: new Date("2026-10-28T00:00:00Z"), currency: "INR", amountMinor: INR(3_200), origin: "platform", source: "fast_sync", syncedAt: new Date(NOW.getTime() - 5 * 60_000) }]);
    const out = await decideApproval(T, id, "approve", "app", user(OWNER));
    expect(out.status).toBe("failed");
    expect(approvalRow(id).failureReason).toBe("No longer fits your limits: ₹50 left, needs ₹175");
    expect(ledger("refused").some((r) => r.approvalId === id)).toBe(true);
  });

  it("a double tap applies once: one conditional update wins, the other gets 409", async () => {
    const { id } = await assistantAsks();
    const results = await Promise.allSettled([decideApproval(T, id, "approve", "app", user(OWNER)), decideApproval(T, id, "approve", "link", user(APPROVER))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect(callsOf("setAdSetBudget")).toHaveLength(1);
  });

  it("a request past expiresAt cannot be approved even before the expiry task runs: it is declined automatically", async () => {
    const { id } = await assistantAsks();
    vi.setSystemTime(new Date(NOW.getTime() + 12 * HOUR + 1_000));
    const err = (await decideApproval(T, id, "approve", "app", user(OWNER)).catch((e: unknown) => e)) as { status: number; message: string };
    expect(err.status).toBe(410);
    expect(err.message).toBe("This request expired. Declined automatically (no answer in 12 hours).");
    expect(approvalRow(id).status).toBe("expired");
    expect(ledger("info").filter((r) => r.action === "approval.expire")).toHaveLength(1);
    expect(callsOf("setAdSetBudget")).toHaveLength(0);
  });

  it("spend.approvals.expire runs every 5 minutes and turns an unanswered request into 'Declined automatically'", async () => {
    expect(periodic.find((p) => p.name === "spend.approvals.expire")?.everyMs).toBe(5 * 60_000);
    const { id } = await assistantAsks();
    const later = new Date(NOW.getTime() + 12 * HOUR + 4 * 60_000);
    vi.setSystemTime(later);
    expect((await runApprovalsSweep(later)).expired).toBe(1);
    expect(approvalRow(id)).toMatchObject({ status: "expired", decidedVia: "system" });
    const [dto] = await listApprovals(T, { userId: OWNER.userId, role: "owner" }, { status: "recent" });
    expect(dto.status).toBe("expired");
    expect(dto.expiryText).toBe("Declined automatically (no answer in 12 hours).");
    expect((await runApprovalsSweep(later)).expired).toBe(0);
  });

  it("an approver demoted after the request cannot approve; a removed member cannot decide at all", async () => {
    const { id } = await assistantAsks();
    rows("membership").find((m) => m.userId === APPROVER.userId)!.role = "agent";
    await expect(decideApproval(T, id, "approve", "app", user(APPROVER))).rejects.toMatchObject({ status: 403, message: APPROVER_ONLY });
    h.db.tables.membership = rows("membership").filter((m) => m.userId !== APPROVER.userId);
    await expect(decideApproval(T, id, "decline", "app", user(APPROVER))).rejects.toMatchObject({ status: 403, message: NOT_A_MEMBER });
    expect(approvalRow(id).status).toBe("pending");
  });

  it("an admin who is not a named approver can decline but not approve a raise", async () => {
    const { id } = await assistantAsks();
    await expect(decideApproval(T, id, "approve", "app", user(ADMIN2))).rejects.toMatchObject({ status: 403 });
    await expect(decideApproval(T, id, "decline", "app", user(AGENT))).rejects.toMatchObject({ status: 403 });
    const out = await decideApproval(T, id, "decline", "app", user(ADMIN2));
    expect(out).toMatchObject({ status: "declined", text: "Declined. Nothing was changed." });
    expect(callsOf("setAdSetBudget")).toHaveLength(0);
  });
});

describe("supersede (7.3)", () => {
  it("stopping all spending supersedes what is waiting", async () => {
    const { id } = await assistantAsks();
    await setWorkspaceFreeze(T, "all", user(OWNER), "Holiday");
    expect(approvalRow(id)).toMatchObject({ status: "superseded", decidedVia: "system" });
    await expect(decideApproval(T, id, "approve", "app", user(OWNER))).rejects.toMatchObject({ status: 409 });
  });

  it("a new request about the same ad set supersedes the older one", async () => {
    const first = await assistantAsks(1_100);
    const second = await assistantAsks(1_150);
    expect(approvalRow(first.id).status).toBe("superseded");
    expect(approvalRow(second.id).status).toBe("pending");
    // The same for optimizer requests: a new one on the same ad set replaces the older one, a re-run never asks twice.
    h.db.seed("optimizerProposal", [proposal("p1", "raise_budget"), proposal("p2", "raise_budget")]);
    const a = await createProposalApproval(proposalRequest("p1"));
    const again = await createProposalApproval(proposalRequest("p1"));
    expect(again).toMatchObject({ approvalId: a.approvalId, created: false });
    const b = await createProposalApproval(proposalRequest("p2"));
    expect(approvalRow(a.approvalId).status).toBe("superseded");
    expect(approvalRow(second.id).status).toBe("superseded");
    expect(approvalRow(b.approvalId).status).toBe("pending");
  });

  it("a changed fingerprint supersedes a waiting request in the 5-minute pass", async () => {
    const { id } = await assistantAsks();
    expect((await supersedeChangedApprovals()).superseded).toBe(0);
    rows("spendCommitment")[0].dailyBudgetMinor = INR(950);
    expect((await supersedeChangedApprovals()).superseded).toBe(1);
    expect(approvalRow(id)).toMatchObject({ status: "superseded", failureReason: CHANGED_SINCE_ASKED });
  });
});

describe("the one-tap link (7.4)", () => {
  it("decline works with the token alone, signed out", async () => {
    const { id, token } = await assistantAsks();
    const res = await tokenPost(req("/api/spend/approvals/token", null, { token, decision: "decline" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as Row).status).toBe("declined");
    expect(approvalRow(id)).toMatchObject({ status: "declined", decidedVia: "link", decidedByUserId: null });
    expect(ledger("info").find((r) => r.action === "approval.decline")).toMatchObject({ actorType: "system", actorId: "approval_link" });
  });

  it("approve requires a signed-in approver session: signed out it asks to sign in, then one tap applies it", async () => {
    const { id, token } = await assistantAsks();
    const out = await tokenPost(req("/api/spend/approvals/token", null, { token, decision: "approve" }));
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ code: "spend.sign_in", signInUrl: `/login?next=${encodeURIComponent(`/app/settings/spending?approval=${id}`)}` });
    expect(approvalRow(id).status).toBe("pending");
    await expect(decideByToken(token, "approve", null)).rejects.toMatchObject({ status: 401 });
    const notApprover = await tokenPost(req("/api/spend/approvals/token", ADMIN2, { token, decision: "approve" }));
    expect(notApprover.status).toBe(403);
    const ok = await tokenPost(req("/api/spend/approvals/token", OWNER, { token, decision: "approve" }));
    expect(ok.status).toBe(200);
    expect(approvalRow(id)).toMatchObject({ status: "applied", decidedVia: "link" });
  });

  it("approving a raise checks the paywall; declining never does", async () => {
    const { token } = await assistantAsks();
    h.billing = "locked";
    expect((await tokenPost(req("/api/spend/approvals/token", OWNER, { token, decision: "approve" }))).status).toBe(402);
    expect((await tokenPost(req("/api/spend/approvals/token", null, { token, decision: "decline" }))).status).toBe(200);
  });

  it("shows the request, what it could add and the time left to anyone holding the link; an unknown link is a 404", async () => {
    const { token } = await assistantAsks();
    const res = await tokenGet(new Request(`${ORIGIN}/api/spend/approvals/token?token=${token}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: Row; workspaceName: string; needsSignInToApprove: boolean };
    expect(body.workspaceName).toBe("Shop");
    expect(body.needsSignInToApprove).toBe(true);
    expect(body.approval).toMatchObject({ summary: "Raise the daily budget of 'Delhi' from ₹1,000 to ₹1,100", reason: "Why: Cost per lead is ₹62, well below your ₹100 target", status: "pending", canDecline: true, canApprove: false, expiryText: "Declined automatically in 12 hours" });
    expect(String(body.approval.forecastText)).toMatch(/^Could add up to ₹[\d,]+ this month \(worst case\)$/);
    expect((await tokenGet(new Request(`${ORIGIN}/api/spend/approvals/token?token=${"x".repeat(43)}`))).status).toBe(404);
    expect(await viewByToken("not-a-token", null)).toBeNull();
  });

  it("limits decisions to 10 per token per hour", async () => {
    const { token } = await assistantAsks();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await tokenPost(req("/api/spend/approvals/token", null, { token, decision: "decline" }))).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1, 10).every((s) => s === 409)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("the app routes", () => {
  it("lists requests for owners and admins with the right buttons; team members get 403", async () => {
    await assistantAsks();
    const owner = (await (await approvalsGet(req("/api/spend/approvals", OWNER, undefined, "GET"))).json()) as { approvals: Row[]; waiting: number };
    expect(owner.waiting).toBe(1);
    expect(owner.approvals[0]).toMatchObject({ canApprove: true, canDecline: true, assistantLabel: "Ad assistant" });
    const admin2 = (await (await approvalsGet(req("/api/spend/approvals", ADMIN2, undefined, "GET"))).json()) as { approvals: Row[] };
    expect(admin2.approvals[0]).toMatchObject({ canApprove: false, canDecline: true });
    expect((await approvalsGet(req("/api/spend/approvals", AGENT, undefined, "GET"))).status).toBe(403);
  });

  it("POST /api/spend/approvals/[id] approves for an approver, refuses a non-approver and a team member", async () => {
    const { id } = await assistantAsks();
    const path = `/api/spend/approvals/${id}`;
    const ctx = { params: Promise.resolve({ id }) };
    expect((await decidePost(req(path, AGENT, { decision: "decline" }), ctx)).status).toBe(403);
    expect((await decidePost(req(path, ADMIN2, { decision: "approve" }), ctx)).status).toBe(403);
    expect((await decidePost(req(path, APPROVER, { decision: "nope" }), ctx)).status).toBe(400);
    const res = await decidePost(req(path, APPROVER, { decision: "approve" }), ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).status).toBe("applied");
  });

  it("an admin who may not approve a raising suggestion asks the approvers (POST /api/spend/approvals)", async () => {
    h.db.seed("optimizerProposal", [proposal("p1", "raise_budget")]);
    const res = await approvalsPost(req("/api/spend/approvals", ADMIN2, { proposalId: "p1" }));
    expect(res.status).toBe(201);
    const [a] = rows("spendApproval");
    expect(a).toMatchObject({ proposalId: "p1", direction: "raise", actionKind: "raise_budget", summary: "Raise the daily budget of 'Delhi' from ₹1,000 to ₹1,200" });
    expect(ledger("info").find((r) => r.action === "approval.create")).toMatchObject({ actorType: "user", actorId: ADMIN2.userId });
    // Notified through the notify port (in-app until WhatsApp is wired).
    expect(rows("notice").find((n) => n.kind === "approval_waiting")).toMatchObject({ source: "spend", audienceMinRole: "admin" });
  });
});

// =====================================================================================================================
// Optimizer integration (7.3)
// =====================================================================================================================

function proposal(id: string, kind: string, over: Row = {}): Row {
  const payloads: Record<string, Row> = {
    raise_budget: { adSetMetaId: "m_c1s", adSetName: "Delhi", budgetBefore: 100_000, budgetAfter: 120_000, campaignMetaId: "m_c1" },
    pause_ad: { adName: "Carousel B", spendMinor: 3_100, results: 0, windowDays: 7, reason: "zero_results" },
  };
  return { id, tenantId: T, kind, targetType: kind === "pause_ad" ? "ad" : "adset", targetMetaId: kind === "pause_ad" ? "m_c1a" : "m_c1s", rationale: "Cost per lead is low.", payload: payloads[kind] ?? {}, status: "proposed", createdAt: new Date(NOW.getTime() - HOUR), appliedAt: null, revertPayload: null, decidedByUserId: null, ...over };
}

function proposalRequest(proposalId: string) {
  const isPause = rows("optimizerProposal").find((p) => p.id === proposalId)?.kind === "pause_ad";
  return {
    tenantId: T,
    assistantKey: "ads_optimizer",
    proposalId,
    proposalKind: isPause ? "pause_ad" : "raise_budget",
    direction: (isPause ? "lower" : "raise") as "lower" | "raise",
    summary: isPause ? "Pause the ad 'Carousel B'" : "Raise the daily budget of 'Delhi' from ₹1,000 to ₹1,200",
    reason: "Cost per lead is low.",
    subject: isPause ? "ad:m_c1a" : "adset:m_c1s",
    objectIds: isPause ? ["m_c1a"] : ["m_c1s"],
    payload: (rows("optimizerProposal").find((p) => p.id === proposalId)?.payload ?? {}) as Record<string, unknown>,
  };
}

const actorOf = (w: Who) => ({ userId: w.userId, tenantId: T, role: w.role });

describe("optimizer proposals and approvals", () => {
  it("a raising optimizer proposal is refused for an admin who is not an approver; the owner applies it as their own action", async () => {
    h.db.seed("optimizerProposal", [proposal("p1", "raise_budget")]);
    await expect(approveProposal(actorOf(ADMIN2), "p1", true)).rejects.toMatchObject({ status: 403, message: APPROVER_ONLY_PROPOSAL });
    expect(callsOf("setAdSetBudget")).toHaveLength(0);
    await approveProposal(actorOf(OWNER), "p1", true);
    const [call] = callsOf("setAdSetBudget");
    expect(call.args.slice(0, 4)).toEqual([T, "m_c1s", 120_000, { type: "user", userId: OWNER.userId, role: "owner", assistantKey: "ads_optimizer" }]);
    expect(ledger("requested").find((r) => r.action === "ads.adset.budget_raise")).toMatchObject({ actorType: "user", actorId: OWNER.userId, assistantKey: "ads_optimizer" });
    expect(rows("optimizerProposal")[0]).toMatchObject({ status: "applied", revertPayload: { kind: "raise_budget", adSetMetaId: "m_c1s", budgetBefore: 100_000 } });
  });

  it("reverting a pause turns spending back up, so it needs an approver; any admin may revert a raise", async () => {
    h.db.seed("optimizerProposal", [
      proposal("p1", "pause_ad", { status: "applied", appliedAt: new Date(NOW.getTime() - HOUR), revertPayload: { kind: "pause_ad", adMetaId: "m_c1a", native: { action: "resume_ad", metaAdId: "m_c1a", previousStatus: "active" } } }),
      proposal("p2", "raise_budget", { status: "applied", appliedAt: new Date(NOW.getTime() - HOUR), revertPayload: { kind: "raise_budget", adSetMetaId: "m_c1s", budgetBefore: 90_000 } }),
    ]);
    await expect(revertProposal(actorOf(ADMIN2), "p1")).rejects.toMatchObject({ status: 403, message: APPROVER_ONLY_REVERT });
    expect(callsOf("resumeAd")).toHaveLength(0);
    await revertProposal(actorOf(APPROVER), "p1");
    expect(callsOf("resumeAd")[0].args[3]).toEqual({ type: "user", userId: APPROVER.userId, role: "admin", assistantKey: "ads_optimizer" });
    await revertProposal(actorOf(ADMIN2), "p2");
    expect(callsOf("setAdSetBudget")[0].args.slice(1, 3)).toEqual(["m_c1s", 90_000]);
  });

  it("a waiting request is decided once, from the Spending page or the optimizer page, and runs as the approver with the approvalId", async () => {
    h.db.seed("optimizerProposal", [proposal("p1", "pause_ad")]);
    const made = await createProposalApproval(proposalRequest("p1"));
    // A lowering suggestion: any admin may approve it.
    await approveProposal(actorOf(ADMIN2), "p1", true);
    expect(approvalRow(made.approvalId)).toMatchObject({ status: "applied", decidedByUserId: ADMIN2.userId });
    const [call] = callsOf("pauseAd");
    expect(call.args.slice(0, 3)).toEqual([T, "m_c1a", { type: "user", userId: ADMIN2.userId, role: "admin", assistantKey: "ads_optimizer", approvalId: made.approvalId }]);
    await expect(decideApproval(T, made.approvalId, "approve", "app", user(OWNER))).rejects.toMatchObject({ status: 409 });
    expect(callsOf("pauseAd")).toHaveLength(1);
    expect(rows("optimizerProposal")[0].status).toBe("applied");
  });

  it("declining a request rejects its proposal; an expired request expires it", async () => {
    h.db.seed("optimizerProposal", [proposal("p1", "pause_ad"), proposal("p2", "raise_budget", { targetMetaId: "m_x", payload: { adSetMetaId: "m_x", budgetBefore: 1, budgetAfter: 2 } })]);
    const a = await createProposalApproval(proposalRequest("p1"));
    await decideApproval(T, a.approvalId, "decline", "app", user(ADMIN2));
    expect(rows("optimizerProposal").find((p) => p.id === "p1")).toMatchObject({ status: "rejected", decidedByUserId: ADMIN2.userId });
    const b = await createProposalApproval({ ...proposalRequest("p2"), subject: "adset:m_x", objectIds: ["m_x"] });
    vi.setSystemTime(new Date(NOW.getTime() + 13 * HOUR));
    await runApprovalsSweep();
    expect(approvalRow(b.approvalId).status).toBe("expired");
    expect(rows("optimizerProposal").find((p) => p.id === "p2")?.status).toBe("expired");
  });
});

// =====================================================================================================================
// Pure parts
// =====================================================================================================================

describe("copy and DTOs", () => {
  const base = (over: Row = {}) =>
    toApprovalRow({ id: "a1", tenantId: T, assistantKey: "ads_optimizer", pot: "ads", actionKind: "raise_budget", direction: "raise", intent: {}, fingerprint: "f", summary: "Raise it", reason: "cost per lead is ₹62, well below your ₹100 target", forecastTodayMinor: 175_000n, forecastMonthMinor: 455_000n, currency: "INR", status: "pending", tokenHash: "h", expiresAt: new Date(NOW.getTime() + 11 * HOUR + 59 * 60_000), createdAt: new Date(NOW.getTime() - HOUR), correlationId: "c", ...over });

  it("formats the card text the Spending page shows", () => {
    const dto = toApprovalDTO(base(), { now: NOW, viewer: { userId: "u", role: "admin", approver: false } });
    expect(dto).toMatchObject({ reason: "Why: cost per lead is ₹62, well below your ₹100 target", forecastText: "Could add up to ₹4,550 this month (worst case)", expiryText: "Declined automatically in 11 hours", canApprove: false, canDecline: true });
    expect(toApprovalDTO(base({ direction: "lower", forecastMonthMinor: null }), { now: NOW, viewer: { userId: "u", role: "admin", approver: false } })).toMatchObject({ canApprove: true, forecastText: null });
    expect(toApprovalDTO(base(), { now: NOW, viewer: null })).toMatchObject({ canApprove: false, canDecline: false });
  });

  it("says what happened to a request, in plain words", () => {
    expect(statusLine(base({ expiresAt: new Date(NOW.getTime() + 20 * 60_000) }), NOW)).toBe("Declined automatically in 20 minutes");
    expect(statusLine(base({ createdAt: new Date(NOW.getTime() - 12 * HOUR - 1), expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe("Declined automatically (no answer in 12 hours).");
    expect(displayStatus(base({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe("expired");
    expect(statusLine(base({ status: "declined" }), NOW)).toBe("Declined. Nothing was changed.");
    expect(expiredText(1)).toBe("Declined automatically (no answer in 1 hour).");
  });

  it("turns a refusal into the stored failure sentence", () => {
    expect(noLongerFitsText({ minor: 5_000n, currency: "INR" }, { minor: 17_500n, currency: "INR" })).toBe("No longer fits your limits: ₹50 left, needs ₹175");
    expect(failureText(new SpendBlockedError("spend.daily_limit", { left: { minor: 5_000n, currency: "INR" }, needs: { minor: 17_500n, currency: "INR" } }))).toBe("No longer fits your limits: ₹50 left, needs ₹175");
    expect(failureText(new SpendBlockedError("spend.frozen"))).toMatch(/^Spending is stopped/);
    expect(failureText(new Error("socket hang up"))).toBe("It could not be applied, so nothing was changed. Try again later.");
  });

  it("reads an intent back from JSON exactly (amounts and dates)", () => {
    expect(parseAdsIntent({ kind: "raise_budget", adSetId: "s", metaAdSetId: "m", toMinor: "110000" })).toEqual({ kind: "raise_budget", adSetId: "s", metaAdSetId: "m", toMinor: 110_000n });
    expect(parseAdsIntent({ kind: "activate", campaignId: "c", sets: [{ adSetId: "s", metaAdSetId: "m", dailyBudgetMinor: "5", endsAt: "2026-11-15T00:00:00.000Z" }] })).toEqual({ kind: "activate", campaignId: "c", sets: [{ adSetId: "s", metaAdSetId: "m", dailyBudgetMinor: 5n, endsAt: new Date("2026-11-15T00:00:00.000Z") }] });
    expect(parseAdsIntent({ kind: "create_live" })).toBeNull();
    expect(parseAdsIntent({ kind: "raise_budget", adSetId: "s" })).toBeNull();
  });
});
