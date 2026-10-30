import { bodyString, cardRoute } from "@/lib/actions/card-http";
import { cancelAction } from "@/lib/actions/invoke";

/**
 * POST /api/actions/[id]/cancel { nonce } -> CardOutcome
 * A card's Cancel button: pending -> cancelled (docs/EDDY-SPEC.md 4.5, EDDY-08). 404 for a wrong id, nonce or member, 410
 * when expired. The model learns the outcome from the next turn's context note, never from this call.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardRoute(request, params, ({ principal, actionId, body }) => cancelAction({ principal, actionId, nonce: bodyString(body, "nonce") }));
}
