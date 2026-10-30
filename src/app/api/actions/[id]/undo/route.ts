import { cardRoute } from "@/lib/actions/card-http";
import { undoAction } from "@/lib/actions/invoke";

/**
 * POST /api/actions/[id]/undo { lang? } -> CardOutcome
 * A done row's [Undo] (docs/EDDY-SPEC.md 4.5, 6.4, EDDY-08): for the member who acted or an admin, inside the 15-minute
 * window, while the change still applies (409 "Someone changed it since" otherwise, 410 after the window). An inverse that
 * would message customers or spend comes back as a new card instead of running.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cardRoute(request, params, ({ principal, actionId }) => undoAction({ principal, actionId }));
}
