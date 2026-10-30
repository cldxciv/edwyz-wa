import { getActor } from "@/lib/auth";
import { listProposals } from "@/lib/optimizer/service";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const q = new URL(request.url).searchParams;
    const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
    const result = await listProposals(actor, {
      status: q.get("status") ?? undefined,
      kind: q.get("kind") ?? undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      cursor: q.get("cursor")?.slice(0, 40) ?? undefined,
    });
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
