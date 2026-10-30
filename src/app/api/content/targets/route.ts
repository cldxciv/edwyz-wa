import { getActor } from "@/lib/auth";
import { noStore } from "@/lib/content/http";
import { listTargets } from "@/lib/content/service";
import { errorResponse } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ targets: await listTargets(actor) }, { headers: noStore });
  } catch (e) {
    return errorResponse(e);
  }
}
