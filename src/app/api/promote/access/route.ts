import { promoteRead } from "@/lib/promote/route-guard";
import { errorResponse } from "@/lib/tenancy";

/**
 * GET: what the signed-in member may do with Instagram and Facebook Page ads (docs/IG-PAGE-ADS-SPEC.md 1.4, 9.7, PRM-00):
 * { access: { visible, canWrite, canStart, audiences, video, previews, goals, experimental, pageLangs } }. The ads pages read it
 * to decide what to show. 404 while the feature is hidden from this member (PROMOTE_ENABLED=off, or admins for anyone who is
 * not an Edwyz platform admin). Agents may read it. Classified by the /api/promote/** entry of src/lib/actions/not-exposed.ts.
 */
export async function GET(request: Request) {
  try {
    const { access } = await promoteRead(request);
    return Response.json({ access }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, request);
  }
}
