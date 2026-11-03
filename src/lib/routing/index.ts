import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { assertInTeamPool, teamPoolUserIds } from "@/lib/teams/pool";
import { HttpError, hasRole, type Actor } from "@/lib/tenancy";
import { DEFAULT_SETTINGS, isWithinWorkingHours, pickAgent, type Candidate, type RoutingSettings, type RoutingMode } from "./config";
import { getExtra, type RoutingExtra } from "./extra";

export { isWithinWorkingHours, pickAgent, validateSettings, parseWorkingHours, DEFAULT_SETTINGS, MAX_OPEN_LIMIT } from "./config";
export type { RoutingSettings, RoutingMode, WorkingHours, HoursWindow, Candidate } from "./config";
export { getExtra, saveExtra, validateExtra, parseExtra, DEFAULT_EXTRA, DEFAULT_LEAD_STAGES } from "./extra";
export type { RoutingExtra } from "./extra";

export type AssignResult = { assignedToId: string | null; reason: string };

const OPEN_STATUSES = ["open", "pending"];

export async function getSettings(tenantId: string): Promise<RoutingSettings> {
  const row = await prisma.routingConfig.findUnique({ where: { tenantId } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    autoAssign: row.autoAssign,
    mode: row.mode === "least_busy" ? "least_busy" : "round_robin",
    timezone: row.timezone,
    workingHours: (row.workingHours as RoutingSettings["workingHours"]) ?? null,
    maxOpenPerAgent: row.maxOpenPerAgent,
    fallbackUserId: row.fallbackUserId,
  };
}

/** Members of the tenant who can receive chats, with their availability and current open load. */
export async function loadCandidates(tenantId: string): Promise<Candidate[]> {
  const [members, availability, loads] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId }, select: { userId: true, user: { select: { disabledAt: true } } } }),
    prisma.agentAvailability.findMany({ where: { tenantId } }),
    prisma.conversation.groupBy({ by: ["assignedToId"], where: { tenantId, assignedToId: { not: null }, status: { in: OPEN_STATUSES } }, _count: { _all: true } }),
  ]);
  const avail = new Map(availability.map((a) => [a.userId, a]));
  const load = new Map(loads.map((l) => [l.assignedToId as string, l._count._all]));
  return members.map((m) => {
    const a = avail.get(m.userId);
    return {
      userId: m.userId,
      eligibleMember: true,
      disabled: m.user.disabledAt !== null,
      available: a?.available ?? true,
      maxOpen: a?.maxOpen ?? null,
      lastAssignedAt: a?.lastAssignedAt ?? null,
      openCount: load.get(m.userId) ?? 0,
    };
  });
}

type Tx = Pick<typeof prisma, "conversation" | "agentAvailability">;

/** The conditional update is the only write that can win a race: a second concurrent assignment matches zero rows. */
async function claim(tenantId: string, conversationId: string, userId: string, now: Date, teamId?: string | null): Promise<boolean> {
  return prisma.$transaction(async (tx: Tx) => {
    const res = await tx.conversation.updateMany({
      where: { id: conversationId, tenantId, assignedToId: null },
      data: { assignedToId: userId, assignedAt: now, ...(teamId !== undefined ? { teamId } : {}) },
    });
    if (res.count === 0) return false;
    await tx.agentAvailability.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, lastAssignedAt: now },
      update: { lastAssignedAt: now },
    });
    return true;
  });
}

function fallbackAgent(candidates: Candidate[], fallbackUserId: string | null): string | null {
  if (!fallbackUserId) return null;
  const c = candidates.find((x) => x.userId === fallbackUserId);
  return c && !c.disabled ? c.userId : null;
}

type RoutedConversation = { id: string; tenantId: string; assignedToId: string | null; status: string; teamId: string | null; contactId: string };

/** The person who last replied to this customer, if that was recent enough. */
async function lastHandler(tenantId: string, conversationId: string, withinHours: number, at: Date): Promise<string | null> {
  const last = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "outbound", sentByUserId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { sentByUserId: true, createdAt: true },
  });
  if (!last?.sentByUserId || at.getTime() - last.createdAt.getTime() > withinHours * 3_600_000) return null;
  return last.sentByUserId;
}

