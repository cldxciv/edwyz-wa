import type { Tone } from "@/components/ui";

export const EVENT_STATUSES = ["pending", "sent", "failed", "skipped"] as const;

const STATUS_VIEW: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting to send", tone: "info" },
  sent: { label: "Sent to Meta", tone: "good" },
  failed: { label: "Could not send", tone: "bad" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export function eventStatusView(status: string): { label: string; tone: Tone } {
  return STATUS_VIEW[status] ?? { label: status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown", tone: "neutral" };
}

/** Each status as it reads inside a sentence ("3 sent to Meta"), keeping Meta's capital, and the empty list's title for it. */
const STATUS_PHRASE: Record<string, { count: string; none: string }> = {
  pending: { count: "waiting to send", none: "Nothing is waiting to send" },
  sent: { count: "sent to Meta", none: "Nothing has been sent to Meta yet" },
  failed: { count: "could not be sent", none: "Nothing failed to send" },
  skipped: { count: "skipped", none: "Nothing was skipped" },
};

/** "2 waiting to send, 1 sent to Meta, 0 could not be sent, 0 skipped" for the Events card. */
export const eventCountsText = (counts: Record<string, number>) =>
  EVENT_STATUSES.map((s) => `${(counts[s] ?? 0).toLocaleString()} ${STATUS_PHRASE[s].count}`).join(", ");

/** Title of the empty list when the Status filter matches nothing. */
export const emptyStatusTitle = (status: string) => STATUS_PHRASE[status]?.none ?? `No ${eventStatusView(status).label.toLowerCase()} events`;

const EVENT_LABEL: Record<string, string> = { Lead: "New lead", QualifiedLead: "Qualified lead", Purchase: "Purchase", Contact: "New contact" };

export const eventLabel = (name: string) => EVENT_LABEL[name] ?? name;

const REASON: Record<string, string> = {
  disabled: "Conversions were switched off when this was due.",
  opted_out: "The customer asked not to be messaged, so nothing is sent about them.",
  no_dataset: "No dataset was connected, so there was nowhere to send it.",
  no_identifiers: "There was not enough contact detail for Meta to match this person.",
  tenant_blocked: "Your workspace was paused for too long, so the event was dropped.",
};

/** What a person reads for a skipped or failed event: a plain sentence for known reasons, the server text otherwise. */
export function reasonText(reason: string | null): string {
  if (!reason) return "";
  return REASON[reason] ?? reason;
}

/** The server only re-queues failed or skipped events. */
export const canRequeue = (status: string) => status === "failed" || status === "skipped";

export function friendlyError(e: unknown, fallback = "Something went wrong. Try again."): string {
  const message = e instanceof Error ? e.message.trim() : "";
  if (!message) return fallback;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "We could not reach the server. Check your connection and try again.";
  return message;
}
