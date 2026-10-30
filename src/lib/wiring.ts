import { registerChatbotSeams } from "@/lib/chatbots";
import { claimFor } from "@/lib/chatbots/seams";
import { prisma } from "@/lib/db";
import { assignConversation } from "@/lib/routing";
import { HttpError } from "@/lib/tenancy";

let wired = false;

/** Connects the chatbot engine to routing. Idempotent; call from every entry point that can run a bot (webhook processor, worker). */
export function wireModules(): void {
  if (wired) return;
  wired = true;
  registerChatbotSeams({
    async assign(tenantId, conversationId, target) {
      if (target === "round_robin") {
        await assignConversation(tenantId, conversationId, { force: true });
        return;
      }
      const member = await prisma.membership.findFirst({ where: { tenantId, userId: target }, select: { id: true } });
      if (!member) throw new HttpError(400, "That user is not a member of this workspace.");
      await claimFor(tenantId, conversationId, target);
    },
    // The engine has already set the status (and emitted the change); this only routes, unless the chat was left in a team queue on purpose.
    async handoff(tenantId, conversationId, opts) {
      if (opts?.queueOnly) return;
      await assignConversation(tenantId, conversationId);
    },
  });
}
