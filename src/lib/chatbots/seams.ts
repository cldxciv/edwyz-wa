import { prisma } from "@/lib/db";
import { emitStatusChanged } from "@/lib/integrations/emitters";
import { HttpError } from "@/lib/tenancy";

/** Hooks the routing and status modules can replace later without this package importing them. */
export type ChatbotSeams = {
  /** target is a user id or "round_robin". */
  assign(tenantId: string, conversationId: string, target: string): Promise<void>;
  /**
   * Puts the conversation in a team. target is a teammate of that team, "round_robin" (the next free teammate of the team)
   * or null (team only: the chat waits in the team's queue).
   */
  assignTeam(tenantId: string, conversationId: string, teamId: string, target: string | null): Promise<void>;
  setStatus(tenantId: string, conversationId: string, status: string): Promise<void>;
  /**
   * Called when the bot hands the conversation to people: status is already open; routing should pick an agent.
   * queueOnly means the chat was left in a team's queue on purpose, so no agent may be picked.
   */
  handoff(tenantId: string, conversationId: string, opts?: { queueOnly?: boolean }): Promise<void>;
};

async function setStatus(tenantId: string, conversationId: string, status: string) {
  const before = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, contactId: true } });
  await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { status, statusChangedAt: new Date() } });
  await emitStatusChanged(tenantId, { conversationId, contactId: before?.contactId ?? null, from: before?.status ?? null, to: status, source: "system" });
}

/**
 * Gives the chat to a teammate the way the inbox does: the owner and availability bookkeeping and the contact-owner follow-up run too,
 * so an assignment made by a bot step is indistinguishable from one made by hand. Exported for the module wiring.
 * The write is conditional on the person it saw, so a teammate who picked the chat up in between is not overwritten.
 */
export async function claimFor(tenantId: string, conversationId: string, userId: string, teamId?: string) {
  const now = new Date();
  const current = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { assignedToId: true } });
  if (!current) return;
  const { count } = await prisma.conversation.updateMany({ where: { id: conversationId, tenantId, assignedToId: current.assignedToId }, data: { assignedToId: userId, assignedAt: now, ...(teamId ? { teamId } : {}) } });
  if (count === 0) return;
  await prisma.agentAvailability.upsert({ where: { tenantId_userId: { tenantId, userId } }, create: { tenantId, userId, lastAssignedAt: now }, update: { lastAssignedAt: now } }).catch(() => undefined);
  try {
    await (await import("@/lib/routing")).onConversationAssigned(tenantId, conversationId, userId);
  } catch {
    console.error("[chatbot] could not run the assignment follow-up");
  }
}

/** The next free member of the team by the workspace's routing mode, or null when nobody is available. */
async function nextTeamMember(tenantId: string, teamId: string): Promise<string | null> {
  const [members, routing] = await Promise.all([prisma.teamMember.findMany({ where: { tenantId, teamId }, select: { userId: true } }), import("@/lib/routing")]);
  const ids = new Set(members.map((m) => m.userId));
  if (ids.size === 0) return null;
  const [settings, candidates] = await Promise.all([routing.getSettings(tenantId), routing.loadCandidates(tenantId)]);
  return routing.pickAgent(
    candidates.filter((c) => ids.has(c.userId)),
    settings.mode,
    settings.maxOpenPerAgent,
  );
}

const defaults: ChatbotSeams = {
  async assign(tenantId, conversationId, target) {
    if (target === "round_robin") return;
    const member = await prisma.membership.findFirst({ where: { tenantId, userId: target }, select: { id: true } });
    if (!member) throw new HttpError(400, "That user is not a member of this workspace.");
    await claimFor(tenantId, conversationId, target);
  },
  async assignTeam(tenantId, conversationId, teamId, target) {
    const team = await prisma.team.findFirst({ where: { id: teamId, tenantId }, select: { id: true } });
    if (!team) throw new HttpError(400, "That team does not exist in this workspace.");
    await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { teamId } });
    if (target === null) return;
    if (target === "round_robin") {
      const userId = await nextTeamMember(tenantId, teamId);
      if (userId) await claimFor(tenantId, conversationId, userId);
      return;
    }
    const member = await prisma.teamMember.findFirst({ where: { tenantId, teamId, userId: target }, select: { id: true } });
    if (!member) throw new HttpError(400, "That teammate is not in this team.");
    await claimFor(tenantId, conversationId, target);
  },
  setStatus,
  async handoff(tenantId, conversationId) {
    await setStatus(tenantId, conversationId, "open");
  },
};

let current: ChatbotSeams = defaults;

export const getSeams = (): ChatbotSeams => current;

/** Plug in routing or status behaviour; pass only the seams you want to override. */
export function registerChatbotSeams(overrides: Partial<ChatbotSeams>): void {
  current = { ...current, ...overrides };
}

export function resetChatbotSeams(): void {
  current = defaults;
}
