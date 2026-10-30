import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createAgent, listAgents } from "@/lib/ai-agent/agents";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { agents: AgentView[] }. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ agents: await listAgents(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, instructions, enabled?, phoneNumberId?, tone?, language?, activation?, noHumanReplyMinutes?, handoffKeywords?, maxRepliesPerConversation?, model? } (admin or owner) -> 201 { agent } */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const agent = await createAgent(actor.tenantId, actor.userId, await readJsonLimited(request, 32 * 1024));
    return Response.json({ agent }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
