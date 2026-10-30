import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonObject } from "@/lib/contacts/http";
import { requestApproverForProposal } from "@/lib/optimizer/service";
import { listApprovals, pendingApprovalCount } from "@/lib/spend/approvals";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { HttpError, requireRole } from "@/lib/tenancy";

/*
 * /api/spend/approvals (docs/SPEND-CONTROLS-SPEC.md 7.3, 7.4, 8.1). Owner and admins only: team members see no requests.
 *
 * GET  ?status=pending (default: waiting and not expired, the "Waiting for you" card) | recent (the last 14 days, with what
 *      happened to each). Answers { approvals: ApprovalDTO[], waiting }. canApprove is true only for an approver (or, for a
 *      lowering suggestion, any admin); canDecline for any admin.
 * POST { proposalId } asks an approver to decide an optimizer suggestion that this admin may not approve themselves: it creates
 *      the spending request (or returns the one already waiting) and notifies the approvers. Answers { request }.
 */

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const status = new URL(request.url).searchParams.get("status") ?? "pending";
    if (status !== "pending" && status !== "recent") throw new HttpError(400, "status must be pending or recent.");
    const approvals = await listApprovals(actor.tenantId, { userId: actor.userId, role: actor.role }, { status });
    return spendJson({ approvals, waiting: await pendingApprovalCount(actor.tenantId) });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonObject(request);
    if (typeof body.proposalId !== "string" || !body.proposalId.trim() || body.proposalId.length > 64) throw new HttpError(400, "Choose the suggestion to ask about.");
    // Asking is not a raise (nothing changes until an approver decides), so it works in every workspace state.
    return spendJson({ request: await requestApproverForProposal(actor, body.proposalId.trim()) }, { status: 201 });
  } catch (e) {
    return spendErrorResponse(e);
  }
}
