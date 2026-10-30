import { getActor } from "@/lib/auth";
import { acquireConnection, createInboxStream } from "@/lib/inbox/stream";
import { visibleIdsFilter } from "@/lib/teams/visibility";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET -> text/event-stream. `event: update` with data `{ "conversationIds": string[] }` when conversations or
 * messages change for the caller's workspace, limited to the chats the caller may see. No message content is sent. The server closes after 5 minutes;
 * EventSource reconnects on its own. 429 when the workspace already has 20 open streams.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const filter = (await visibleIdsFilter(actor)) ?? undefined;
    const release = acquireConnection(actor.tenantId);
    const body = createInboxStream({ tenantId: actor.tenantId, signal: request.signal, release, filter });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
