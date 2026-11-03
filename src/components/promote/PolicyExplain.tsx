"use client";

/**
 * PolicyExplain (docs/IG-PAGE-ADS-SPEC.md 3.9, 4.10, 7.3): Meta's review reasons in plain words, from
 * review-reasons.ts explainReviewFeedback, each with exactly one fix button:
 *
 * - edit_text, edit_media, edit_link: "Edit the text", "Change the picture or video", "Change the link" (onFix opens the
 *   edited copy at that field, D29);
 * - set_category: "Mark it as about loans or credit" (onFix opens the copy with the category set);
 * - appeal: "Ask Meta to review again", an OpensMetaButton to Meta's appeal screen when the server passes its address from
 *   the allowlist (meta-screens.ts), else a button that calls onFix.
 *
 * A reason Meta gave for one platform says so ("On Instagram"). Each reason has an icon and its sentence, never colour alone.
 */
import { useId } from "react";
import { buttonVariants, cn } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import { explainReviewFeedback, type AdReviewFeedback, type ExplainedReason } from "@/lib/promote/review-reasons";
import type { PromoteLang } from "@/lib/promote/types";
import { policyFixLabel, policyWhere } from "./creative-helpers";
import { OpensMetaButton } from "./OpensMetaButton";

export const POLICY_EXPLAIN_TEST_ID = "policy-explain";

export type PolicyExplainProps = {
  /** Meta's ad_review_feedback; ignored when `reasons` is given. */
  feedback?: AdReviewFeedback | null;
  /** Reasons the server already explained (GET /api/ads/campaigns/[id]/review-status). */
  reasons?: readonly ExplainedReason[] | null;
  onFix: (reason: ExplainedReason) => void;
  /** Meta's appeal screen, resolved on the server from the Opens Meta allowlist. */
  appealHref?: string | null;
  /** The reason whose fix is running (its button shows a spinner). */
  busyCode?: string | null;
  lang?: PromoteLang;
  className?: string;
};

/** The fix button; long labels ("Mark it as about social issues, elections or politics") wrap at 360 px. */
const fixButton = cn(
  "inline-flex min-h-10 max-w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-left text-sm font-semibold transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress pointer-coarse:min-h-11",
  buttonVariants.secondary,
);

function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" focusable="false">
      <path d="M8 1.8 15 14H1L8 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 6.2v3.6M8 11.6v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function PolicyExplain({ feedback, reasons, onFix, appealHref, busyCode, lang = "en", className }: PolicyExplainProps) {
  const headingId = useId();
  const list = reasons ?? explainReviewFeedback(feedback ?? null, lang);
  if (list.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={POLICY_EXPLAIN_TEST_ID}>
      <h3 id={headingId} className="text-base font-semibold">
        {promoteText("policy.title", {}, lang)}
      </h3>
      <ul className="flex flex-col gap-3">
        {list.map((r, i) => {
          const where = policyWhere(r.placement, lang);
          const label = policyFixLabel(r, lang);
          const testId = `policy-fix-${r.code}`;
          return (
            <li key={`${r.code}-${r.placement ?? "all"}-${i}`} className="rounded-card border border-bad-line bg-bad-soft p-3 text-bad-fg" data-testid={`policy-reason-${r.code}`}>
              <div className="flex items-start gap-2">
                <WarnIcon />
                <div className="min-w-0 flex-1">
                  {where && <p className="text-xs font-semibold">{where}</p>}
                  <p className="text-sm break-words">{r.sentence}</p>
                </div>
              </div>
              <div className="mt-3">
                {r.fix === "appeal" && appealHref ? (
                  <OpensMetaButton href={appealHref} screen={r.opensMeta} label={label} lang={lang} data-testid={testId} />
                ) : (
                  <button
                    type="button"
                    className={fixButton}
                    disabled={busyCode === r.code}
                    aria-busy={busyCode === r.code || undefined}
                    onClick={() => onFix(r)}
                    data-testid={testId}
                  >
                    {busyCode === r.code && <span aria-hidden className="ui-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent" />}
                    {label}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default PolicyExplain;
