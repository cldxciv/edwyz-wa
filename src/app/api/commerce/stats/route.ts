import { getActor } from "@/lib/auth";
import { recoveryStats } from "@/lib/commerce/queries";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET ?storeId&days (default 30) -> recovery stats: totals, recovery rates, reminders sent, recovered value per currency in minor units. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const days = Number(params.get("days") ?? 30);
    return Response.json(await recoveryStats(actor.tenantId, { storeId: params.get("storeId") || undefined, days: Number.isFinite(days) ? days : 30 }));
  } catch (e) {
    return errorResponse(e);
  }
}
