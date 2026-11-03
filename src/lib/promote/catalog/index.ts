/**
 * The capability catalog (docs/IG-PAGE-ADS-SPEC.md 1.1, 4.4 to 4.7, D22). Pure data and the two visibility filters:
 *
 * - availableGoals() and availablePlacements() apply D22: a row at verify state `docs` shows only with
 *   PROMOTE_EXPERIMENTAL=1 on a sandbox ad account; rows at `sandbox` or `live` show everywhere. PROMOTE_GOALS narrows the
 *   goals further, and the member's tier hides rows above it.
 * - catalogSpecs() is the JSON behind GET /api/promote/catalog (get_creative_specs; no Meta call).
 *
 * The flags are read through ./flags only when the caller passes no explicit value, so tests and routes can pass
 * PromoteAccess straight through.
 */
import { promoteExperimental, promoteGoals } from "../flags";
import type { AdFormat, GoalKey, PlacementKey, Tier, VerifyState } from "../types";
import { tierAllows } from "../types";
import { CTA_BY_GOAL } from "./cta";
import { CAROUSEL_MAX_CARDS, CAROUSEL_MIN_CARDS, FORMAT_SPECS, INSTAGRAM_CAPTION_MAX, INSTAGRAM_HASHTAGS_MAX } from "./formats";
import { formatsFor, GOALS, goalRow, sourcesFor, type GoalRow } from "./goals";
import { MAX_FORM_QUESTIONS } from "./lead-questions";
import { placementRow, validPositions, type PositionContext } from "./placements";
import { previewFormatFor } from "./preview-formats";
import { verifyStateOf } from "./verified";

export * from "./audience-events";
export * from "./breakdowns";
export * from "./cta";
export * from "./formats";
export * from "./goals";
export * from "./lead-questions";
export * from "./parity";
export * from "./placements";
export * from "./preview-formats";
export * from "./verified";

type Env = Record<string, string | undefined>;

export type CatalogAccess = {
  /** The workspace's spending ad account is a Meta sandbox account. */
  sandboxAccount: boolean;
  /** PROMOTE_EXPERIMENTAL (PromoteAccess.experimental already folds in the sandbox check; either works here). */
  experimental?: boolean;
  /** PROMOTE_GOALS (PromoteAccess.goals). */
  goals?: readonly GoalKey[];
  /** The member's disclosure tier; default More options (All settings needs the member's toggle, PRM-18). */
  tier?: Tier;
  /** Verify states; default catalog/verified.ts. Tests pass a stand-in for a regenerated file. */
  verified?: (id: string) => VerifyState;
  env?: Env;
};

/** D22: a row shows when it is proven (sandbox or live), or when experimental rows are allowed on a sandbox account. */
export function rowVisible(state: VerifyState, access: Pick<CatalogAccess, "sandboxAccount" | "experimental" | "env">): boolean {
  if (state === "sandbox" || state === "live") return true;
  const experimental = access.experimental ?? promoteExperimental(access.env);
  return experimental === true && access.sandboxAccount === true;
}

/** The goals a member may pick, in catalog order. */
export function availableGoals(access: CatalogAccess): GoalRow[] {
  const verified = access.verified ?? verifyStateOf;
  const allowed = new Set(access.goals ?? promoteGoals(access.env));
  const tier = access.tier ?? "more";
  return GOALS.filter((g) => allowed.has(g.key) && tierAllows(tier, g.tier) && rowVisible(verified(`goal.${g.key}`), access));
}

/** The positions a member may pick for a goal and format: validPositions() limited to visible rows (D22) and the tier. */
export function availablePlacements(goal: GoalKey, format: AdFormat, ctx: PositionContext & CatalogAccess): PlacementKey[] {
  const verified = ctx.verified ?? verifyStateOf;
  const tier = ctx.tier ?? "more";
  return validPositions(goal, format, { ...ctx, tier }).filter((k) => rowVisible(verified(`placement.${k}`), ctx));
}

/** The catalog as JSON for get_creative_specs: goals, formats, text limits, positions and calls to action. */
export function catalogSpecs(goal?: GoalKey) {
  const goals = goal ? [goalRow(goal)] : [...GOALS];
  return {
    goals: goals.map((g) => ({
      key: g.key,
      tier: g.tier,
      verify: g.verify,
      // The sources usable now: a post needs a proven boost button for goals whose button carries a value (V-P3).
      sources: sourcesFor(g.key),
      formats: g.formats,
      newFormats: formatsFor(g.key, "new"),
      calls: CTA_BY_GOAL[g.key].types,
      repliesOutsideEdwyz: g.repliesOutsideEdwyz,
      positions: validPositions(g.key, "single_image", { hasInstagramIdentity: true, tier: "all" }).map((k) => ({
        key: k,
        tier: placementRow(k).tier,
        preview: previewFormatFor(k),
      })),
    })),
    formats: FORMAT_SPECS,
    limits: {
      instagramCaption: INSTAGRAM_CAPTION_MAX,
      instagramHashtags: INSTAGRAM_HASHTAGS_MAX,
      carouselCards: { min: CAROUSEL_MIN_CARDS, max: CAROUSEL_MAX_CARDS },
      formQuestions: MAX_FORM_QUESTIONS,
    },
  };
}
