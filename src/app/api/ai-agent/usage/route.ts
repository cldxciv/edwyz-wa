import { getActor } from "@/lib/auth";
import { isAiConfigured } from "@/lib/ai-configured";
import { hourlyReplyUse } from "@/lib/ai-agent";
import { usageSummary } from "@/lib/ai-agent/agents";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET -> { used, limit (null = unlimited or unset), remaining, replies, hour, aiConfigured } for the current UTC month. Any member can read.
 * hour is { used, limit, source }: AI replies in the last 60 minutes against the plan's AI replies per hour (owner decision 3).
 * aiConfigured is false when this server has no AI key, so the page can say so instead of showing a budget that can never be used.
 */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const [summary, hour] = await Promise.all([usageSummary(actor.tenantId), hourlyReplyUse(actor.tenantId)]);
    return Response.json({ ...summary, hour, aiConfigured: isAiConfigured() });
  } catch (e) {
    return errorResponse(e);
  }
}
