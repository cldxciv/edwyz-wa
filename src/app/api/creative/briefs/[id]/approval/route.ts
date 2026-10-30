import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { sendForApproval } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

export const maxDuration = 120;

/** POST { assetId? } -> { approval: { id, url } }. Without assetId the whole brief is sent. Blocked items are refused (409). */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const actor = await writeActor(request);
    const input = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    const assetId = typeof input.assetId === "string" ? input.assetId : undefined;
    return Response.json({ approval: await sendForApproval(actor.tenantId, (await params).id, assetId) });
  } catch (e) {
    return errorResponse(e);
  }
}
