import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { runResearch } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export const maxDuration = 120;

/** POST (no body) -> { item: researchSummary }. Costs 1 AI credit. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await runResearch(actor.tenantId, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}
