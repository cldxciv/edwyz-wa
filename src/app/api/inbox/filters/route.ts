import { getActor } from "@/lib/auth";
import { createSavedFilter, listSavedFilters } from "@/lib/inbox/filters";
import { assertSameOrigin, readJson } from "@/lib/inbox/http";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { filters: [{ id, name, query: { tab, tag?, q? }, shared, mine }] } the caller's own saved views plus the ones shared with the workspace */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ filters: await listSavedFilters(actor.tenantId, actor.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name, query: { tab, tag?, q? }, shared?: boolean } -> 201 { filter }. Sharing with the whole workspace needs an admin. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJson(request);
    return Response.json({ filter: await createSavedFilter(actor, body) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
