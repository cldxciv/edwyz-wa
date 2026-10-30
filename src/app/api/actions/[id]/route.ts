import { cardStateRoute } from "@/lib/actions/card-http";

/**
 * GET /api/actions/[id] -> { card: CardStateDTO }
 * The state of one of the member's own Eddy cards or done rows (docs/EDDY-SPEC.md 4.5, 8.4, EDDY-08), for a transcript that
 * reloads or a card whose outcome was unknown and has since been reconciled. Never returns the nonce; another member's
 * card is 404. Session only (no API keys), 30 reads a minute per member, no model call.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardStateRoute(request, params);
}
