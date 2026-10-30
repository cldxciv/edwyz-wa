import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { readJsonLimited } from "@/lib/http/body";
import { MAX_OPEN_LIMIT, setAvailability } from "@/lib/routing";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** PUT { available?: boolean, maxOpen?: number | null } for another agent (admin or owner) -> { availability } */
export async function PUT(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const { userId } = await params;
    const body = await readJsonLimited(request, 1024);
    const patch: { available?: boolean; maxOpen?: number | null } = {};
    if (body.available !== undefined) {
      if (typeof body.available !== "boolean") throw new HttpError(400, "available must be true or false.");
      patch.available = body.available;
    }
    if (body.maxOpen !== undefined) {
      const n = body.maxOpen;
      if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_OPEN_LIMIT)) throw new HttpError(400, `maxOpen must be null or a whole number from 1 to ${MAX_OPEN_LIMIT}.`);
      patch.maxOpen = n as number | null;
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to update.");
    return Response.json({ availability: await setAvailability(actor.tenantId, userId, patch) });
  } catch (e) {
    return errorResponse(e);
  }
}
