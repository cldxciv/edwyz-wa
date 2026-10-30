import { getActor } from "@/lib/auth";
import { listMentions } from "@/lib/inbox/marks";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { mentions: [{ conversationId, contactName, phone, mentionedAt }] } the signed-in agent's unread @mentions, newest first */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ mentions: await listMentions(actor) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
