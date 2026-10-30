import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { updateAngle } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

/** PATCH { selected?, hook?, audience?, cta?, rationale? } -> { item } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    return Response.json({ item: await updateAngle(actor.tenantId, (await params).id, await readJson(request)) });
  } catch (e) {
    return errorResponse(e);
  }
}
