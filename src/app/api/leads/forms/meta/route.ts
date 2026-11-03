import { listMetaForms } from "@/lib/promote/lead-forms";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

/**
 * GET ?pageAssetId= (admin; Eddy's list_lead_forms, instant). This workspace's forms on the Page, and the Page's forms on Meta
 * (L1), each marked with the local form it matches. Nothing is registered: picking one imports it through POST /api/leads/forms.
 * 404 while Promote is hidden, 403 for agents. Under SPEND_DRY_RUN the Meta list is empty and nothing is read from Meta.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor, dryRun }, request) => {
    const pageAssetId = new URL(request.url).searchParams.get("pageAssetId");
    return Response.json(await listMetaForms(actor, pageAssetId, { dryRun }), { headers: { "cache-control": "no-store" } });
  },
  { minRole: "admin" },
);
