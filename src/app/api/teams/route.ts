import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { getExtra } from "@/lib/routing";
import { createTeam, listTeams } from "@/lib/teams";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET (any member) -> { teams: { id, name, isDefault, memberIds, createdAt }[], leadStages: string[] }. The default team is created on first use. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [teams, extra] = await Promise.all([listTeams(actor.tenantId), getExtra(actor.tenantId)]);
    return Response.json({ teams, leadStages: extra.leadStages });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { name } (admin or owner) -> 201 { team } */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 2048);
    return Response.json({ team: await createTeam(actor, { name: body.name }) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
