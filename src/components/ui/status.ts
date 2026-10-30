export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

/**
 * The one status-to-colour map for the whole product. Colour is never the only signal: pills always show the label.
 * good = finished or healthy, info = in motion or waiting on the system, warn = needs attention soon or a human decision,
 * bad = failed, blocked or lost, neutral = inactive, closed or not started.
 */
export const STATUS_TONE: Readonly<Record<string, Tone>> = {
  active: "good",
  applied: "good",
  approved: "good",
  completed: "good",
  connected: "good",
  delivered: "good",
  done: "good",
  enabled: "good",
  exempt: "good",
  live: "good",
  paid: "good",
  processed: "good",
  published: "good",
  qualified: "good",
  read: "good",
  resolved: "good",
  sent: "good",
  solved: "good",
  succeeded: "good",
  verified: "good",
  won: "good",

  contacted: "info",
  in_progress: "info",
  new: "info",
  open: "info",
  processing: "info",
  publishing: "info",
  queued: "info",
  running: "info",
  scheduled: "info",
  sending: "info",
  started: "info",
  trialing: "info",

  awaiting_approval: "warn",
  expiring: "warn",
  needs_attention: "warn",
  partial: "warn",
  past_due: "warn",
  paused: "warn",
  pending: "warn",
  proposed: "warn",
  retry: "warn",
  snoozed: "warn",
  unconfigured: "warn",

  blocked: "bad",
  disconnected: "bad",
  error: "bad",
  expired: "bad",
  failed: "bad",
  retrying: "warn",
  locked: "bad",
  lost: "bad",
  opted_out: "bad",
  rejected: "bad",
  revoked: "bad",
  suspended: "bad",
  unpaid: "bad",

  archived: "neutral",
  canceled: "neutral",
  closed: "neutral",
  disabled: "neutral",
  draft: "neutral",
  inactive: "neutral",
  not_started: "neutral",
  reverted: "neutral",
  stopped: "neutral",
  unknown: "neutral",
  void: "neutral",
};

export function normalizeStatus(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key === "cancelled" ? "canceled" : key;
}

export function statusTone(status: string | null | undefined): Tone {
  return STATUS_TONE[normalizeStatus(status)] ?? "neutral";
}

export function isKnownStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) in STATUS_TONE;
}

/** "in_progress" becomes "In progress". Sentence case, never raw snake_case in the UI. */
export function statusLabel(status: string | null | undefined): string {
  const words = normalizeStatus(status).replace(/_/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}
