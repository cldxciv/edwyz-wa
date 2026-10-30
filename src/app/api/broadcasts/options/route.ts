import { getActor } from "@/lib/auth";
import { broadcastOptions } from "@/lib/broadcasts/options";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const raw = new URL(request.url).searchParams.get("tags") ?? "";
    const tags = [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))].slice(0, 50);
    return Response.json(await broadcastOptions(actor, tags), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
