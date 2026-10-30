import { handleAdmin, readBody } from "@/lib/admin/http";
import { applySpendAction, getTenantSpending } from "@/lib/admin/spending";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/*
 * GET  /api/admin/spending/[tenantId]: the workspace's live spending figures (the tenant page's Spending card).
 * POST /api/admin/spending/[tenantId] {action, reason, ...}: one of the 8.3 workspace actions (set_spend_ceiling,
 * clear_spend_ceiling, lower_spend_limits, lower_assistant_level, meta_limit_offboard, lift_probation, set_probation,
 * verify_workspace, freeze_spending, unfreeze_spending, clear_breaker, mark_test_ad_account, end_learning, resync_meta_limit).
 * Each needs a reason, is audited as admin.tenant.<action> and ledgered with actorType platform_admin.
 */
export async function GET(request: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  return handleAdmin(
    request,
    false,
    async ({ actor }) => {
      const view = await getTenantSpending(actor.userId, (await params).tenantId);
      if (!view) throw new HttpError(404, "Workspace not found.");
      return view;
    },
    "admin.api.view_tenant_spending",
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  return handleAdmin(request, true, async ({ actor }) => applySpendAction(actor.userId, (await params).tenantId, await readBody(request)));
}

export { adminMethodNotAllowed as PUT, adminMethodNotAllowed as PATCH, adminMethodNotAllowed as DELETE, adminMethodNotAllowed as OPTIONS } from "@/lib/admin/http";
