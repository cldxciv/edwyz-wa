import type { RzSubscription } from "./razorpay";

export type SubscriptionPatch = {
  status: "active" | "past_due" | "canceled" | "expired";
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  pastDueSince?: Date | null;
  cancelAtPeriodEnd?: boolean;
};

type Existing = { pastDueSince: Date | null; currentPeriodEnd: Date | null };

const fromUnix = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? new Date(v * 1000) : undefined);

/** Maps a Razorpay subscription entity to the local row changes. Returns null for states that change nothing locally. */
export function patchFromEntity(entity: Pick<RzSubscription, "status" | "current_start" | "current_end">, existing: Existing, now: Date): SubscriptionPatch | null {
  const start = fromUnix(entity.current_start);
  const end = fromUnix(entity.current_end);
  switch (entity.status) {
    case "active":
      return { status: "active", pastDueSince: null, ...(start ? { currentPeriodStart: start } : {}), ...(end ? { currentPeriodEnd: end } : {}) };
    case "pending":
    case "halted":
      return { status: "past_due", pastDueSince: existing.pastDueSince ?? now };
    case "cancelled":
      return { status: "canceled", cancelAtPeriodEnd: true, ...(existing.currentPeriodEnd ? {} : end ? { currentPeriodEnd: end } : {}) };
    case "completed":
    case "expired":
      return { status: "expired", ...(existing.currentPeriodEnd ? {} : end ? { currentPeriodEnd: end } : {}) };
    default:
      return null;
  }
}
