import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { refreshConnection } from "@/lib/meta-connect/service";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { connectionId } = await readJsonLimited(request, 2 * 1024);
    if (typeof connectionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) throw new HttpError(400, "Invalid connection.");
    const result = await refreshConnection(actor, connectionId);
    return Response.json({ ok: true, ...(result ?? {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
