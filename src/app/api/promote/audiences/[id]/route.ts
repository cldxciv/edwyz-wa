import { AudienceFixError, deleteAudience, getAudience } from "@/lib/promote/audiences";
import { refuseCrossSite } from "@/lib/promote/geo";
import { promoteRoute } from "@/lib/promote/route-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "cache-control": "no-store" };

/** GET /api/promote/audiences/[id] (get_audience, admin): one audience of the workspace, with its status chip and size line. */
export const GET = promoteRoute<Ctx>(
  "read",
  async ({ actor }, request, { params }) => {
    refuseCrossSite(request);
    const { id } = await params;
    return Response.json({ audience: await getAudience(actor, id) }, { headers: NO_STORE });
  },
  { minRole: "admin" },
);

/**
 * DELETE /api/promote/audiences/[id] (delete_audience, a danger card): admins and owners, same origin. Deletes the audience on
 * Meta first (A6) and only then marks it deleted here; when Meta fails, nothing changes and the answer says why in plain words
 * (such as an ad set or a lookalike still using it). Works at every flag level.
 */
export const DELETE = promoteRoute<Ctx>("write", async ({ actor, dryRun }, _request, { params }) => {
  const { id } = await params;
  try {
    return Response.json(await deleteAudience(actor, id, { dryRun }), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AudienceFixError) return error.response();
    throw error;
  }
});
