import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJson } from "@/lib/auth/http";
import { clientIp } from "@/lib/auth/ratelimit";
import { UNVERIFIED_MESSAGE } from "@/lib/auth/verification";
import { createProject } from "@/lib/projects/create";
import { PROJECT_COPY, ProjectFieldError, projectNameFrom } from "@/lib/projects/rules";
import { HttpError, errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * POST { name } -> 201 { project: { id, name, slug } }. Any signed-in member: the new workspace belongs to them, as owner, with a
 * free trial (src/lib/projects/create.ts). It does not switch the session; the page calls POST /api/auth/switch-workspace next.
 * A refusal about the name answers { error, field: "name" } so the form shows it under the field.
 *
 * The state of the workspace the person is signed in to does not matter here (/api/projects is in getActor's paywall
 * exemptions, src/lib/auth/index.ts): the new project is not that workspace, and the rules of src/lib/projects/rules.ts (a
 * suspended project of theirs, the unpaid cap) are the ones that apply, exactly as the All projects page reports them.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request).catch((error: unknown) => {
      // An address that is not confirmed yet cannot start a project (the same rule as every other write), in this action's words.
      if (error instanceof HttpError && error.status === 403 && error.message === UNVERIFIED_MESSAGE) throw new HttpError(403, PROJECT_COPY.verify);
      throw error;
    });
    const name = projectNameFrom(await readJson(request));
    const created = await createProject(actor, name, clientIp(request));
    return Response.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ProjectFieldError) return Response.json({ error: e.message, field: e.field }, { status: e.status, headers: { "cache-control": "no-store" } });
    return errorResponse(e, request);
  }
}
