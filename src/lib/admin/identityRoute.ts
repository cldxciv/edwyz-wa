import { assertSameOrigin } from "@/lib/auth/csrf";
import { errorResponse } from "@/lib/tenancy";
import { type AdminIdentity, requireAdminIdentity } from "./auth";
import { readBody } from "./http";

/** For the enrolment and step-up endpoints only: the caller must be an allowlisted, verified admin but need not have passed step-up yet. */
export async function handleAdminIdentity(request: Request, fn: (id: AdminIdentity, body: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  try {
    const id = await requireAdminIdentity(request);
    assertSameOrigin(request);
    return await fn(id, await readBody(request));
  } catch (e) {
    return errorResponse(e);
  }
}
