import type { Role } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import { audit } from "./audit";
import { verifyPassword } from "./password";

export const ROLES: readonly Role[] = ["owner", "admin", "agent"];

type Tx = Pick<typeof prisma, "membership">;

/** Serialises owner changes per workspace with an advisory lock, so two owners cannot demote or remove each other at once. */
export function withOwnerLock<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owners:${tenantId}`}))`;
    return fn(tx);
  });
}

export const LAST_OWNER_MESSAGE = "A workspace must keep at least one owner. Make someone else an owner first.";

/** Throws when the member is the only owner. Call it inside withOwnerLock before demoting or removing someone. */
export async function lastOwnerGuard(tx: Tx, tenantId: string, userId: string): Promise<void> {
  const current = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  if (current?.role !== "owner") return;
  const owners = await tx.membership.count({ where: { tenantId, role: "owner" } });
  if (owners <= 1) throw new HttpError(400, LAST_OWNER_MESSAGE);
}

/**
 * Hands the workspace to another member: they become the owner and the caller becomes an admin (or stays an owner when
 * keepOwner is true). The caller's password is required, so a stolen session cannot give the workspace away.
 * Both changes happen under the owner lock, so a concurrent demotion cannot leave the workspace without an owner.
 */
export async function transferOwnership(input: { tenantId: string; fromUserId: string; toUserId: string; password: string; keepOwner: boolean }): Promise<{ newOwnerId: string; previousOwnerRole: Role }> {
  const { tenantId, fromUserId, toUserId } = input;
  if (fromUserId === toUserId) throw new HttpError(400, "Choose another member. You are already the owner.");
  const user = await prisma.user.findUnique({ where: { id: fromUserId }, select: { passwordHash: true } });
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    await audit({ tenantId, userId: fromUserId, action: "member.ownership_transfer_denied", target: toUserId });
    throw new HttpError(403, "That password is not right.");
  }
  const previousOwnerRole: Role = input.keepOwner ? "owner" : "admin";
  await withOwnerLock(tenantId, async (tx) => {
    const [from, to] = await Promise.all([
      tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: fromUserId } } }),
      tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: toUserId } } }),
    ]);
    if (from?.role !== "owner") throw new HttpError(403, "Only an owner can transfer ownership.");
    if (!to) throw new HttpError(404, "That member was not found in this workspace.");
    await tx.membership.update({ where: { tenantId_userId: { tenantId, userId: toUserId } }, data: { role: "owner" } });
    if (!input.keepOwner) await tx.membership.update({ where: { tenantId_userId: { tenantId, userId: fromUserId } }, data: { role: "admin" } });
  });
  await audit({ tenantId, userId: fromUserId, action: "member.ownership_transferred", target: toUserId, meta: { keepOwner: input.keepOwner } });
  return { newOwnerId: toUserId, previousOwnerRole };
}
