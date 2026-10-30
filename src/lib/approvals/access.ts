import { prisma } from "@/lib/db";
import { HttpError, hasRole, type Actor } from "@/lib/tenancy";
import { HANDLERS } from "./summary";
import type { ApprovalSubject } from "./types";

/** Admins and owners may manage any approval in their workspace; others only for items they created themselves. */
export async function authorizeSubject(actor: Actor, subjectType: ApprovalSubject, subjectId: string): Promise<void> {
  const owner = await HANDLERS[subjectType].owner(actor.tenantId, subjectId);
  if (!owner) throw new HttpError(404, "That item was not found.");
  if (hasRole(actor, "admin")) return;
  if (owner.createdByUserId && owner.createdByUserId === actor.userId) return;
  throw new HttpError(403, "You do not have permission to do this.");
}

export async function loadOwnedApproval(actor: Actor, id: string) {
  const row = await prisma.approvalRequest.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true, subjectType: true, subjectId: true, status: true },
  });
  if (!row) throw new HttpError(404, "Approval not found.");
  await authorizeSubject(actor, row.subjectType as ApprovalSubject, row.subjectId);
  return row;
}
