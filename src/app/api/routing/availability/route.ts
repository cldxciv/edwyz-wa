import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { setAvailability } from "@/lib/routing";
import { HttpError, errorResponse } from "@/lib/tenancy";

/** PUT { available: boolean } (any member, own availability only) -> { availability } */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    const body = await readJsonLimited(request, 1024);
    if (typeof body.available !== "boolean") throw new HttpError(400, "available must be true or false.");
    return Response.json({ availability: await setAvailability(actor.tenantId, actor.userId, { available: body.available }) });
  } catch (e) {
    return errorResponse(e);
  }
}
