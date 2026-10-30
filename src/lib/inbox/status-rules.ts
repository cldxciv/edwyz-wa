import { SERVICE_WINDOW_MS } from "./window";

export const STATUSES = ["open", "pending", "solved", "expired", "blocked"] as const;
export type ConversationStatus = (typeof STATUSES)[number];

/** Statuses an agent may pick by hand. expired is derived; blocked needs an admin. */
export const SETTABLE_STATUSES = ["open", "pending", "solved", "blocked"] as const;

const TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  open: ["pending", "solved", "blocked"],
  pending: ["open", "solved", "blocked"],
  solved: ["open", "pending", "blocked"],
  expired: ["open", "pending", "solved", "blocked"],
  blocked: ["open"],
};

/** Rows written before the status rename may still say "resolved". */
export function normalizeStatus(value: string): ConversationStatus | null {
  const v = value === "resolved" ? "solved" : value;
  return (STATUSES as readonly string[]).includes(v) ? (v as ConversationStatus) : null;
}

export function canTransition(from: string, to: string): boolean {
  const a = normalizeStatus(from);
  const b = normalizeStatus(to);
  if (!a || !b || b === "expired") return false;
  return a === b || TRANSITIONS[a].includes(b);
}

type Windowed = { status: string; lastInboundAt: Date | string | null; lastMessageAt?: Date | string };

/**
 * Expired = open or pending and more than 24 hours since the customer's last message. A reply from the business never extends the
 * window (only the customer's message does), so replying with a template to an expired chat leaves it expired until the customer writes
 * back. lastMessageAt is accepted for older callers and ignored. Nothing is stored: a new inbound message moves lastInboundAt forward
 * and the chat is open again by itself.
 */
export function deriveStatus(c: Windowed, now: Date = new Date()): ConversationStatus {
  const stored = normalizeStatus(c.status) ?? "open";
  if (stored !== "open" && stored !== "pending") return stored;
  if (!c.lastInboundAt) return stored;
  return now.getTime() - new Date(c.lastInboundAt).getTime() > SERVICE_WINDOW_MS ? "expired" : stored;
}
