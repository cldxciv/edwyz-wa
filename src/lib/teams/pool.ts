import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";

export const DEFAULT_TEAM_NAME = "Default team";

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** The workspace's default team. Created on first use. Chats with no team belong to it. */
export async function ensureDefaultTeam(tenantId: string): Promise<{ id: string; name: string }> {
  const found = await prisma.team.findFirst({ where: { tenantId, isDefault: true }, select: { id: true, name: true } });
  if (found) return found;
  try {
    return await prisma.team.create({ data: { tenantId, name: DEFAULT_TEAM_NAME, isDefault: true }, select: { id: true, name: true } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const named = await prisma.team.findFirst({ where: { tenantId, name: DEFAULT_TEAM_NAME }, select: { id: true, name: true } });
    if (!named) throw e;
    await prisma.team.updateMany({ where: { id: named.id, tenantId }, data: { isDefault: true } });
    return named;
  }
}

/**
 * The people who may receive a chat of this team, or null when the team has nobody in it (meaning everyone in the workspace).
 * teamId null means the default team.
 */
export async function teamPoolUserIds(tenantId: string, teamId: string | null): Promise<string[] | null> {
  const team = teamId ? await prisma.team.findFirst({ where: { id: teamId, tenantId }, select: { id: true } }) : await prisma.team.findFirst({ where: { tenantId, isDefault: true }, select: { id: true } });
  if (!team) return null;
  const members = await prisma.teamMember.findMany({ where: { tenantId, teamId: team.id }, select: { userId: true } });
  return members.length > 0 ? members.map((m) => m.userId) : null;
}

/**
 * Manual assignment stays inside the chat's team: a chat filed under a team that has people in it can only go to one of them.
 * Chats with no team, and teams with nobody in them, accept anyone.
 */
export async function assertInTeamPool(tenantId: string, teamId: string | null | undefined, userId: string): Promise<void> {
  if (!teamId) return;
  const pool = await teamPoolUserIds(tenantId, teamId);
  if (pool && !pool.includes(userId)) throw new HttpError(400, "That person is not in this chat's team. Move the chat to their team first, or pick someone from the team.");
}
