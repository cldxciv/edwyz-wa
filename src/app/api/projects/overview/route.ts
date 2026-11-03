import { getActor } from "@/lib/auth";
import { loadProjectsOverview } from "@/lib/projects/overview";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET -> ProjectsOverview (src/lib/projects/types.ts): every live workspace the signed-in person belongs to (never a deleted
 * one), each with its role, plan or trial and end date, WhatsApp number, unread chats, new leads in 7 days and ad spend this
 * month. Any member, in every workspace state: it only reads.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const overview = await loadProjectsOverview({ userId: actor.userId, tenantId: actor.tenantId });
    return Response.json(overview, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e, request);
  }
}
