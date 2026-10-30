import { bodyString, cardRoute } from "@/lib/actions/card-http";
import { reviseAction } from "@/lib/actions/invoke";

/**
 * POST /api/actions/[id]/revise { nonce, edits, lang? } -> CardOutcome
 * A card's Edit then Save (docs/EDDY-SPEC.md 4.5, EDDY-08): only the definition's editable fields are accepted; the merged
 * arguments go through G3 to G14 again and a new card replaces the old one. No model call: free-form changes ("make it
 * shorter") go through the chat composer instead.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardRoute(request, params, ({ principal, actionId, body }) => {
    const edits = body.edits && typeof body.edits === "object" && !Array.isArray(body.edits) ? (body.edits as Record<string, unknown>) : {};
    return reviseAction({ principal, actionId, nonce: bodyString(body, "nonce"), edits });
  });
}
