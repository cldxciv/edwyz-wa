/**
 * Approvals waiting (docs/EDDY-SPEC.md 6.7): "{count} requests are waiting for you." [Review]. One notice per person who can
 * decide (`approvals:<userId>`), so a request only reaches the people who can act on it (Phase 0's role table):
 * - Phase 0 pending SpendApproval rows (status pending, not expired). A raise can be decided by the owner or an admin named
 *   in SpendControl.approverUserIds (SPEND 7.3); a lowering by any admin. Read only.
 * - Client approval links that came back asking for changes in the last 7 days (ApprovalRequest status changes_requested):
 *   the creator or an admin has to act, so admins and the owner see them.
 * - Optimizer proposals waiting (OptimizerProposal status proposed): admins and the owner.
 * The notice resolves when nothing is waiting for that person any more. Phase 0's own per-request rows
 * (`approval_waiting`) are hidden for a member who has this summary (kinds.ts supersededSpendRow).
 */
import { prisma } from "@/lib/db";
import { act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

const CLIENT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export type ApprovalCounts = { spend: number; client: number; optimizer: number };

/** Where [Review] goes: the first kind of request that is waiting. */
export function reviewPath(c: ApprovalCounts): string {
  if (c.spend > 0) return "/app/settings/spending";
  if (c.optimizer > 0) return "/app/ads/optimizer";
  return "/app/creative";
}

export const producer: NoticeProducer = {
  name: "approvals",
  kinds: ["approvals_waiting"],
  async run(ctx) {
    const { tenantId, now } = ctx;
    const [members, control, spend, optimizer, client] = await Promise.all([
      prisma.membership.findMany({ where: { tenantId, role: { in: ["owner", "admin"] } }, select: { userId: true, role: true } }) as Promise<{ userId: string; role: string }[]>,
      prisma.spendControl.findUnique({ where: { tenantId }, select: { approverUserIds: true } }) as Promise<{ approverUserIds: string[] } | null>,
      prisma.spendApproval.findMany({ where: { tenantId, status: "pending", expiresAt: { gt: now } }, select: { id: true, direction: true }, take: 500 }) as Promise<{ id: string; direction: string }[]>,
      prisma.optimizerProposal.count({ where: { tenantId, status: "proposed" } }) as Promise<number>,
      prisma.approvalRequest.count({ where: { tenantId, status: "changes_requested", decidedAt: { gte: new Date(now.getTime() - CLIENT_LOOKBACK_MS) } } }) as Promise<number>,
    ]);
    const approvers = new Set(control?.approverUserIds ?? []);
    const keep: string[] = [];
    let published = 0;
    for (const m of members) {
      const canRaise = m.role === "owner" || approvers.has(m.userId);
      const counts: ApprovalCounts = { spend: spend.filter((a) => a.direction === "lower" || canRaise).length, client, optimizer };
      const total = counts.spend + counts.client + counts.optimizer;
      if (total === 0) continue;
      const key = dedupe.approvals(m.userId);
      keep.push(key);
      const r = await ctx.publish({
        kind: "approvals_waiting",
        severity: "action_needed",
        dedupeKey: key,
        audience: { userId: m.userId, minRole: "admin" },
        subjectType: "user",
        subjectId: m.userId,
        payload: { userId: m.userId, spend: counts.spend, client: counts.client, optimizer: counts.optimizer },
        count: total,
        actions: [act.go(reviewPath(counts), "btn.review")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const resolved = await ctx.resolve({ kinds: ["approvals_waiting"], except: keep });
    return { published, resolved };
  },
};
