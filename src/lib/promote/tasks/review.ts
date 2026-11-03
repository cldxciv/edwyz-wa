/**
 * Ad review status (docs/IG-PAGE-ADS-SPEC.md 3.9, 4.2 R1 and R2, PRM-08). The worker (../worker.ts) skips both while
 * PROMOTE_ENABLED=off. The work lives in ../review.ts and is loaded on the first run, so the worker module itself imports
 * neither the database nor the Graph client.
 * - promote.review, every 15 min: Edwyz's platform ads in review, with issues or not approved, ads not read yet (the
 *   open-review index of 0013), and started ads Meta last showed as paused, so the first answer after Start is read. Also
 *   reads back, once after launch, the effective placements and advantage_state_info.
 * - promote.review.sweep, every 2 h: every started ad of a running campaign, whatever Meta said last, so an ad Meta rejects
 *   after approving it is seen.
 */
export type ReviewTaskResult = { checked: number; changed: number; failed: number };

export async function runReviewSync(): Promise<ReviewTaskResult> {
  const { syncAdReviews } = await import("../review");
  return syncAdReviews("review");
}

export async function runReviewSweep(): Promise<ReviewTaskResult> {
  const { syncAdReviews } = await import("../review");
  return syncAdReviews("sweep");
}
