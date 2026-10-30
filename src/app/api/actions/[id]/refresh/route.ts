import { cardRoute } from "@/lib/actions/card-http";
import { refreshAction } from "@/lib/actions/invoke";

/**
 * POST /api/actions/[id]/refresh { lang? } -> CardOutcome
 * [Refresh preview] on an expired card (docs/EDDY-SPEC.md 4.5, 6.13, EDDY-08): the preview is computed again and a new card
 * is returned, with no model call, so the 15-minute expiry never costs AI or loses work (WCAG 2.2.1).
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardRoute(request, params, ({ principal, actionId }) => refreshAction({ principal, actionId }));
}
