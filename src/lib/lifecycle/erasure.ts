import { prisma } from "@/lib/db";
import { eraseContactFromEddy } from "@/lib/eddy/erasure-sweep";
import { eddyForgetUserEverywhere } from "@/lib/eddy/forget-user";
import type { EddyTables } from "@/lib/eddy/retention";
import { removeInboundMediaFiles } from "@/lib/inbox/media";
import { revokeKeysBestEffort } from "@/lib/integrations/apikeys";

/** The transaction client, seen as the Eddy tables the erasure helpers use (docs/EDDY-SPEC.md 7.6, EDDY-16). */
const eddyTx = (tx: unknown) => tx as EddyTables;
/** Room for the Eddy rows deleted in the same transaction (Prisma's 5 s default is tight for a long Eddy history). */
const ERASURE_TX = { maxWait: 10_000, timeout: 60_000 };

/**
 * Removes personal data from a user account. Memberships go unless the user is the only owner of a workspace
 * (those are kept so the workspace is not orphaned; a platform admin must transfer or close them).
 * In the same transaction, Eddy forgets the user in every workspace, kept ones included (docs/EDDY-SPEC.md 7.6, EDDY-16
 * acceptance 8): their Eddy conversations, messages, preferences, notice receipts and own notices go, their pending cards are
 * cancelled, and their usage and audit rows stay without their userId.
 */
export async function anonymiseUser(userId: string): Promise<{ found: boolean; retainedWorkspaceIds: string[] }> {
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return { found: false, retainedWorkspaceIds: [] };

    const memberships = await tx.membership.findMany({ where: { userId }, select: { id: true, tenantId: true, role: true } });
    const retained: string[] = [];
    const removable: string[] = [];
    for (const m of memberships) {
      const soleOwner = m.role === "owner" && (await tx.membership.count({ where: { tenantId: m.tenantId, role: "owner", userId: { not: userId } } })) === 0;
      if (soleOwner) retained.push(m.tenantId);
      else removable.push(m.id);
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        name: "Deleted user",
        email: `deleted-${userId}@deleted.invalid`,
        passwordHash: "!",
        disabledAt: new Date(),
        emailVerifiedAt: null,
        totpCiphertext: null,
        totpIv: null,
        totpTag: null,
        totpEnabledAt: null,
        totpRecoveryHashes: [],
      },
    });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.emailToken.deleteMany({ where: { userId } });
    if (removable.length) await tx.membership.deleteMany({ where: { id: { in: removable }, userId } });
    await eddyForgetUserEverywhere(userId, { db: eddyTx(tx) });
    return { found: true, retainedWorkspaceIds: retained };
  }, ERASURE_TX);
  // The account is disabled for good, so every key it created, in every workspace (including ones kept because the user is the sole owner), is revoked.
  // After the commit and best effort: a failure is logged and never undoes the erasure.
  if (result.found) await revokeKeysBestEffort(userId, undefined, "user_anonymised");
  return result;
}

/**
 * Deletes one contact of one workspace (named by phone or BSUID) together with its conversations, messages, notes, automation run records and broadcast recipient rows, and
 * the cached copies of the media those messages carried (DATA_DIR/inbound-media). The files go after the commit and
 * never undo the erasure: a failure is only counted.
 * What Eddy holds about the contact goes in the same transaction (docs/EDDY-SPEC.md 7.6, EDDY-16 acceptance 6): every Eddy
 * conversation that mentions the contact loses its messages and is marked erased, and the action records and notices about
 * the contact or its chats are deleted. The daily eddy.erasure-sweep stays as the backstop.
 */
export async function deleteContactData(tenantId: string, who: string | { phone: string } | { bsuid: string }): Promise<{ deleted: boolean }> {
  let messageIds: string[] = [];
  const key = typeof who === "string" ? { phone: who } : who;
  const result = await prisma.$transaction(async (tx) => {
    // A person who messaged through a WhatsApp username may have no phone on file, so erasure can name them by BSUID instead.
    const contact = await tx.contact.findUnique({ where: "phone" in key ? { tenantId_phone: { tenantId, phone: key.phone } } : { tenantId_bsuid: { tenantId, bsuid: key.bsuid } }, select: { id: true } });
    if (!contact) return { deleted: false };
    const conversations = await tx.conversation.findMany({ where: { tenantId, contactId: contact.id }, select: { id: true } });
    const conversationIds = conversations.map((c) => c.id);
    if (conversationIds.length) {
      const messages = await tx.message.findMany({ where: { tenantId, conversationId: { in: conversationIds } }, select: { id: true } });
      messageIds = messages.map((m) => m.id);
      await tx.message.deleteMany({ where: { tenantId, conversationId: { in: conversationIds } } });
      await tx.note.deleteMany({ where: { tenantId, conversationId: { in: conversationIds } } });
      await tx.automationRun.deleteMany({ where: { tenantId, conversationId: { in: conversationIds } } });
    }
    await tx.broadcastRecipient.deleteMany({ where: { tenantId, contactId: contact.id } });
    await tx.ruleExecution.deleteMany({ where: { tenantId, contactId: contact.id } });
    await eraseContactFromEddy(tenantId, contact.id, { db: eddyTx(tx), conversationIds });
    await tx.contact.delete({ where: { id: contact.id } });
    return { deleted: true };
  }, ERASURE_TX);
  if (result.deleted && messageIds.length) await removeInboundMediaFiles(tenantId, messageIds).catch(() => 0);
  return result;
}
