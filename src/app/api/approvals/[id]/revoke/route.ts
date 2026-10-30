import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { errorResponse } from "@/lib/tenancy";
import { revokeApproval } from "@/lib/approvals";
import { loadOwnedApproval } from "@/lib/approvals/access";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await ctx.params;
    await loadOwnedApproval(actor, id);
    await revokeApproval(actor.tenantId, id, actor.userId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
