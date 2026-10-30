import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { queueEmail } from "@/lib/email";
import { notifySpend } from "@/lib/spend/notify";
import type { SpendNoticeKind } from "@/lib/spend/types";
import { PAUSE_COPY, SPEND_PAUSE_REASONS, type PauseReasonCode } from "./pause-copy";

/** The spend notice kind of each spend pause reason (the in-app notice the owner sees, docs/SPEND-CONTROLS-SPEC.md 7.4). */
const NOTICE_KIND: Partial<Record<PauseReasonCode, SpendNoticeKind>> = {
  messaging_limit: "limit_reached",
  spending_stopped: "spending_stopped",
  number_quality_yellow: "breaker_tripped",
};

/**
 * Tells the workspace that a broadcast stopped by itself. Owners and admins are emailed (when email works). A pause that comes
 * from the spending controls also goes to the owner as an in-app notice, because there is no email in production (12.1a
 * decision 2) and the owner is the one who can raise the limit or turn spending back on. Never throws: a failed notice must
 * not stop sending logic.
 */
export async function notifyBroadcastPaused(tenantId: string, broadcast: { id: string; name: string }, reason: PauseReasonCode, at: Date = new Date()): Promise<void> {
  const copy = PAUSE_COPY[reason];
  const link = `/app/broadcasts/${broadcast.id}`;
  if (SPEND_PAUSE_REASONS.has(reason)) {
    await notifySpend({
      tenantId,
      kind: NOTICE_KIND[reason] ?? "breaker_tripped",
      severity: "action_needed",
      audience: "owner",
      // One notice per broadcast, reason and pause (the minute keeps a later pause for the same reason from being swallowed).
      dedupeKey: `broadcast-paused:${broadcast.id}:${reason}:${at.toISOString().slice(0, 16)}`,
      title: `${copy.title}: ${broadcast.name}`,
      body: copy.body,
      link,
      subjectType: "broadcast",
      subjectId: broadcast.id,
    });
  }
  try {
    const members = await prisma.membership.findMany({ where: { tenantId, role: { in: ["owner", "admin"] } }, select: { user: { select: { email: true, disabledAt: true } } }, take: 20 });
    const url = `${siteUrl()}${link}`;
    for (const m of members) {
      if (!m.user?.email || m.user.disabledAt) continue;
      await queueEmail({ to: m.user.email, subject: `Broadcast paused: ${broadcast.name}`, text: `${copy.title}\n\n${copy.body}\n\nOpen the broadcast: ${url}\n` });
    }
  } catch {
    console.error("[broadcast] could not email the workspace admins about a pause");
  }
}
