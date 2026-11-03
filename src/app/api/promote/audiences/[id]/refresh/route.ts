import { AudienceFixError, assertAudienceWriteRate, refreshAudience } from "@/lib/promote/audiences";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/promote/audiences/[id]/refresh (refresh_customer_audience, a confirm card): admins and owners, same origin, within
 * the 10 creates and refreshes an hour per workspace. A customer list queues its people for the upload task (usersreplace,
 * with the contacts consented now) and answers 202; one still sending answers how far it got, also 202. Any other audience
 * reads its status and size from Meta again (200). Meta's refusals come in plain words.
 */
export const POST = promoteRoute<Ctx>("write", async ({ actor, dryRun }, _request, { params }) => {
  const { id } = await params;
  await assertAudienceWriteRate(actor.tenantId);
  try {
    const result = await refreshAudience(actor, id, { dryRun });
    return Response.json(result, { status: !result.dryRun && result.upload?.state === "queued" ? 202 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AudienceFixError) return error.response();
    throw error;
  }
});
