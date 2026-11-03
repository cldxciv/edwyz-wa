/**
 * Failed sends, grouped by WhatsApp error code (docs/EDDY-SPEC.md 6.7, D14).
 *
 * The scan window is today and yesterday in the workspace's time zone (SpendControl.timezone, read only; Asia/Kolkata when
 * there is none), so a failure that arrives after midnight still counts on its message's day. Groups:
 * - a broadcast's failures, for admins: `failures:<broadcastId>:<code>`, [Open broadcast];
 * - a member's own sends (sentByUserId), for that member: `failures:<day>:<code>:u:<userId>`;
 * - automatic sends, for admins: `failures:<day>:<code>`.
 * The fix depends on the code: 131047 [Pick a template] (opens that chat's template picker in the inbox; only when one chat
 * failed), 131026 "this number isn't on WhatsApp", 131049 "Meta held it back to protect engagement; try later", anything
 * else [Explain] (Eddy reads the error through a tool). Counts update in place; the payload is the code, the count, the day
 * and ids only, never the message body.
 */
import { prisma } from "@/lib/db";
import { dayKey, startOfLocalDay, addDays } from "@/lib/spend/periods";
import { EXPLAINED_CODES, act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

const DEFAULT_TZ = "Asia/Kolkata";
/** The pre-check's window: the start of yesterday is at most 48 hours back in any time zone. */
const DUE_LOOKBACK_MS = 49 * 60 * 60_000;
/** Messages read per scan (the newest are kept when there are more). */
const MAX_ROWS = 5000;
const CODE = /^[A-Za-z0-9_.-]{1,24}$/;

type FailedRow = { id: string; errorCode: string | null; sentByUserId: string | null; conversationId: string; createdAt: Date };

type Group = { key: string; code: string; day: string | null; broadcastId: string | null; userId: string | null; count: number; conversations: Set<string> };

export async function workspaceTimezone(tenantId: string): Promise<string> {
  const row = (await prisma.spendControl.findUnique({ where: { tenantId }, select: { timezone: true } })) as { timezone?: string } | null;
  return row?.timezone || DEFAULT_TZ;
}

export const producer: NoticeProducer = {
  name: "failures",
  kinds: ["failed_sends"],
  numberBased: true,
  /** Workspaces with a failed outbound message in the window. */
  async due(tenantIds, now) {
    const rows = await prisma.message.groupBy({ by: ["tenantId"], where: { tenantId: { in: [...tenantIds] }, direction: "outbound", status: "failed", createdAt: { gte: new Date(now.getTime() - DUE_LOOKBACK_MS) } } });
    return rows.map((r) => r.tenantId);
  },
  async run(ctx) {
    const tz = await workspaceTimezone(ctx.tenantId);
    const today = dayKey(ctx.now, tz);
    const since = startOfLocalDay(addDays(today, -1), tz);
    const rows = (await prisma.message.findMany({
      where: { tenantId: ctx.tenantId, direction: "outbound", status: "failed", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: { id: true, errorCode: true, sentByUserId: true, conversationId: true, createdAt: true },
    })) as FailedRow[];
    if (rows.length === 0) return { published: 0 };
    const recipients = (await prisma.broadcastRecipient.findMany({ where: { tenantId: ctx.tenantId, messageId: { in: rows.map((r) => r.id) } }, select: { messageId: true, broadcastId: true } })) as { messageId: string | null; broadcastId: string }[];
    const broadcastOf = new Map(recipients.filter((r) => r.messageId).map((r) => [r.messageId as string, r.broadcastId]));

    const groups = new Map<string, Group>();
    for (const m of rows) {
      const code = m.errorCode && CODE.test(m.errorCode) ? m.errorCode : "unknown";
      const broadcastId = broadcastOf.get(m.id) ?? null;
      const day = dayKey(m.createdAt, tz);
      const userId = broadcastId ? null : m.sentByUserId;
      const key = broadcastId ? dedupe.failures({ broadcastId }, code) : dedupe.failures({ day, userId }, code);
      const g = groups.get(key) ?? { key, code, day: broadcastId ? null : day, broadcastId, userId, count: 0, conversations: new Set<string>() };
      g.count++;
      g.conversations.add(m.conversationId);
      groups.set(key, g);
    }

    let published = 0;
    for (const g of groups.values()) {
      const oneChat = g.conversations.size === 1 ? [...g.conversations][0] : null;
      const actions = [];
      if (g.broadcastId) actions.push(act.go(`/app/broadcasts/${g.broadcastId}`, "btn.open_broadcast"));
      if (g.code === "131047" && !g.broadcastId) actions.push(act.go(oneChat ? `/app/inbox?c=${oneChat}` : "/app/inbox", oneChat ? "btn.pick_template" : "btn.open"));
      if (!EXPLAINED_CODES.has(g.code)) actions.push(act.askEddy("btn.explain"));
      const r = await ctx.publish({
        kind: "failed_sends",
        severity: g.code === "131047" && g.userId ? "action_needed" : "heads_up",
        dedupeKey: g.key,
        audience: g.userId ? { userId: g.userId, minRole: "agent" } : { minRole: "admin" },
        subjectType: g.broadcastId ? "broadcast" : oneChat ? "conversation" : null,
        subjectId: g.broadcastId ?? oneChat,
        payload: { code: g.code, day: g.day, broadcastId: g.broadcastId, conversationId: oneChat },
        count: g.count,
        actions,
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    return { published };
  },
};
