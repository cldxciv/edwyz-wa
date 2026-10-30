import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { audiencePreview } from "@/lib/broadcasts/options";
import { optionalString, readJsonObject, stringArray } from "@/lib/contacts/http";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** Live preview for the broadcast wizard: how many opted-in contacts a tag, segment and filter combination reaches, with a few examples. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    const preview = await audiencePreview(actor, stringArray(body.tags, "tags") ?? [], {
      segmentId: optionalString(body.segmentId, "segmentId", 100) || undefined,
      filter: body.filter as never,
    });
    return Response.json(preview, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
