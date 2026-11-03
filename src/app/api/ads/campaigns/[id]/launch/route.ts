import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { AdsMediaNotReadyError, launchCampaign } from "@/lib/ads/service";
import { readTextLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

/** The body is optional: `{ "acknowledgeSpecialCategoryTerms": true }` is the explicit second acknowledgement for a category-none campaign whose copy suggests housing, employment or credit. */
async function readOptionalBody(request: Request): Promise<Record<string, unknown>> {
  const text = (await readTextLimited(request, 2048)).trim();
  if (!text) return {};
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new HttpError(400, "The request body must be a JSON object.");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readOptionalBody(request);
    return Response.json({ campaign: await launchCampaign(actor, (await params).id, { acknowledgeSpecialCategoryTerms: body.acknowledgeSpecialCategoryTerms === true }) });
  } catch (e) {
    // 409 { error, code: "media_not_ready", mediaIds }: the media is still on its way to Meta, so the caller can wait and try again.
    if (e instanceof AdsMediaNotReadyError) return Response.json(e.toJSON(), { status: e.status });
    return errorResponse(e);
  }
}
