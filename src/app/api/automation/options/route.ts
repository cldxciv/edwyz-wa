import { getActor } from "@/lib/auth";
import { getBuilderOptions } from "@/lib/automation/v2/service";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> templates, chatbots, sequences, teams, members, segments, reply materials and numbers for the rule builder. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json(await getBuilderOptions(actor.tenantId));
  } catch (e) {
    return errorResponse(e);
  }
}
