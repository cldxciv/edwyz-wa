import { getActor } from "@/lib/auth";
import { listExecutions } from "@/lib/automation/v2/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?ruleId=&outcome=ok|skipped|failed&cursor=&limit= -> { items, nextCursor }. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const q = new URL(request.url).searchParams;
    const limit = Number(q.get("limit"));
    return Response.json(
      await listExecutions(actor.tenantId, {
        ruleId: q.get("ruleId")?.slice(0, 64) || undefined,
        outcome: q.get("outcome") || undefined,
        cursor: q.get("cursor")?.slice(0, 64) || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
