import { AudienceFixError, assertAudienceWriteRate, AUDIENCE_COPY, createAudience, listAudiences, previewCustomerList } from "@/lib/promote/audiences";
import { refuseCrossSite } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/promote/audiences (list_audiences, admin; docs/IG-PAGE-ADS-SPEC.md 3.7, 4.8): the workspace's audiences with their
 * status chip and size line, the kinds the flags offer now, and how many customer lists are used of 50.
 * GET /api/promote/audiences?preview=customer_list&segmentId=&tag=: how many contacts a customer list would include ("1,240 of
 * 1,610 contacts can be included."), for the confirm card. Reads the database only; nothing goes to Meta.
 * Hidden (404) while PROMOTE_ENABLED keeps the feature from this member.
 */
export const GET = promoteRoute(
  "read",
  async ({ actor }, request) => {
    refuseCrossSite(request);
    const p = new URL(request.url).searchParams;
    const preview = p.get("preview");
    if (preview !== null) {
      if (preview !== "customer_list") throw new HttpError(400, AUDIENCE_COPY.chooseKind);
      const count = await previewCustomerList(actor, { segmentId: p.get("segmentId") || undefined, tag: p.get("tag") || undefined });
      return Response.json({ count }, { headers: NO_STORE });
    }
    return Response.json(await listAudiences(actor), { headers: NO_STORE });
  },
  { minRole: "admin" },
);

/**
 * POST /api/promote/audiences {kind, …}: admins and owners, same origin, 10 creates and refreshes an hour per workspace. kind
 * chooses the action: saved (save_audience), engagement_instagram, engagement_page, engagement_lead_form and website
 * (create_audience), customer_list (create_customer_audience) and lookalike (create_lookalike). A customer list is made on Meta
 * here and its people are queued for the upload task: 202 with the count, never a wait for the upload. Missing Meta audience
 * terms answer 409 with the custom_audience_tos fix; a flagged audience 422; any other Meta refusal plain words. Under
 * SPEND_DRY_RUN Meta answers with fake ids and nothing Meta-backed is stored.
 */
export const POST = promoteRoute("write", async ({ actor, dryRun }, request) => {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, AUDIENCE_COPY.json);
  await assertAudienceWriteRate(actor.tenantId);
  try {
    const result = await createAudience(actor, body, { dryRun });
    const status = result.dryRun ? 200 : result.upload?.state === "queued" ? 202 : 201;
    return Response.json(result, { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof AudienceFixError) return error.response();
    throw error;
  }
});
