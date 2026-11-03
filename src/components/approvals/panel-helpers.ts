import type { Tone } from "@/components/ui/status";

/** What a client approval link is about, as the approvals API names it. */
export type ApprovalSubjectType = "creative_asset" | "creative_brief" | "ad_campaign" | "scheduled_post" | "optimizer_proposal";

export type ApprovalRow = { id: string; status: string; comment: string | null; expiresAt: string; decidedAt: string | null; createdAt: string };

export const approvalsPath = (subjectType: ApprovalSubjectType, subjectId: string) => `/api/approvals?subjectType=${encodeURIComponent(subjectType)}&subjectId=${encodeURIComponent(subjectId)}`;

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for your client", tone: "info" },
  approved: { label: "Approved", tone: "good" },
  changes_requested: { label: "Changes asked for", tone: "warn" },
  rejected: { label: "Declined", tone: "bad" },
  expired: { label: "Expired or withdrawn", tone: "neutral" },
};

export function approvalStatusView(status: string): { label: string; tone: Tone } {
  return STATUS[status] ?? { label: "Unknown", tone: "neutral" };
}

/** Only a link the client has not answered yet can be sent again or withdrawn. */
export const isOpenApproval = (status: string) => status === "pending";

export type ResendForm = { phone: string; mode: "text" | "template"; templateId: string };

export const TEMPLATE_MISSING = "Choose an approved template.";

/** What stops the WhatsApp send, in plain words, or null when the form is complete. */
export function resendProblem(form: ResendForm): string | null {
  const digits = form.phone.replace(/\D/g, "");
  if (!form.phone.trim()) return "Enter your client's WhatsApp number.";
  if (digits.length < 8 || digits.length > 15 || /[^\d\s+()-]/.test(form.phone)) return "Enter the number with its country code, like +91 98765 43210.";
  if (form.mode === "template" && !form.templateId) return TEMPLATE_MISSING;
  return null;
}

/** The body of POST /api/approvals/[id]/resend. */
export function resendBody(form: ResendForm): Record<string, string> {
  return form.mode === "template" ? { mode: "template", phone: form.phone.trim(), templateId: form.templateId } : { mode: "text", phone: form.phone.trim() };
}

/** "Sent 3 Nov, answered 4 Nov" and the like, for one row of the list. */
export function approvalDates(a: Pick<ApprovalRow, "createdAt" | "decidedAt" | "expiresAt" | "status">, locale?: string): string {
  const d = (iso: string) => new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  const sent = `Sent ${d(a.createdAt)}`;
  if (a.decidedAt) return `${sent}, answered ${d(a.decidedAt)}`;
  if (a.status === "pending") return `${sent}, link works until ${d(a.expiresAt)}`;
  return sent;
}
