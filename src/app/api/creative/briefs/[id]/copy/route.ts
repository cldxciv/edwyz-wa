import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { generateCopy } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export const maxDuration = 120;

/** POST { angleId, placements? } -> 201 { items: copy assets with policyCheck }. Costs 1 AI credit. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ items: await generateCopy(actor.tenantId, (await params).id, await readJson(request)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
