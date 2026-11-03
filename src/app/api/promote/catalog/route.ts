import { availableGoals, catalogSpecs } from "@/lib/promote/catalog";
import { pageLang, promoteText } from "@/lib/promote/copy";
import { promoteRoute } from "@/lib/promote/route-guard";
import { isGoalKey } from "@/lib/promote/types";
import { HttpError } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * GET /api/promote/catalog?goal=&specs=1&lang= (get_creative_specs, instant; docs/IG-PAGE-ADS-SPEC.md 4.4 to 4.6, 4.8, D22).
 * { goals: [{key, tier, title, outcome, repliesOutsideEdwyz}], specs? }: the goals this member may pick (PROMOTE_GOALS, verify
 * states, sandbox rows only with PROMOTE_EXPERIMENTAL), and with specs=1 the formats, text limits, positions and calls to
 * action, for one goal or all. Static data: no Meta call and no database read beyond the guard. Team members (agents) may read.
 */
export const GET = promoteRoute("read", async ({ access }, request) => {
  const p = new URL(request.url).searchParams;
  const goal = p.get("goal");
  if (goal !== null && goal !== "" && !isGoalKey(goal)) throw new HttpError(400, "Choose a goal from the list.");
  const lang = pageLang(p.get("lang"), access.pageLangs);
  const goals = availableGoals({ sandboxAccount: access.experimental, experimental: access.experimental, goals: access.goals }).map((g) => ({
    key: g.key,
    tier: g.tier,
    title: promoteText(g.copy.title, {}, lang),
    outcome: promoteText(g.copy.outcome, {}, lang),
    repliesOutsideEdwyz: g.repliesOutsideEdwyz,
  }));
  const wantSpecs = p.get("specs") === "1" || p.get("specs") === "true";
  return Response.json({ goals, ...(wantSpecs ? { specs: catalogSpecs(goal && isGoalKey(goal) ? goal : undefined) } : {}) }, { headers: { "cache-control": "private, max-age=60" } });
});
