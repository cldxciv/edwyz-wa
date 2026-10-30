import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { createRule } from "@/lib/automation/rules";
import { listRulesWithActivity } from "@/lib/automation/v2/service";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** GET -> { rules }: classic and v2 rules in running order, each with lastRun and runs30d. Any member can read. */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    return Response.json({ rules: await listRulesWithActivity(actor.tenantId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST rule fields (admin or owner) -> 201 { rule }. A body with version: 2, trigger, filters and actions creates a v2 rule. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ rule: await createRule(actor.tenantId, await readJsonLimited(request, 64 * 1024)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
