import { getActor } from "@/lib/auth";
import { campaignOverview } from "@/lib/broadcasts/overview";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const raw = Number(new URL(request.url).searchParams.get("days") ?? 30);
    const days = Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 30;
    return Response.json(await campaignOverview(actor, days), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
