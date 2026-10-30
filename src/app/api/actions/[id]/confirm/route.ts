import { bodyString, cardRoute } from "@/lib/actions/card-http";
import { confirmAction } from "@/lib/actions/invoke";

/**
 * POST /api/actions/[id]/confirm { nonce, previewHash, lang? } -> CardOutcome
 * Called only by a card's Confirm button (docs/EDDY-SPEC.md 4.5, EDDY-08). The claim is one conditional UPDATE, so two
 * confirms with one nonce run the action once; G3 to G13 run again with the fresh member; a changed preview answers 409
 * with a new card. 404 for a wrong id, nonce, member or workspace; 410 when expired; 403 when the role dropped.
 * No model call: confirming costs no AI and works when the AI limit is used up.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardRoute(request, params, ({ principal, actionId, body }) => confirmAction({ principal, actionId, nonce: bodyString(body, "nonce"), previewHash: bodyString(body, "previewHash") }));
}
