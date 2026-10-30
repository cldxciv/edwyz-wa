import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { canActOn } from "@/lib/inbox/status";
import { loadCandidates, getSettings, pickAgent } from "@/lib/routing";
import { getExtra } from "@/lib/routing/extra";
import { HttpError, hasRole, type Actor } from "@/lib/tenancy";
import { assertConversationVisible } from "./visibility";

export type TeamAssignInput = {
  /** The team to put the chat in, or null to take it out of its team. */
  teamId: string | null;
  /** Someone inside the team, null to leave the chat without a person, or undefined to keep the current person when they fit. */
  userId?: string | null;
  /** When no person is given and the current person is not in the team, pick one from the team automatically. */
  route?: boolean;
};

export type TeamAssignResult = { teamId: string | null; assignedToId: string | null; reason: string };

type Conv = { id: string; assignedToId: string | null; teamId: string | null; contactId: string };

async function loadTeam(tenantId: string, teamId: string) {
  const team = await prisma.team.findFirst({ where: { id: teamId, tenantId }, select: { id: true, isDefault: true } });
  if (!team) throw new HttpError(404, "Team not found.");
  const members = await prisma.teamMember.findMany({ where: { tenantId, teamId }, select: { userId: true } });
  return { ...team, memberIds: members.map((m) => m.userId) };
}

async function requireActiveMember(tenantId: string, userId: string) {
  const member = await prisma.membership.findFirst({ where: { tenantId, userId }, select: { user: { select: { disabledAt: true } } } });
  if (!member) throw new HttpError(400, "That person is not a member of this workspace.");
  if (member.user.disabledAt) throw new HttpError(400, "That person's account is disabled.");
}

async function pickFromTeam(tenantId: string, memberIds: string[], exclude?: string | null): Promise<string | null> {
  const [config, candidates] = await Promise.all([getSettings(tenantId), loadCandidates(tenantId)]);
  const pool = candidates.filter((c) => (memberIds.length === 0 || memberIds.includes(c.userId)) && c.userId !== exclude);
  return pickAgent(pool, config.mode, config.maxOpenPerAgent);
}

/**
 * Puts a chat in a team and decides who handles it inside the team. No permission checks: callers (the API route, automation
 * rules, chatbots) decide whether the action is allowed. The write is conditional on the person we saw, so a concurrent change wins.
 */
export async function applyTeamAssignment(tenantId: string, conversationId: string, input: TeamAssignInput, by?: string): Promise<TeamAssignResult> {
  const conv: Conv | null = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { id: true, assignedToId: true, teamId: true, contactId: true } });
  if (!conv) throw new HttpError(404, "Conversation not found.");
  const team = input.teamId ? await loadTeam(tenantId, input.teamId) : null;
  const inTeam = (userId: string) => !team || team.memberIds.length === 0 || team.memberIds.includes(userId);

  let assignedToId = conv.assignedToId;
  let reason = "team_set";
  if (input.userId !== undefined) {
    if (input.userId !== null) {
      await requireActiveMember(tenantId, input.userId);
      if (!inTeam(input.userId)) throw new HttpError(400, "That person is not in this team.");
    }
    assignedToId = input.userId;
    reason = input.userId ? "team_and_person" : "team_unassigned";
  } else if (assignedToId && !inTeam(assignedToId)) {
    assignedToId = input.route ? await pickFromTeam(tenantId, team?.memberIds ?? [], assignedToId) : null;
    reason = assignedToId ? "team_routed" : "team_unassigned";
  } else if (!assignedToId && input.route) {
    assignedToId = await pickFromTeam(tenantId, team?.memberIds ?? []);
    reason = assignedToId ? "team_routed" : "team_no_agent_available";
  }

  const now = new Date();
  const changedPerson = assignedToId !== conv.assignedToId;
  const res = await prisma.conversation.updateMany({
    where: { id: conv.id, tenantId, assignedToId: conv.assignedToId },
    data: { teamId: input.teamId, ...(changedPerson ? { assignedToId, assignedAt: assignedToId ? now : null } : {}) },
  });
  if (res.count === 0) throw new HttpError(409, "This chat was just changed by someone else. Reload and try again.");
  if (changedPerson && assignedToId) {
    await prisma.agentAvailability.upsert({ where: { tenantId_userId: { tenantId, userId: assignedToId } }, create: { tenantId, userId: assignedToId, lastAssignedAt: now }, update: { lastAssignedAt: now } });
    if ((await getExtra(tenantId)).setOwnerOnAssign) await prisma.contact.updateMany({ where: { id: conv.contactId, tenantId, ownerUserId: null }, data: { ownerUserId: assignedToId } });
  }
  await audit({
    tenantId,
    userId: by ?? null,
    action: "routing.team_assign",
    target: conv.id,
    meta: { teamId: input.teamId, assignedToId, previousTeamId: conv.teamId, previousId: conv.assignedToId, reason },
  });
  return { teamId: input.teamId, assignedToId, reason };
}

/** Route handler entry point: managers can do anything, agents can send a chat they may act on to a team and let routing pick the person. */
export async function assignToTeam(actor: Actor, conversationId: string, input: TeamAssignInput): Promise<TeamAssignResult> {
  if (!hasRole(actor, "admin")) {
    await assertConversationVisible(actor, conversationId);
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { assignedToId: true } });
    if (!conv) throw new HttpError(404, "Conversation not found.");
    if (!canActOn(actor, conv.assignedToId)) throw new HttpError(403, "This conversation is assigned to someone else.");
    if (input.userId !== undefined && input.userId !== null && input.userId !== actor.userId) throw new HttpError(403, "Send the chat to the team and we will pick the person, or take it yourself.");
  }
  return applyTeamAssignment(actor.tenantId, conversationId, input, actor.userId);
}