async function preferredAgent(conv: RoutedConversation, pool: Candidate[], config: RoutingSettings, extra: RoutingExtra, at: Date): Promise<{ userId: string; reason: string } | null> {
  const usable = (userId: string | null | undefined) => (userId && pickAgent(pool.filter((c) => c.userId === userId), config.mode, config.maxOpenPerAgent) === userId ? userId : null);
  if (extra.lastAssignee.enabled) {
    const userId = usable(await lastHandler(conv.tenantId, conv.id, extra.lastAssignee.withinHours, at));
    if (userId) return { userId, reason: "last_assignee" };
  }
  if (extra.contactOwner.enabled) {
    const owner = await prisma.contact.findFirst({ where: { id: conv.contactId, tenantId: conv.tenantId }, select: { ownerUserId: true } });
    const userId = usable(owner?.ownerUserId);
    if (userId) return { userId, reason: "contact_owner" };
  }
  return null;
}

async function ownerFollowsAssignee(tenantId: string, contactId: string, userId: string, extra: RoutingExtra): Promise<void> {
  if (!extra.setOwnerOnAssign) return;
  await prisma.contact.updateMany({ where: { id: contactId, tenantId, ownerUserId: null }, data: { ownerUserId: userId } });
}

/**
 * Picks a person for an unassigned chat. Order: the person who last replied to this customer, the contact's owner, then the
 * round-robin or least-busy pick among the chat's team (the default team when it has none; everyone when that team is empty).
 * options.teamId routes inside that team and files the chat under it.
 */
export async function assignConversation(tenantId: string, conversationId: string, options: { force?: boolean; at?: Date; teamId?: string | null } = {}): Promise<AssignResult> {
  const at = options.at ?? new Date();
  const config = await getSettings(tenantId);
  if (!config.autoAssign && !options.force) return { assignedToId: null, reason: "auto_assign_off" };
  const found = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { id: true, assignedToId: true, status: true, teamId: true, contactId: true } });
  if (!found) return { assignedToId: null, reason: "not_found" };
  if (found.assignedToId) return { assignedToId: found.assignedToId, reason: "already_assigned" };
  if (found.status === "blocked") return { assignedToId: null, reason: "blocked" };
  const conversation: RoutedConversation = { ...found, tenantId };

  const [candidates, extra, poolIds] = await Promise.all([
    loadCandidates(tenantId),
    getExtra(tenantId),
    teamPoolUserIds(tenantId, options.teamId !== undefined ? options.teamId : found.teamId),
  ]);
  const pool = poolIds ? candidates.filter((c) => poolIds.includes(c.userId)) : candidates;
  const inHours = isWithinWorkingHours(config, at);
  let userId: string | null = null;
  let reason = "assigned";
  if (inHours) {
    const preferred = await preferredAgent(conversation, pool, config, extra, at);
    if (preferred) ({ userId, reason } = preferred);
    else userId = pickAgent(pool, config.mode as RoutingMode, config.maxOpenPerAgent);
  }
  if (!userId) {
    reason = inHours ? "no_agent_available" : "outside_hours";
    userId = fallbackAgent(candidates, config.fallbackUserId);
    if (userId) reason = "fallback";
  }
  if (!userId) return { assignedToId: null, reason };

  if (!(await claim(tenantId, conversationId, userId, at, options.teamId))) return { assignedToId: null, reason: "already_assigned" };
  await ownerFollowsAssignee(tenantId, found.contactId, userId, extra);
  await audit({ tenantId, action: "routing.auto_assign", target: conversationId, meta: { assignedToId: userId, reason, mode: config.mode } });
  return { assignedToId: userId, reason };
}

/** Call after any manual assignment (inbox, bulk) so the contact owner setting is honoured. Never throws. */
export async function onConversationAssigned(tenantId: string, conversationId: string, userId: string | null): Promise<void> {
  if (!userId) return;
  try {
    const extra = await getExtra(tenantId);
    if (!extra.setOwnerOnAssign) return;
    const conv = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { contactId: true } });
    if (conv) await ownerFollowsAssignee(tenantId, conv.contactId, userId, extra);
  } catch {
    console.error("[routing] could not update the contact owner");
  }
}

export const NOT_A_MEMBER = "That person is not a member of this workspace.";
export const ACCOUNT_DISABLED = "That person's account is disabled.";
export const CHANGED_MEANWHILE = "This chat was just changed by someone else. Reload and try again.";

