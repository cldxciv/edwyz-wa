import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { setTeamMembers } from "@/lib/teams";
import { errorResponse, requireRole } from "@/lib/tenancy";

/** PUT { userIds: string[] } (admin or owner): replaces the member list -> { memberIds } */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    const body = await readJsonLimited(request, 32 * 1024);
    return Response.json({ memberIds: await setTeamMembers(actor, id, body.userIds) });
  } catch (e) {
    return errorResponse(e);
  }
}
