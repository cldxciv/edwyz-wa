import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { getExtra } from "@/lib/routing/extra";
import { HttpError, hasRole, type Actor } from "@/lib/tenancy";
import { assertContactVisible } from "./visibility";

export type ContactFieldsPatch = { ownerUserId?: unknown; leadStage?: unknown };

/**
 * Sets the contact owner (a member of this workspace, or none) and the lead stage (one of the configured stages, or none).
 * Admins and owners can change anything. Agents can only touch contacts they may see; they can set the stage, take an unowned
 * contact for themselves or hand back their own, but not move a contact to someone else.
 */
export async function setContactOwnerAndStage(actor: Actor, contactId: string, patch: ContactFieldsPatch) {
  const manager = hasRole(actor, "admin");
  if (!manager) {
    await assertContactVisible(actor, contactId);
    if (patch.ownerUserId !== undefined) {
      const current = await prisma.contact.findFirst({ where: { id: contactId, tenantId: actor.tenantId }, select: { ownerUserId: true } });
      if (!current) throw new HttpError(404, "Contact not found.");
      const takeOwn = patch.ownerUserId === actor.userId && (current.ownerUserId === null || current.ownerUserId === actor.userId);
      const release = patch.ownerUserId === null && current.ownerUserId === actor.userId;
      const unchanged = patch.ownerUserId === current.ownerUserId;
      if (!takeOwn && !release && !unchanged) throw new HttpError(403, "You can take a contact that has no owner or hand back your own. Ask an admin to move it to someone else.");
    }
  }
  const data: { ownerUserId?: string | null; leadStage?: string | null } = {};
  if (patch.ownerUserId !== undefined) {
    if (patch.ownerUserId !== null && (typeof patch.ownerUserId !== "string" || !patch.ownerUserId || patch.ownerUserId.length > 64)) throw new HttpError(400, "ownerUserId must be a user id or null.");
    if (patch.ownerUserId) {
      const member = await prisma.membership.findFirst({ where: { tenantId: actor.tenantId, userId: patch.ownerUserId }, select: { id: true } });
      if (!member) throw new HttpError(400, "The owner must be a member of this workspace.");
    }
    data.ownerUserId = patch.ownerUserId;
  }
  if (patch.leadStage !== undefined) {
    if (patch.leadStage !== null && typeof patch.leadStage !== "string") throw new HttpError(400, "leadStage must be a stage name or null.");
    if (patch.leadStage) {
      const stages = (await getExtra(actor.tenantId)).leadStages;
      if (!stages.includes(patch.leadStage)) throw new HttpError(400, "Choose one of your lead stages.");
    }
    data.leadStage = patch.leadStage || null;
  }
  if (Object.keys(data).length === 0) throw new HttpError(400, "Nothing to change.");
  const { count } = await prisma.contact.updateMany({ where: { id: contactId, tenantId: actor.tenantId }, data });
  if (count === 0) throw new HttpError(404, "Contact not found.");
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "contact.owner_stage", target: contactId, meta: { ownerChanged: "ownerUserId" in data, stageChanged: "leadStage" in data } });
  return prisma.contact.findFirst({ where: { id: contactId, tenantId: actor.tenantId }, select: { id: true, ownerUserId: true, leadStage: true } });
}
