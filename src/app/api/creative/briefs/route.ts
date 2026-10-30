import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { createBrief, listBriefs } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

/** GET ?brandId= -> { items } */
export async function GET(request: Request) {
  try {
    const actor = await readActor(request);
    const brandId = new URL(request.url).searchParams.get("brandId") ?? undefined;
    return Response.json({ items: await listBriefs(actor.tenantId, brandId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { brandId, goal: leads|messages|traffic|awareness, offer, competitorNotes? } -> 201 { item } */
export async function POST(request: Request) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await createBrief(actor.tenantId, actor.userId, await readJson(request)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
