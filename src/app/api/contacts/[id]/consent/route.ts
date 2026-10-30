import { getActor } from "@/lib/auth";
import { consentHistory } from "@/lib/contacts/consent";
import { errorResponse, hasRole } from "@/lib/tenancy";

type Ctx = { params: Promise<{ id: string }> };

/** Consent record for one contact: the current state and who recorded each change. Everyone can see it; only owners and admins see who. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await getActor(request);
    const { id } = await params;
    const history = await consentHistory(actor, id);
    const showWho = hasRole(actor, "admin");
    return Response.json(
      { ...history, events: history.events.map((e) => (showWho ? e : { ...e, by: e.by === "contact" ? "contact" : null })) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
