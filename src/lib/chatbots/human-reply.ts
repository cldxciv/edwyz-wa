import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { parseSettings } from "./flow";

const LIVE = ["waiting", "active"] as const;

/**
 * A teammate just sent a message in this chat: ends every live chatbot session there whose bot is set to "stop when a teammate
 * replies" (the default), so the bot stops at that moment instead of when the customer next writes. Best effort and never throws,
 * so a problem here can never block the teammate's message. This module imports only the database, so the inbox send path can
 * call it without a circular import.
 */
export async function stopBotsOnHumanReply(tenantId: string, conversationId: string): Promise<number> {
  try {
    const live = await prisma.chatbotSession.findMany({ where: { tenantId, conversationId, status: { in: [...LIVE] } }, select: { id: true, chatbotId: true } });
    if (live.length === 0) return 0;
    const bots = await prisma.chatbot.findMany({ where: { tenantId, id: { in: [...new Set(live.map((s) => s.chatbotId))] } }, select: { id: true, publishedFlow: true } });
    const stops = new Set(bots.filter((b) => parseSettings((b.publishedFlow as { settings?: unknown } | null)?.settings).stopOnHumanReply).map((b) => b.id));
    const ids = live.filter((s) => stops.has(s.chatbotId)).map((s) => s.id);
    if (ids.length === 0) return 0;
    const { count } = await prisma.chatbotSession.updateMany({
      where: { tenantId, id: { in: ids }, status: { in: [...LIVE] } },
      data: { status: "handed_off", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
    });
    return count;
  } catch (error) {
    console.error("[chatbot] could not stop the chatbot after a teammate reply:", describeError(error));
    return 0;
  }
}

/**
 * An admin blocked these chats: every live chatbot session in them ends now, so a bot waiting for an answer or sleeping in a delay
 * never writes to a blocked contact. Best effort and never throws, like stopBotsOnHumanReply.
 */
export async function endBotsOnBlock(tenantId: string, conversationIds: string[]): Promise<number> {
  if (conversationIds.length === 0) return 0;
  try {
    const { count } = await prisma.chatbotSession.updateMany({
      where: { tenantId, conversationId: { in: conversationIds }, status: { in: [...LIVE] } },
      data: { status: "expired", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
    });
    return count;
  } catch (error) {
    console.error("[chatbot] could not end chatbot sessions after a block:", describeError(error));
    return 0;
  }
}
