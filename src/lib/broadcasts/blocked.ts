import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { notifyBroadcastPaused } from "./notify";
import { type PauseReasonCode, storePauseReason } from "./pause";

/**
 * Meta's codes for a template that is paused (132015) or disabled (132016) because of low quality, or that no longer exists
 * (132001: deleted or archived in WhatsApp Manager). Each stops the broadcast instead of failing everyone left.
 */
export const TEMPLATE_BLOCK_CODES = new Set(["132001", "132015", "132016"]);
export const isTemplateBlockCode = (code: string | null | undefined) => TEMPLATE_BLOCK_CODES.has((code ?? "").trim());
/** 132001: the template is gone at Meta, so it is turned off rather than paused (it will not come back). */
export const TEMPLATE_GONE_CODE = "132001";
const markFor = (code: string | null | undefined): "paused" | "disabled" => ((code ?? "").trim() === TEMPLATE_GONE_CODE ? "disabled" : "paused");

export const TENANT_BLOCKED = "tenant_blocked";

type Ref = { id: string; tenantId: string; name?: string };

/**
 * The system stops a broadcast that is scheduled or sending and records why: nothing is sent and no recipient is touched
 * (pending stays pending, so nothing is lost). A person resumes it with the normal start action once the cause is fixed.
 * Idempotent: only a scheduled or sending broadcast is moved, so the reason is stored and the admins emailed once.
 */
export async function pauseWithReason(b: Ref, reason: PauseReasonCode, notify: boolean): Promise<void> {
  const { count } = await prisma.broadcast.updateMany({ where: { id: b.id, tenantId: b.tenantId, status: { in: ["scheduled", "sending"] } }, data: { status: "paused" } });
  if (count === 0) return;
  await storePauseReason(b.id, reason);
  await audit({ tenantId: b.tenantId, action: `broadcast.paused_${reason}`, target: b.id });
  if (notify) await notifyBroadcastPaused(b.tenantId, { id: b.id, name: b.name ?? "Your broadcast" }, reason);
}

/**
 * Marks the template paused (when asked; disabled when Meta said it no longer exists, `errorCode` 132001) and pauses the broadcast
 * with the template reason.
 */
export async function pauseForBlockedTemplate(b: Ref & { templateId?: string }, markTemplate: boolean, reason: PauseReasonCode = "template_paused", errorCode?: string | null): Promise<void> {
  if (markTemplate && b.templateId) {
    const status = markFor(errorCode);
    const from = status === "disabled" ? { in: ["approved" as const, "flagged" as const, "paused" as const] } : ("approved" as const);
    await prisma.template.updateMany({ where: { id: b.templateId, tenantId: b.tenantId, status: from }, data: { status } }).catch(() => undefined);
  }
  await pauseWithReason(b, reason, true);
}

/**
 * Pauses every scheduled or sending broadcast that uses this template, so a paused, disabled or low-quality template stops
 * campaigns the moment Meta says so rather than when the worker next runs. Returns how many were paused.
 */
export async function pauseBroadcastsForTemplate(tenantId: string, templateId: string, reason: PauseReasonCode): Promise<number> {
  const rows = await prisma.broadcast.findMany({ where: { tenantId, templateId, status: { in: ["scheduled", "sending"] } }, select: { id: true, name: true }, take: 200 });
  for (const b of rows) await pauseWithReason({ id: b.id, tenantId, name: b.name }, reason, true);
  return rows.length;
}

const OPEN = ["scheduled", "sending", "paused"];

/**
 * A delivery status of 132001, 132015 or 132016 for a recipient that already has a message id (the status webhook arrived after the send was accepted).
 * Same outcome as a refusal at send time: while the broadcast is still open the person goes back to pending and the broadcast is paused with
 * the template reason. Once the broadcast is finished the recipient is shown as failed, because nothing will send to them again.
 */
export async function handleBlockedDelivery(tenantId: string, wamid: string, errorCode: string): Promise<boolean> {
  const r = await prisma.broadcastRecipient.findFirst({
    where: { tenantId, wamid },
    select: { id: true, status: true, broadcast: { select: { id: true, name: true, templateId: true, status: true } } },
  });
  if (!r || !["pending", "queued", "sent"].includes(r.status)) return false;
  const open = !!r.broadcast && OPEN.includes(r.broadcast.status);
  const data = open ? { status: "pending" as const, messageId: null, wamid: null, sentAt: null, errorCode: null } : { status: "failed" as const, errorCode };
  const { count } = await prisma.broadcastRecipient.updateMany({ where: { id: r.id, tenantId, wamid, status: { in: ["pending", "queued", "sent"] } }, data });
  if (count > 0 && open) await pauseForBlockedTemplate({ id: r.broadcast.id, tenantId, templateId: r.broadcast.templateId, name: r.broadcast.name }, true, "template_paused", errorCode);
  return count > 0;
}
