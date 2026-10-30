/**
 * The spend bridge (docs/EDDY-SPEC.md 4.10, EDDY-06): the only file of the action layer, and the only Eddy-layer file besides the
 * streaming gateway (src/lib/spend/exec/ai-stream.ts), that imports src/lib/spend/*. It never writes spend tables itself
 * (Phase 0 rule B7): every change goes through Phase 0's own functions, and it never builds a user actor (rule B14: only
 * invoke.ts does; the acting functions here take the member's SpendUserActor invoke.ts built and pass it on unchanged).
 *
 * Reads (EDDY-10, EDDY-11):
 * - aiHeadroom(): Phase 0 headroom('ai') in credits, today and this month, with the reset dates in the workspace's zone;
 * - freezeState(): the workspace and platform freeze (kill.ts spendState, the 5 s cache unless `fresh`);
 * - isDemoWorkspace(): the demo workspace (spend/demo.ts: a demo Meta asset or the seeded demo WABA);
 * - eddyGatewayFreezeCode(): the refusal the AI gateway would give feature `eddy` under the current freeze (rule E7 says
 *   none: a person asked, so Eddy keeps chatting under "Stop all spending"; status keeps the defensive `paused` mapping);
 * - modelPrice(): the 5.1 price table (ai-pricing.ts with EDDY_PRICES applied), for the worst-case hold of 5.10;
 * - isAiConfigured(), workspaceTimezone(), localDayStart().
 *
 * The v1 front desk (EDDY-06; reads and lowering only):
 * - summary(): the GET /api/spend/summary DTO for the member's role (src/lib/spend/summary.ts); owners and admins also get
 *   the last 10 activity rows, team members never get ledger rows;
 * - stopSpending(): the kill switch ON through kill.ts with the member's actor, inline pause and the spend.stop job, exactly
 *   as the Spending page does; it works while frozen and in a locked workspace, and never loosens a stricter stop. Turning
 *   spending back on stays an owner-only deep link (money_controls);
 * - listApprovals() / declineApproval(): Phase 0 SpendApproval requests for the people who may decide them, and Phase 0's
 *   decide path (via 'app'), with its approver re-check and one conditional update. Approving is never offered in v1.
 * The heavy Phase 0 modules load on first use, so the notices scan and the status read stay light.
 */
import type { AiAllowanceSummary, SpendBridgePort } from "@/lib/actions/types";
import { getControl } from "@/lib/spend/control";
import { headroom } from "@/lib/spend/book";
import { isDemoWorkspace as demoWorkspace } from "@/lib/spend/demo";
import { aiFreezeRefusal, isAiConfigured as aiKeyConfigured } from "@/lib/spend/exec/ai";
import { aiPrices, priceFor } from "@/lib/spend/exec/ai-pricing";
import { spendState } from "@/lib/spend/kill";
import { DEFAULT_TIMEZONE, dayKey, nextLocalMidnight, nextLocalMonthStart, startOfLocalDay } from "@/lib/spend/periods";
import type { ApprovalDTO, FreezeLevel, FreezeState, LedgerRowDTO, SpendActor, SpendSummaryDTO, SpendUserActor, StopResultDTO } from "@/lib/spend/types";

/** The AI pot in credits as Eddy shows and meters it. Null limit or left: not set. */
export type AiHeadroom = {
  usedToday: number;
  limitToday: number | null;
  usedMonth: number;
  limitMonth: number | null;
  leftToday: number | null;
  leftMonth: number | null;
  /** Local dates (YYYY-MM-DD) the day and the month reset. */
  todayResetsOn: string;
  monthResetsOn: string;
  timezone: string;
};

