import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";

/**
 * The contact sent STOP: every chatbot session of theirs, in any chat, ends now, so a bot that is waiting or sleeping in a delay
 * can never message them again. Best effort and never throws. The engine also re-checks the opt-out before it sends anything.
 */
export async function endChatbotSessionsForContact(tenantId: string, contactId: string): Promise<number> {
  try {
    const { count } = await prisma.chatbotSession.updateMany({
      where: { tenantId, contactId, status: { in: ["waiting", "active"] } },
      data: { status: "completed", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
    });
    return count;
  } catch (error) {
    console.error("[chatbot] could not end chatbot sessions after an opt-out:", describeError(error));
    return 0;
  }
}
