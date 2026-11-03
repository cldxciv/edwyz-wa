import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { createForm, listForms } from "@/lib/leads/service";
import { promoteEnabled } from "@/lib/promote/flags";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ items: await listForms(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { metaFormId, pageAssetId, name?, consentText?, consentAssumed? } (admin). Registers a lead form before its first lead so
 * consent settings apply from the first lead. While Promote is open to the caller it imports the Page's form instead (Eddy's
 * import_lead_form, E-R7): name, status and questions are read from Meta and it is stored as origin imported.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 8192);
    if (promoteEnabled() !== "off") {
      const { importFromRegisterRoute } = await import("@/lib/promote/lead-forms");
      const imported = await importFromRegisterRoute(actor, body);
      if (imported) return imported;
    }
    return Response.json({ form: await createForm(actor, body) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
