import { getActor } from "@/lib/auth";
import { isAiConfigured } from "@/lib/ai-configured";
import { usageSummary } from "@/lib/ai-agent/agents";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET -> { used, limit (null = unlimited or unset), remaining, replies, aiConfigured } for the current UTC month. Any member can read.
 * aiConfigured is false when this server has no AI key, so the page can say so instead of showing a budget that can never be used.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ ...(await usageSummary(actor.tenantId)), aiConfigured: isAiConfigured() });
  } catch (e) {
    return errorResponse(e);
  }
}
