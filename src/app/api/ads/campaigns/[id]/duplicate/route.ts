import { duplicateCampaign } from "@/lib/ads/service";
import { readJsonObject } from "@/lib/contacts/http";
import { writeActor } from "@/lib/content/http";
import { errorResponse } from "@/lib/tenancy";

/**
 * POST { fixOf?: true | adId | adId[] } (admin; agents get 403; same origin only). duplicate_campaign (docs/IG-PAGE-ADS-SPEC.md
 * 3.9, 4.8, D25, D29): makes a local draft "Copy of …" of the campaign and answers 201 with its id. Nothing is sent to Meta.
 * With fixOf ([Fix the ad]), the copy of each named ad (true: every ad on Meta) records which ad it replaces, so starting the
 * copy pauses the original first. The body may be empty.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await writeActor(request);
    const body = request.body ? await readJsonObject(request) : {};
    return Response.json(await duplicateCampaign(actor, (await params).id, { fixOf: body.fixOf }), { status: 201 });
  } catch (e) {
    return errorResponse(e, request);
  }
}
