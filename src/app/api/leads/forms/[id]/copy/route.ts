import { readJsonLimited } from "@/lib/http/body";
import { copyForm, leadFormErrorResponse } from "@/lib/promote/lead-forms";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { spec } (admin; Eddy's copy_lead_form, a confirm card: X, I). Meta doesn't let a live form change, so an edit makes a
 * new form on the same Page with the edited spec, linked to this one (copiedFromId). With no spec, the form is copied as it is.
 * The answers match POST /api/leads/forms/build.
 */
export const POST = promoteRoute<Ctx>("write", async ({ actor, dryRun }, request, { params }) => {
  const body = await readJsonLimited(request, 64 * 1024);
  try {
    const form = await copyForm(actor, (await params).id, body.spec, { dryRun });
    return Response.json({ form, dryRun }, { status: 201 });
  } catch (error) {
    const answer = leadFormErrorResponse(error);
    if (answer) return answer;
    throw error;
  }
});
