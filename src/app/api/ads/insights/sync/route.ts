import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/db";
import { errorResponse, requireRole } from "@/lib/tenancy";
import { requestManualSync } from "@/lib/ads/insights-sync";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { nextAllowedAt } = await requestManualSync(actor.tenantId);
    await prisma.auditLog.create({ data: { tenantId: actor.tenantId, userId: actor.userId, action: "ads.insights.sync_requested" } });
    return Response.json({ queued: true, nextAllowedAt: nextAllowedAt.toISOString() }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}
