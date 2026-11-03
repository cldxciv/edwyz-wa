import type { TemplateStatus } from "@/generated/prisma/client";

const MAP: Record<string, TemplateStatus> = {
  APPROVED: "approved",
  PENDING: "pending",
  IN_APPEAL: "pending",
  REJECTED: "rejected",
  PAUSED: "paused",
  DISABLED: "disabled",
  // docs/SPEND-CONTROLS-SPEC.md 6.3: no longer treated as paused; marketing broadcasts and assistants stop using it.
  FLAGGED: "flagged",
  PENDING_DELETION: "disabled",
  // Deleted or archived in WhatsApp Manager: Meta refuses every send (132001), so it is never offered again.
  DELETED: "disabled",
  ARCHIVED: "disabled",
  // The account reached Meta's template limit before this one was created: it can be fixed and sent again like a rejected one.
  LIMIT_EXCEEDED: "rejected",
};

/** Unknown Meta statuses are treated as pending so a template is never sendable by accident. */
export function mapMetaStatus(status: unknown): TemplateStatus {
  return typeof status === "string" ? (MAP[status.toUpperCase()] ?? "pending") : "pending";
}
