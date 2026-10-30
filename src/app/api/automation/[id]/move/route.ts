import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { moveRule } from "@/lib/automation/v2/service";
import { readJsonLimited } from "@/lib/http/body";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

/** POST { direction: "up" | "down" } (admin or owner) -> { ok: true }: runs the rule one place earlier or later. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 1024);
    if (body.direction !== "up" && body.direction !== "down") throw new HttpError(400, "direction must be up or down.");
    await moveRule(actor.tenantId, (await params).id, body.direction);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
