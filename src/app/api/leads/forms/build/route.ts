import { readJsonLimited } from "@/lib/http/body";
import { buildForm, leadFormErrorResponse } from "@/lib/promote/lead-forms";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

/**
 * POST { pageAssetId, spec } (admin; Eddy's create_lead_form, a confirm card: X, I). Makes an instant form on the Page and
 * registers it (docs/IG-PAGE-ADS-SPEC.md 3.5 step 2, 4.8, PRM-10). Meta's lead ad terms are checked first: when they are not
 * accepted the answer is 409 { error, code: "leadgen_tos", fix } and nothing is sent. A spec that can't be used is
 * 400 { error, problems }. Same-origin only, 403 for agents, 404 while Promote is hidden; fake ids under SPEND_DRY_RUN.
 */
export const POST = promoteRoute("write", async ({ actor, dryRun }, request) => {
  const body = await readJsonLimited(request, 64 * 1024);
  try {
    const form = await buildForm(actor, body.pageAssetId, body.spec, { dryRun });
    return Response.json({ form, dryRun }, { status: 201 });
  } catch (error) {
    const answer = leadFormErrorResponse(error);
    if (answer) return answer;
    throw error;
  }
});
