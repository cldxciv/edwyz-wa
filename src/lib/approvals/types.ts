export type ApprovalSubject = "creative_asset" | "creative_brief" | "ad_campaign" | "scheduled_post" | "optimizer_proposal";
export type ApprovalDecision = "approved" | "changes_requested" | "rejected";
export const DECISIONS: ApprovalDecision[] = ["approved", "changes_requested", "rejected"];
export const isDecision = (v: unknown): v is ApprovalDecision => typeof v === "string" && (DECISIONS as string[]).includes(v);
