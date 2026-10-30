import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { teamPoolUserIds } from "@/lib/teams/pool";
import { isWithinWorkingHours, pickAgent } from "./config";
import { tenantsWithExtra } from "./extra";
import { getSettings, loadCandidates, onConversationAssigned } from "./index";

const HOUR_MS = 3_600_000;
const PER_TENANT_LIMIT = 50;
const AUTO_ACTIONS = new Set(["routing.auto_assign", "routing.auto_reassign"]);
const TRACKED_ACTIONS = ["routing.auto_assign", "routing.auto_reassign", "routing.assign", "routing.unassign", "routing.team_assign"];
/** The audit row is written just after the assignment, so allow a little clock difference. */
const SLACK_MS = 10_000;

type Waiting = { id: string; assignedToId: string | null; assignedAt: Date | null; lastInboundAt: Date | null; lastAgentReplyAt: Date | null; teamId: string | null };
export type AuditRow = { target: string | null; action: string; createdAt: Date; meta: unknown };

/** Pure. The moment the customer started waiting on the current person: the later of the assignment and the customer's last message. */
export function waitingSince(c: Pick<Waiting, "assignedAt" | "lastInboundAt">): Date | null {
  if (!c.assignedAt || !c.lastInboundAt) return null;
  return new Date(Math.max(c.assignedAt.getTime(), c.lastInboundAt.getTime()));
}

/** Pure. Only chats the system handed out are moved; a chat someone gave to a named person stays put. */
export function wasAutoAssigned(assignedAt: Date | null, audits: AuditRow[]): boolean {
  const latest = audits.filter((a) => TRACKED_ACTIONS.includes(a.action)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return !!latest && !!assignedAt && AUTO_ACTIONS.has(latest.action) && latest.createdAt.getTime() >= assignedAt.getTime() - SLACK_MS;
}

/**
 * Pure. How many times the chat has been moved since a person last answered the customer, and who has already had it. A customer
 * who keeps writing does not reset this: only a human reply ends the run, so a chat cannot bounce between the same people forever.
 */
export function triedBefore(audits: AuditRow[], since: Date): { count: number; people: Set<string> } {
  const people = new Set<string>();
  let count = 0;
  for (const a of audits) {
    if (a.action !== "routing.auto_reassign" || a.createdAt < since) continue;
    count += 1;
    const meta = (a.meta ?? {}) as Record<string, unknown>;
    for (const k of ["from", "to"]) if (typeof meta[k] === "string") people.add(meta[k] as string);
  }
  return { count, people };
}

async function humanRepliedSince(tenantId: string, conversationId: string, since: Date): Promise<boolean> {
  const reply = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "outbound", sentByUserId: { not: null }, createdAt: { gt: since } },
    select: { id: true },
  });
  return reply !== null;
}

async function moveOne(tenantId: string, conv: Waiting, audits: AuditRow[], minutes: number, maxMoves: number, now: Date): Promise<boolean> {
  const since = waitingSince(conv);
  if (!since || !conv.assignedToId || !wasAutoAssigned(conv.assignedAt, audits)) return false;
  if (conv.lastAgentReplyAt && conv.lastAgentReplyAt >= since) return false;
  if (await humanRepliedSince(tenantId, conv.id, since)) return false;
  const history = triedBefore(audits, conv.lastAgentReplyAt ?? new Date(0));
  if (history.count >= maxMoves) return false;

  const [config, candidates, poolIds] = await Promise.all([getSettings(tenantId), loadCandidates(tenantId), teamPoolUserIds(tenantId, conv.teamId)]);
  const pool = candidates.filter((c) => (!poolIds || poolIds.includes(c.userId)) && c.userId !== conv.assignedToId && !history.people.has(c.userId));
  const next = pickAgent(pool, config.mode, config.maxOpenPerAgent);
  if (!next) return false;

  const res = await prisma.conversation.updateMany({
    where: { id: conv.id, tenantId, assignedToId: conv.assignedToId, assignedAt: conv.assignedAt },
    data: { assignedToId: next, assignedAt: now },
  });
  if (res.count === 0) return false;
  await prisma.agentAvailability.upsert({ where: { tenantId_userId: { tenantId, userId: next } }, create: { tenantId, userId: next, lastAssignedAt: now }, update: { lastAssignedAt: now } });
  await audit({ tenantId, action: "routing.auto_reassign", target: conv.id, meta: { from: conv.assignedToId, to: next, waitedMinutes: Math.round((now.getTime() - since.getTime()) / 60_000), limitMinutes: minutes } });
  await onConversationAssigned(tenantId, conv.id, next);
  return true;
}

/**
 * Moves a chat to the next available person when the one it was automatically given to has not answered the customer for the
 * configured number of minutes. Only runs inside working hours, and only for customers who wrote within the last 24 hours.
 */
export async function sweepNoResponse(now = new Date()): Promise<number> {
  let moved = 0;
  for (const { tenantId, extra } of await tenantsWithExtra()) {
    const { enabled, minutes, maxMoves } = extra.autoReassign;
    if (!enabled) continue;
    const config = await getSettings(tenantId);
    const cutoff = new Date(now.getTime() - minutes * 60_000);
    if (!isWithinWorkingHours(config, now) || !isWithinWorkingHours(config, cutoff)) continue;

    const waiting: Waiting[] = await prisma.conversation.findMany({
      where: {
        tenantId,
        assignedToId: { not: null },
        status: { in: ["open", "pending"] },
        assignedAt: { not: null, lt: cutoff },
        lastInboundAt: { not: null, lt: cutoff, gte: new Date(now.getTime() - 24 * HOUR_MS) },
      },
      orderBy: { lastInboundAt: "asc" },
      take: PER_TENANT_LIMIT,
      select: { id: true, assignedToId: true, assignedAt: true, lastInboundAt: true, lastAgentReplyAt: true, teamId: true },
    });
    if (waiting.length === 0) continue;
    const audits: AuditRow[] = await prisma.auditLog.findMany({
      where: { tenantId, target: { in: waiting.map((w) => w.id) }, action: { in: [...TRACKED_ACTIONS] }, createdAt: { gte: new Date(now.getTime() - 48 * HOUR_MS) } },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: { target: true, action: true, createdAt: true, meta: true },
    });
    for (const conv of waiting) {
      const own = audits.filter((a) => a.target === conv.id);
      if (await moveOne(tenantId, conv, own, minutes, maxMoves, now).catch(() => false)) moved += 1;
    }
  }
  return moved;
}
