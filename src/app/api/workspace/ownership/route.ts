import { getActor } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { password, readJson, str } from "@/lib/auth/http";
import { transferOwnership } from "@/lib/auth/roles";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

const limiter = createLimiter(5, 15 * 60 * 1000, "ownership-transfer");

/** Owner only. Body: { userId, password, keepOwner? }. The caller becomes an admin unless keepOwner is true. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "owner");
    if (!(await limiter.consumeShared(`${actor.tenantId}:${actor.userId}`))) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
    const body = await readJson(request);
    const toUserId = str(body, "userId", "Member", 64);
    const given = password(body);
    if (body.keepOwner !== undefined && typeof body.keepOwner !== "boolean") throw new HttpError(400, "keepOwner must be true or false.");
    const result = await transferOwnership({ tenantId: actor.tenantId, fromUserId: actor.userId, toUserId, password: given, keepOwner: body.keepOwner === true });
    return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
