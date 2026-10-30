import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { optionalString, readJsonObject } from "@/lib/contacts/http";
import { previewSegmentFilter } from "@/lib/segments/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** How many contacts a filter reaches (and how many of them can receive marketing messages), with a few examples. Saves nothing. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const result = await previewSegmentFilter(actor, {
      segmentId: optionalString(body.segmentId, "segmentId", 100) || undefined,
      filter: body.filter as never,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
