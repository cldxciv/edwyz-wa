import { isAiConfigured } from "@/lib/ai-configured";
import { errorResponse } from "@/lib/tenancy";
import { readActor, type Ctx } from "@/lib/creative/http";
import { getBriefView } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

/** GET -> { item: brief with brand, angles and assets (each with the client's latest feedback), aiConfigured } */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await readActor(request);
    return Response.json({ item: await getBriefView(actor.tenantId, (await params).id), aiConfigured: isAiConfigured() });
  } catch (e) {
    return errorResponse(e);
  }
}
