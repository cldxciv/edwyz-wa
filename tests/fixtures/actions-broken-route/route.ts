/**
 * A deliberately broken route for the action-layer guard tests (docs/EDDY-SPEC.md 4.8 tests 1 and 2, EDDY-07 acceptance 2).
 * It is never served (it lives under tests/), and nothing classifies it:
 * - tests/actions-route-coverage.test.ts proves an unclassified route fails, naming this file;
 * - tests/actions-role-parity.test.ts proves a definition weaker than its route's guard fails (GET needs an admin, DELETE an
 *   owner, while the self-test's definitions say agent).
 */
import { getActor } from "@/lib/auth";
import { errorResponse, requireRole } from "@/lib/tenancy";

export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "owner");
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
