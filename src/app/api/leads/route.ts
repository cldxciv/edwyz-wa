import { getActor } from "@/lib/auth";
import { listLeads } from "@/lib/leads/service";
import { HttpError, errorResponse } from "@/lib/tenancy";
import { filtersFrom } from "./filters";

export const dynamic = "force-dynamic";

/** GET ?status&formId&campaign&assignedToId&from&to&cursor&limit -> { items, nextCursor }. Any member. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) throw new HttpError(400, "limit must be an integer.");
    return Response.json(await listLeads(actor.tenantId, { ...filtersFrom(params), cursor: params.get("cursor") || undefined, limit }));
  } catch (e) {
    return errorResponse(e);
  }
}
