import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

/**
 * The AI agent's pause in one chat, kept small so chatbots can use it without loading the AI agent (no import cycles).
 *
 * The tag pauses the agent (after it handed the chat to the team, a chatbot hand-over, or a teammate starting a bot). The audit
 * rows date the pause: a pause lasts one episode of the chat, and the agent judges that from when the pause began (see
 * pauseLapsed in ./index). Teammates never see the raw tag; the inbox offers "Let the AI answer again".
 */
export const STOP_TAG = "ai:stopped";
/** Written whenever a hand-over pauses the AI agent in a chat, also when the chat was paused already: the pause starts again then. */
export const PAUSED_ACTION = "ai_agent.paused";
/** A teammate let the AI answer a paused chat again. Like a reopened chat, it also starts the reply count afresh. */
export const RESUMED_ACTION = "ai_agent.resumed";
/** The pause ended on its own (a new episode began) or a rule's "Let the AI agent answer" step lifted it. */
export const LIFTED_ACTION = "ai_agent.pause_lifted";
/** Every row that dates the start or the end of a pause. */
export const PAUSE_ACTIONS = [PAUSED_ACTION, RESUMED_ACTION, LIFTED_ACTION];

/** Dates a pause that a hand-over just started (or started again). Best effort: the audit helper never throws. */
export async function markAiPaused(tenantId: string, conversationId: string): Promise<void> {
  await audit({ tenantId, action: PAUSED_ACTION, target: conversationId });
}

/** Ends the pause: the tag goes, and a row dates the end, so a later pause is never judged from this one's start. */
export async function liftAiPause(tenantId: string, conversationId: string, tags: readonly string[], by: { action?: string; userId?: string } = {}): Promise<string[]> {
  const left = tags.filter((t) => t !== STOP_TAG);
  await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { tags: left } });
  await audit({ tenantId, userId: by.userId ?? null, action: by.action ?? LIFTED_ACTION, target: conversationId });
  return left;
}
