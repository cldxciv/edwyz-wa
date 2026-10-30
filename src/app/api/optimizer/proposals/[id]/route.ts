import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonObject } from "@/lib/contacts/http";
import { approveProposal, getProposal, rejectProposal, requestApproverForProposal, requestClientApproval, revertProposal } from "@/lib/optimizer/service";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ proposal: await getProposal(actor, (await params).id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Body: { action: "approve" | "reject" | "revert" | "request_approval" | "ask_approver", confirm?: true }. Approve and revert
 * need confirm: true. Approving a change that raises spending (or undoing a pause) needs the owner or a named approver
 * (docs/SPEND-CONTROLS-SPEC.md 7.3); any other admin can "ask_approver", which sends it to them as a spending request.
 * Refusals from the Spend Book come back with their code and figures.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { id } = await params;
    const body = await readJsonObject(request);
    switch (body.action) {
      case "approve":
        return Response.json({ proposal: await approveProposal(actor, id, body.confirm) });
      case "reject":
        return Response.json({ proposal: await rejectProposal(actor, id) });
      case "revert":
        if (body.confirm !== true) throw new HttpError(400, "Confirmation is required to revert a change.");
        return Response.json({ proposal: await revertProposal(actor, id) });
      case "request_approval":
        return Response.json({ approval: await requestClientApproval(actor, id) });
      case "ask_approver":
        return spendJson({ request: await requestApproverForProposal(actor, id) });
      default:
        throw new HttpError(400, "action must be approve, reject, revert, request_approval or ask_approver.");
    }
  } catch (e) {
    return spendErrorResponse(e);
  }
}
