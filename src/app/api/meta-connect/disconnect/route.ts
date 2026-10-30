import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { readJsonLimited } from "@/lib/http/body";
import { beforeDisconnect, disconnect, DisconnectBlockedError } from "@/lib/meta-connect/service";
import { errorResponse, HttpError, requireRole } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/*
 * POST { connectionId, force?, confirm?, metaLimitChoice? } (admin or owner, same origin).
 *
 * Disconnect protection (docs/SPEND-CONTROLS-SPEC.md 5.9): everything Edwyz runs on the connection's ad accounts is paused
 * first. If a pause failed, Meta's limit is set to stop the account (where Edwyz manages it) and the disconnect is refused
 * with 409 { code: "meta_connect.pause_failed", campaigns, canForce } and the in-app copy, unless the OWNER sends
 * force: true with confirm: "DISCONNECT". The 5.8 choice for Meta's limit (metaLimitChoice, default keep) is applied while
 * the token still works, and the answer names the limit that stays.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = (await readJsonLimited(request, 2 * 1024)) as { connectionId?: unknown; force?: unknown; confirm?: unknown; metaLimitChoice?: unknown };
    const { connectionId } = body;
    if (typeof connectionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) throw new HttpError(400, "Invalid connection.");
    const before = await beforeDisconnect(actor, connectionId, { force: body.force === true, confirm: body.confirm, metaLimitChoice: body.metaLimitChoice });
    const result = await disconnect(actor, connectionId);
    return Response.json({ ok: true, ...result, paused: before.paused, forced: before.forced, metaLimitText: before.metaLimitText });
  } catch (e) {
    if (e instanceof DisconnectBlockedError) {
      return Response.json({ error: e.message, code: e.code, campaigns: e.failedCampaigns, canForce: e.canForce }, { status: 409 });
    }
    return errorResponse(e);
  }
}
