import { getActor } from "@/lib/auth";
import { listLeads } from "@/lib/leads/service";
import { HttpError, errorResponse } from "@/lib/tenancy";
import { filtersFrom } from "./filters";

export const dynamic = "force-dynamic";

/**
 * GET ?status&formId&campaign&assignedToId&from&to&source&platform&test&cursor&limit -> { items, nextCursor }. Any member.
 * source: instant_form | ctwa | ctig | ctm | manual. platform: facebook | instagram | messenger | whatsapp | audience_network |
 * unknown | not_reported. test: true (only test leads) or false (none). Each item carries source, platform, isOrganic, isTest and
 * adsetMetaId.
 */
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
