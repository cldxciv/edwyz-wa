import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { updateForm } from "@/lib/leads/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** PATCH { consentText?: string | null, name?: string | null, consentAssumed?: boolean } (admin). Consent text is stored as evidence only for leads that answered a consent field, or, when consentAssumed is true, for every lead of a form whose Meta definition shows no consent question (an unreadable definition never assumes consent). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8192);
    return Response.json({ form: await updateForm(actor, (await params).id, { consentText: body.consentText, name: body.name, consentAssumed: body.consentAssumed }) });
  } catch (e) {
    return errorResponse(e);
  }
}