/** Someone who can be given chats: a member of this workspace whose account is not disabled. */
export async function assertAssignable(tenantId: string, userId: string): Promise<void> {
  const member = await prisma.membership.findFirst({ where: { tenantId, userId }, select: { user: { select: { disabledAt: true } } } });
  if (!member) throw new HttpError(400, NOT_A_MEMBER);
  if (member.user?.disabledAt) throw new HttpError(400, ACCOUNT_DISABLED);
}

/** lastAssignedAt keeps round-robin fair after manual assignments too. A failure here never undoes the assignment. */
async function touchLastAssigned(tenantId: string, userId: string, at: Date): Promise<void> {
  try {
    await prisma.agentAvailability.upsert({ where: { tenantId_userId: { tenantId, userId } }, create: { tenantId, userId, lastAssignedAt: at }, update: { lastAssignedAt: at } });
  } catch {
    console.error("[routing] could not record when the person was last given a chat");
  }
}

/**
 * The chat as the caller read it: the write only applies while it is still assigned to assignedToId. teamId is required (null
 * for a chat outside any team) so a caller that forgets to select it fails to compile instead of skipping the team-pool check.
 */
export type AssignableChat = { id: string; assignedToId: string | null; teamId: string | null };

/**
 * The one write behind every manual assignment: POST /api/routing/assign, the inbox (one chat or many), Eddy, the API and
 * the workspace MCP server. The caller has already decided the person may do it (role, visibility). Here the assignee must be a
 * member whose account is not disabled (skipped with memberChecked when a batch checked it once) and inside the chat's team.
 * The write only replaces the assignee that was read, so a change made meanwhile is a 409 instead of being lost. Then the
 * assignee's lastAssignedAt moves (round-robin fairness), the contact owner follows when that setting is on, and a
 * routing.assign or routing.unassign row is written, which also tells the auto-reassign sweep a person chose this assignee.
 */
export async function applyAssignment(
  who: { tenantId: string; userId?: string | null },
  chat: AssignableChat,
  userId: string | null,
  options: { memberChecked?: boolean } = {},
): Promise<AssignResult> {
  const { tenantId } = who;
  if (userId !== null) {
    if (!options.memberChecked) await assertAssignable(tenantId, userId);
    await assertInTeamPool(tenantId, chat.teamId, userId);
  }
  const now = new Date();
  const res = await prisma.conversation.updateMany({
    where: { id: chat.id, tenantId, assignedToId: chat.assignedToId },
    data: { assignedToId: userId, assignedAt: userId ? now : null },
  });
  if (res.count === 0) throw new HttpError(409, CHANGED_MEANWHILE);
  if (userId) await touchLastAssigned(tenantId, userId, now);
  await onConversationAssigned(tenantId, chat.id, userId);
  await audit({ tenantId, userId: who.userId ?? null, action: userId ? "routing.assign" : "routing.unassign", target: chat.id, meta: { assignedToId: userId, previousId: chat.assignedToId } });
  return { assignedToId: userId, reason: userId ? "manual" : "unassigned" };
}

/** Manual assignment. userId null unassigns. Agents may only take a chat for themselves or release their own; admins and owners may do anything. */
export async function assignManually(actor: Actor, conversationId: string, userId: string | null): Promise<AssignResult> {
  const manager = hasRole(actor, "admin");
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { id: true, assignedToId: true, teamId: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  if (!manager) {
    const ownRelease = userId === null && conversation.assignedToId === actor.userId;
    const takeOwn = userId === actor.userId && (conversation.assignedToId === null || conversation.assignedToId === actor.userId);
    if (!ownRelease && !takeOwn) throw new HttpError(403, "You do not have permission to do this.");
  }
  return applyAssignment(actor, conversation, userId);
}

export async function setAvailability(tenantId: string, userId: string, patch: { available?: boolean; maxOpen?: number | null }) {
  const member = await prisma.membership.findFirst({ where: { tenantId, userId }, select: { id: true } });
  if (!member) throw new HttpError(404, "Member not found.");
  const data: { available?: boolean; maxOpen?: number | null } = {};
  if (patch.available !== undefined) data.available = patch.available;
  if (patch.maxOpen !== undefined) data.maxOpen = patch.maxOpen;
  return prisma.agentAvailability.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { tenantId, userId, ...data },
    update: data,
    select: { userId: true, available: true, maxOpen: true, lastAssignedAt: true },
  });
}