const credits = (v: bigint | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** The workspace's time zone for AI periods (SpendControl.timezone). */
export async function workspaceTimezone(tenantId: string): Promise<string> {
  try {
    return (await getControl(tenantId, { prune: false })).timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The first instant of the local day holding `now`, in the zone. */
export function localDayStart(now: Date, timeZone: string): Date {
  return startOfLocalDay(dayKey(now, timeZone), timeZone);
}

/** Phase 0 headroom('ai') in credits (5.10, 5.11): spent plus held is used; left is null when no limit is set. */
export async function aiHeadroom(tenantId: string, opts: { now?: Date; fresh?: boolean } = {}): Promise<AiHeadroom> {
  const now = opts.now ?? new Date();
  const [h, timezone] = await Promise.all([headroom(tenantId, "ai", { now, fresh: opts.fresh === true }), workspaceTimezone(tenantId)]);
  return {
    usedToday: Number(h.today.spent + h.today.held),
    limitToday: credits(h.limits.daily),
    usedMonth: Number(h.month.spent + h.month.held),
    limitMonth: credits(h.limits.monthly),
    leftToday: credits(h.today.left),
    leftMonth: credits(h.month.left),
    todayResetsOn: dayKey(nextLocalMidnight(now, timezone), timezone),
    monthResetsOn: dayKey(nextLocalMonthStart(now, timezone), timezone),
    timezone,
  };
}

/** SpendBridgePort.aiAllowance: the status view (credits; null limit = not set). */
export async function aiAllowance(tenantId: string): Promise<AiAllowanceSummary> {
  const h = await aiHeadroom(tenantId);
  const monthUsed = h.leftMonth !== null && h.leftMonth <= 0;
  const dayUsed = h.leftToday !== null && h.leftToday <= 0;
  return { usedToday: h.usedToday, limitToday: h.limitToday, usedMonth: h.usedMonth, limitMonth: h.limitMonth, resetsOn: monthUsed ? h.monthResetsOn : dayUsed ? h.todayResetsOn : null };
}

/** The workspace and platform freeze (Phase 0 4.11). */
export async function freezeState(tenantId: string, opts: { fresh?: boolean } = {}): Promise<FreezeState> {
  return spendState(tenantId, { fresh: opts.fresh === true });
}

/** The demo workspace (6.14): every callsMeta action is refused, and nothing is sent to Meta or customers. */
export async function isDemoWorkspace(tenantId: string): Promise<boolean> {
  return demoWorkspace(tenantId);
}

/** Who the status check asks about: a person's request, never an assistant (no user actor is built here, B14). */
const EDDY_STATUS_ACTOR: SpendActor = Object.freeze({ type: "system", job: "eddy.status" }) as SpendActor;

/** The code the AI gateway would refuse feature `eddy` with under the current freeze, or null (rule E7: normally null). */
export async function eddyGatewayFreezeCode(tenantId: string): Promise<string | null> {
  return aiFreezeRefusal(await spendState(tenantId), "eddy", EDDY_STATUS_ACTOR);
}

/** An API key is configured (no network call). */
export function isAiConfigured(): boolean {
  return aiKeyConfigured();
}

export type ModelPrices = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

/** A model's prices (5.1, EDDY_PRICES applied), or null when the model is not priced. */
export function modelPrice(model: string): ModelPrices | null {
  const p = priceFor(model, aiPrices());
  return p ? { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite5m: p.cacheWrite5m, cacheWrite1h: p.cacheWrite1h } : null;
}

export type SafetyStop = { kind: string; label: string; scopeType: string; since: string };

/** get_workspace_status (4.6): the open safety stops, by Phase 0's plain label, newest first (at most 10). Read only. */
export async function openSafetyStops(tenantId: string, opts: { now?: Date } = {}): Promise<SafetyStop[]> {
  const [{ listBreakers }, { BREAKER_LABELS }] = await Promise.all([import("@/lib/spend/breakers/state"), import("@/lib/spend/summary")]);
  const rows = await listBreakers(tenantId, { now: opts.now, limit: 50 });
  return rows.slice(0, 10).map((r) => ({ kind: String(r.kind), label: BREAKER_LABELS[String(r.kind)] ?? "Safety stop", scopeType: r.scopeType, since: r.trippedAt.toISOString() }));
}

/** The read-only part of SpendBridgePort. */
export const SPEND_BRIDGE_READS: Pick<SpendBridgePort, "freezeState" | "isDemoWorkspace" | "aiAllowance"> = {
  freezeState,
  isDemoWorkspace,
  aiAllowance,
};

// =====================================================================================================================
// The v1 front desk (EDDY-06)
// =====================================================================================================================

type MemberActor = SpendUserActor & { tenantId: string };

/** The Phase 0 actor without the workspace id: the same object invoke.ts built, minus the key the bridge needed. */
function phase0Actor(actor: MemberActor): SpendUserActor {
  const { tenantId: _tenantId, ...rest } = actor;
  return rest;
}

const asSessionActor = (actor: MemberActor) => ({ userId: actor.userId, tenantId: actor.tenantId, role: actor.role });

/** The summary plus, for owners and admins, the 10 newest activity rows (one per decision). Team members get no ledger rows. */
export type BridgeSummary = SpendSummaryDTO & { recentActivity?: LedgerRowDTO[] };

/** get_spending (4.10): what GET /api/spend/summary returns for this member's role. */
export async function summary(actor: MemberActor): Promise<BridgeSummary> {
  const { listActivity, spendSummary } = await import("@/lib/spend/summary");
  const view = await spendSummary(asSessionActor(actor));
  if (actor.role === "agent") return view;
  const activity = await listActivity(asSessionActor(actor), { limit: 10 }).catch(() => null);
  return { ...view, recentActivity: activity?.rows ?? [] };
}

const RANK: Record<FreezeLevel, number> = { none: 0, assistants: 1, all: 2 };
export const ALREADY_STOPPED = "Spending is already stopped. Only the owner can turn it back on, on the Spending limits page.";
export const ASSISTANTS_ALREADY_STOPPED = "Assistants are already stopped. Only the owner can turn them back on, on the Spending limits page.";

/**
 * stop_spending (4.6, 4.10): the kill switch ON with the member's actor, through kill.ts, with the inline pause the Spending
 * page uses (20 s budget) and the spend.stop job for the rest. A level at or below the current stop changes nothing, so
 * Eddy can never loosen a stricter stop. kill.ts refuses a team member (403, ledgered).
 */
export async function stopSpending(actor: MemberActor, level: "assistants" | "all", reason: string): Promise<StopResultDTO> {
  if (level !== "assistants" && level !== "all") throw new RangeError("stopSpending needs assistants or all.");
  const current = await spendState(actor.tenantId, { fresh: true });
  if (RANK[current.workspace] >= RANK[level]) {
    return { level: current.workspace, paused: 0, total: 0, pending: 0, failed: 0, text: current.workspace === "all" ? ALREADY_STOPPED : ASSISTANTS_ALREADY_STOPPED };
  }
  const [{ setWorkspaceFreeze }, { stopInline }] = await Promise.all([import("@/lib/spend/kill"), import("@/lib/spend/tasks/adsguard")]);
  const result = await setWorkspaceFreeze(actor.tenantId, level, phase0Actor(actor), reason, { inline: stopInline });
  return { level: result.level, paused: result.paused, total: result.total, pending: result.pending, failed: result.failed, text: result.text };
}

/** list_approvals (4.10a item 7): the requests waiting, for the owner and admins; team members decide none, so they get none. */
export async function listApprovals(actor: MemberActor): Promise<ApprovalDTO[]> {
  if (actor.role === "agent") return [];
  const { listApprovals: list } = await import("@/lib/spend/approvals");
  return list(actor.tenantId, { userId: actor.userId, role: actor.role }, { status: "pending" });
}

/** decline_spend_request (4.10a item 7): Phase 0's decide path via 'app', so its re-check and conditional update apply. */
export async function declineApproval(actor: MemberActor, approvalId: string): Promise<ApprovalDTO> {
  const { decideApproval } = await import("@/lib/spend/approvals");
  return (await decideApproval(actor.tenantId, approvalId, "decline", "app", phase0Actor(actor))).approval;
}

/** G16 (v2): the owner or a named approver. */
export async function isApprover(tenantId: string, userId: string): Promise<boolean> {
  const { isApprover: approver } = await import("@/lib/spend/approvals");
  return approver(tenantId, userId);
}

/** "Only {names} can confirm spending that Eddy prepares." The owner first, then the named approvers, by first name. */
export async function approverNames(tenantId: string): Promise<string[]> {
  const { prisma } = await import("@/lib/db");
  const control = await getControl(tenantId, { prune: false });
  const members = (await prisma.membership.findMany({
    where: { tenantId, OR: [{ role: "owner" }, { role: "admin", userId: { in: control.approverUserIds } }] },
    select: { role: true, user: { select: { name: true } } },
    take: 10,
  })) as { role: string; user: { name: string | null } | null }[];
  return members
    .sort((a, b) => (a.role === "owner" ? -1 : 0) - (b.role === "owner" ? -1 : 0))
    .map((m) => (m.user?.name ?? "").trim().split(/\s+/)[0])
    .filter((n) => n.length > 0)
    .slice(0, 5);
}

/** v2 spending actions are not wired in v1 (4.10a item 9): G2 refuses them with not_yet. */
export async function eddyAssistantReady(): Promise<boolean> {
  return false;
}

/** The one implementation of SpendBridgePort; invoke.ts loads it as its default bridge on first use. */
export const SPEND_BRIDGE: SpendBridgePort = Object.freeze({
  eddyAssistantReady,
  freezeState,
  isApprover,
  approverNames,
  isDemoWorkspace,
  aiAllowance,
  summary,
  stopSpending,
  listApprovals,
  declineApproval,
});
