import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { generateAngles } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export const maxDuration = 120;

/** POST (no body) -> { items: angles }. Costs 1 AI credit. Replaces angles that have no assets. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ items: await generateAngles(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}
