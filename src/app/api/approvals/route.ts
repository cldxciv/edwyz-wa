import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError } from "@/lib/tenancy";
import { createApproval, getOptimizerClientDecision, listApprovals } from "@/lib/approvals";
import { authorizeSubject } from "@/lib/approvals/access";
import { isSubjectType } from "@/lib/approvals/summary";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    const params = new URL(request.url).searchParams;
    const subjectType = params.get("subjectType");
    const subjectId = params.get("subjectId");
    if (!isSubjectType(subjectType) || !subjectId) throw new HttpError(400, "subjectType and subjectId are required.");
    await authorizeSubject(actor, subjectType, subjectId);
    const approvals = await listApprovals(actor.tenantId, subjectType, subjectId);
    if (subjectType === "optimizer_proposal") return Response.json({ approvals, clientDecision: await getOptimizerClientDecision(actor.tenantId, subjectId) });
    return Response.json({ approvals });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Returns the public link once; it cannot be shown again (only a hash is stored). */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 4096);
    const { subjectType, subjectId, expiresInHours } = body;
    if (!isSubjectType(subjectType) || typeof subjectId !== "string" || !subjectId || subjectId.length > 100) throw new HttpError(400, "Choose something to send for approval.");
    if (expiresInHours !== undefined && typeof expiresInHours !== "number") throw new HttpError(400, "expiresInHours must be a number.");
    await authorizeSubject(actor, subjectType, subjectId);
    const created = await createApproval(actor.tenantId, { subjectType, subjectId, expiresInHours, createdByUserId: actor.userId });
    return Response.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
