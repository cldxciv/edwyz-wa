import { getActor } from "@/lib/auth";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { assertSameOrigin } from "@/lib/inbox/http";
import { assertCanActOnConversation } from "@/lib/inbox/status";
import { suggestReplies } from "@/lib/inbox/suggest";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST (no body) -> { drafts: string[] (up to 3), handoff, grounded, agentName }. Any member; 10 per minute per user.
 * Drafts come from the last messages and the workspace AI agent's knowledge. Nothing is sent. Uses one AI credit.
 * 503 "AI is not configured." without a key; 402 when the plan's credits are used up; 429 when rate limited.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    await assertConversationVisible(actor, id);
    await assertCanActOnConversation(actor, id);
    return Response.json(await suggestReplies(actor, id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
