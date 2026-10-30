import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { HttpError, type Actor } from "@/lib/tenancy";
import { ensureDefaultTeam } from "./pool";

export const MAX_TEAMS = 50;
export const MAX_TEAM_NAME = 60;

export type TeamSummary = { id: string; name: string; isDefault: boolean; memberIds: string[]; createdAt: string };

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002";

export function cleanTeamName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Give the team a name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new HttpError(400, "Give the team a name.");
  if (name.length > MAX_TEAM_NAME) throw new HttpError(400, `A team name can have at most ${MAX_TEAM_NAME} characters.`);
  return name;
}

export async function listTeams(tenantId: string): Promise<TeamSummary[]> {
  await ensureDefaultTeam(tenantId);
  const rows = await prisma.team.findMany({ where: { tenantId }, include: { members: { select: { userId: true } } }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], take: MAX_TEAMS + 1 });
  return rows.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault, memberIds: t.members.map((m) => m.userId), createdAt: t.createdAt.toISOString() }));
}

async function requireTeam(tenantId: string, id: string) {
  const team = await prisma.team.findFirst({ where: { id, tenantId } });
  if (!team) throw new HttpError(404, "Team not found.");
  return team;
}

export async function createTeam(actor: Actor, input: { name: unknown }): Promise<TeamSummary> {
  const name = cleanTeamName(input.name);
  if ((await prisma.team.count({ where: { tenantId: actor.tenantId } })) >= MAX_TEAMS) throw new HttpError(409, `A workspace can have at most ${MAX_TEAMS} teams.`);
  try {
    const team = await prisma.team.create({ data: { tenantId: actor.tenantId, name } });
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "team.created", target: team.id });
    return { id: team.id, name: team.name, isDefault: team.isDefault, memberIds: [], createdAt: team.createdAt.toISOString() };
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "You already have a team with that name.");
    throw e;
  }
}

export async function updateTeam(actor: Actor, id: string, patch: { name?: unknown; isDefault?: unknown }): Promise<void> {
  const team = await requireTeam(actor.tenantId, id);
  if (patch.name !== undefined) {
    const name = cleanTeamName(patch.name);
    try {
      await prisma.team.updateMany({ where: { id, tenantId: actor.tenantId }, data: { name } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "You already have a team with that name.");
      throw e;
    }
  }
  if (patch.isDefault !== undefined) {
    if (patch.isDefault !== true) throw new HttpError(400, "Choose another team as the default instead of switching this one off.");
    if (!team.isDefault) {
      await prisma.$transaction([
        prisma.team.updateMany({ where: { tenantId: actor.tenantId, isDefault: true }, data: { isDefault: false } }),
        prisma.team.updateMany({ where: { id, tenantId: actor.tenantId }, data: { isDefault: true } }),
      ]);
    }
  }
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "team.updated", target: id });
}

export async function deleteTeam(actor: Actor, id: string): Promise<void> {
  const team = await requireTeam(actor.tenantId, id);
  if (team.isDefault) throw new HttpError(409, "The default team cannot be deleted. Choose another default team first.");
  await prisma.conversation.updateMany({ where: { tenantId: actor.tenantId, teamId: id }, data: { teamId: null } });
  await prisma.teamMember.deleteMany({ where: { tenantId: actor.tenantId, teamId: id } });
  await prisma.team.deleteMany({ where: { id, tenantId: actor.tenantId } });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "team.deleted", target: id });
}

/** Replaces the member list. Everyone must belong to this workspace. */
export async function setTeamMembers(actor: Actor, id: string, userIds: unknown): Promise<string[]> {
  await requireTeam(actor.tenantId, id);
  if (!Array.isArray(userIds) || userIds.length > 500 || userIds.some((u) => typeof u !== "string" || !u || u.length > 64)) throw new HttpError(400, "userIds must be a list of user ids.");
  const wanted = [...new Set(userIds as string[])];
  const real = wanted.length ? await prisma.membership.findMany({ where: { tenantId: actor.tenantId, userId: { in: wanted } }, select: { userId: true } }) : [];
  if (real.length !== wanted.length) throw new HttpError(400, "Everyone on a team must be a member of this workspace.");
  await prisma.teamMember.deleteMany({ where: { tenantId: actor.tenantId, teamId: id, userId: { notIn: wanted } } });
  if (wanted.length) await prisma.teamMember.createMany({ data: wanted.map((userId) => ({ tenantId: actor.tenantId, teamId: id, userId })), skipDuplicates: true });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "team.members_set", target: id, meta: { count: wanted.length } });
  return wanted;
}

export async function teamIdsForUser(tenantId: string, userId: string): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({ where: { tenantId, userId }, select: { teamId: true } });
  return rows.map((r) => r.teamId);
}

/** Removes a person from every team when they leave the workspace. */
export async function removeUserFromTeams(tenantId: string, userId: string): Promise<void> {
  await prisma.teamMember.deleteMany({ where: { tenantId, userId } });
}
