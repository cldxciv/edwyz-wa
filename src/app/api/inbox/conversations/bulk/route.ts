import { getActor } from "@/lib/auth";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { bulkUpdate, parseBulkInput } from "@/lib/inbox/status";
import { visibleConversationIds } from "@/lib/teams/visibility";
import { errorResponse } from "@/lib/tenancy";

/**
 * POST { ids: string[<=100], action: "status", status } | { action: "assign", userId | null } | { action: "tag", add?: string[], remove?: string[] }
 * -> { updated: number, skipped: { id, reason }[] }
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const input = parseBulkInput(await readJson(request));
    const visible = await visibleConversationIds(actor, input.ids);
    const result = await bulkUpdate(actor, { ...input, ids: input.ids.filter((id) => visible.has(id)) });
    return Response.json({ ...result, skipped: [...result.skipped, ...input.ids.filter((id) => !visible.has(id)).map((id) => ({ id, reason: "not_found" }))] });
  } catch (e) {
    return errorResponse(e);
  }
}
