import { getActor } from "@/lib/auth";
import { getUsage } from "@/lib/reports/usage";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json(await getUsage(actor.tenantId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
