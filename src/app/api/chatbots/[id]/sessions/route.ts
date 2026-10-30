import { getActor } from "@/lib/auth";
import { listSessions } from "@/lib/chatbots/service";
import { intParam } from "@/lib/inbox/http";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET ?status=&cursor=&limit= -> { items: [session without variables], nextCursor }. Any member can read, but only the sessions of
 * chats they may see (team visibility and assigned-only rules of the inbox); phone numbers are masked when the inbox masks them.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor(request);
    const q = new URL(request.url).searchParams;
    const result = await listSessions(
      actor.tenantId,
      (await params).id,
      {
        status: q.get("status") ?? undefined,
        cursor: q.get("cursor") ?? undefined,
        limit: intParam(q.get("limit")),
      },
      actor,
    );
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
