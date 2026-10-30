import { prisma } from "@/lib/db";
import { csvStream, pageArgs } from "@/lib/reports/export";
import { audit } from "@/lib/auth/audit";
import { type Actor } from "@/lib/tenancy";
import { errorCodeText } from "./errors";
import { ownedBroadcast } from "./service";

const REPORT_HEADERS = ["phone", "name", "username", "bsuid", "status", "failure_code", "failure_reason", "attempts", "sent_at", "delivered_at", "read_at", "retry_after"];
const STATUS_TEXT: Record<string, string> = { pending: "waiting", queued: "sending", skipped: "not sent" };

/** Streams one row per person for a broadcast: what happened and why, for the owner to keep or fix. Optionally only the ones that did not get it. */
export async function broadcastReportCsv(actor: Actor, id: string, only: "all" | "problems" = "all") {
  const broadcast = await ownedBroadcast(actor, id);
  const where = { tenantId: actor.tenantId, broadcastId: broadcast.id, ...(only === "problems" ? { status: { in: ["failed" as const, "skipped" as const] } } : {}) };
  const stream = csvStream({
    headers: REPORT_HEADERS,
    fetchPage: (cursor, take) => prisma.broadcastRecipient.findMany({ where, include: { contact: { select: { phone: true, name: true, username: true, bsuid: true } } }, ...pageArgs(cursor, take) }),
    toRow: (r) => [
      r.contact.phone,
      r.contact.name,
      r.contact.username,
      r.contact.bsuid,
      STATUS_TEXT[r.status] ?? r.status,
      r.errorCode,
      errorCodeText(r.errorCode),
      r.attempts,
      r.sentAt,
      r.deliveredAt,
      r.readAt,
      r.retryAfter,
    ],
    onDone: (rows, truncated) => audit({ tenantId: actor.tenantId, userId: actor.userId, action: "export.broadcast_report", target: broadcast.id, meta: { rows, truncated, only } }),
  });
  const safeName = broadcast.name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "broadcast";
  return { stream, filename: `${safeName}-report.csv` };
}
