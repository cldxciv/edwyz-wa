import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { assertTenantCanWrite } from "@/lib/billing";
import { readJsonObject } from "@/lib/contacts/http";
import { approverStatus, decideApproval, displayStatus, getApproval, toApprovalDTO } from "@/lib/spend/approvals";
import { spendErrorResponse, spendJson } from "@/lib/spend/http";
import { HttpError, requireRole } from "@/lib/tenancy";

/*
 * /api/spend/approvals/[id] (docs/SPEND-CONTROLS-SPEC.md 7.3, 7.4, 4.17).
 *
 * GET  one request (owner and admins).
 * POST { decision: "approve" | "decline" }, signed in, same origin.
 *  - Approving a raise needs an approver: the owner, or an admin the owner named. That is checked again at decision time.
 *    It is a raising operation, so it is the one place this route checks the paywall (402 in a locked workspace).
 *  - Declining, or deciding a lowering suggestion, needs any admin and works in every workspace state.
 *  - One tap is enough: the decision is one conditional update, so a double tap applies once and a request past its expiry
 *    is declined automatically instead.
 * Answers { approval: ApprovalDTO, status, text }.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const row = await getApproval(actor.tenantId, (await params).id);
    const check = await approverStatus(actor.tenantId, actor.userId);
    return spendJson({ approval: toApprovalDTO(row, { now: new Date(), viewer: { userId: actor.userId, role: check.role ?? actor.role, approver: check.approver } }) });
  } catch (e) {
    return spendErrorResponse(e);
  }
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const { id } = await params;
    const body = await readJsonObject(request);
    const decision = body.decision;
    if (decision !== "approve" && decision !== "decline") throw new HttpError(400, "Choose approve or decline.");
    if (decision === "approve") {
      const row = await getApproval(actor.tenantId, id);
      if (row.direction === "raise" && displayStatus(row, new Date()) === "pending" && (await approverStatus(actor.tenantId, actor.userId)).approver) {
        await assertTenantCanWrite(actor.tenantId);
      }
    }
    const result = await decideApproval(actor.tenantId, id, decision, "app", { type: "user", userId: actor.userId, role: actor.role });
    return spendJson(result);
  } catch (e) {
    return spendErrorResponse(e);
  }
}
