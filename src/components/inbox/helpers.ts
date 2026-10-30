export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessageStatus = "received" | "queued" | "sent" | "delivered" | "read" | "failed";

export type InboxMessage = {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  templateName: string | null;
  status: MessageStatus;
  errorCode: string | null;
  createdAt: string;
};

/** Milliseconds left in the 24-hour service window, 0 when closed or never opened. */
export function windowRemainingMs(lastInboundAt: string | Date | null | undefined, now: Date = new Date()): number {
  if (!lastInboundAt) return 0;
  const left = new Date(lastInboundAt).getTime() + WINDOW_MS - now.getTime();
  return Math.min(Math.max(left, 0), WINDOW_MS);
}

export function formatWindowRemaining(ms: number): string {
  if (ms <= 0) return "Window closed";
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m left`;
  return `${hours}h ${minutes}m left`;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function dayLabel(date: Date, now: Date = new Date()): string {
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export type DayGroup<T> = { key: string; label: string; messages: T[] };

/** Groups messages (any order) into oldest-first local-calendar-day groups. */
export function groupMessagesByDay<T extends { createdAt: string }>(messages: T[], now: Date = new Date()): DayGroup<T>[] {
  const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const groups: DayGroup<T>[] = [];
  for (const m of sorted) {
    const date = new Date(m.createdAt);
    const key = dayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.messages.push(m);
    else groups.push({ key, label: dayLabel(date, now), messages: [m] });
  }
  return groups;
}

export function truncatePreview(text: string | null | undefined, max = 60): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(max - 1, 0)).trimEnd()}…`;
}

export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const date = new Date(iso);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function statusLabel(status: MessageStatus): string {
  switch (status) {
    case "queued":
      return "Sending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "read":
      return "Read";
    case "failed":
      return "Failed";
    default:
      return "";
  }
}

export function statusTicks(status: MessageStatus): string {
  return { queued: "…", sent: "✓", delivered: "✓✓", read: "✓✓", failed: "!", received: "" }[status];
}

/** A readable label for non-text messages; media itself is not downloadable yet. */
export function attachmentLabel(m: Pick<InboxMessage, "type" | "mediaMime" | "templateName">): string | null {
  if (m.type === "template") return `Template${m.templateName ? `: ${m.templateName}` : ""}`;
  if (["image", "document", "audio", "video", "sticker"].includes(m.type)) {
    return `Media message (${m.type}${m.mediaMime ? `, ${m.mediaMime}` : ""})`;
  }
  return null;
}

/** Merges message lists by id, keeping the latest copy of each. */
export function mergeById<T extends { id: string }>(...lists: T[][]): T[] {
  const map = new Map<string, T>();
  for (const list of lists) for (const item of list) map.set(item.id, item);
  return [...map.values()];
}

export type FilterKey =
  | "all"
  | "new"
  | "unread"
  | "mine"
  | "unassigned"
  | "open"
  | "pending"
  | "solved"
  | "expired"
  | "favorite"
  | "campaign"
  | "mentioned"
  | "active"
  | "blocked";

export const FILTER_TABS: { key: FilterKey; label: string; hint?: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New", hint: "The customer wrote and nobody on your team has replied yet" },
  { key: "unread", label: "Unread" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "open", label: "Open" },
  { key: "pending", label: "Pending" },
  { key: "solved", label: "Solved" },
  { key: "expired", label: "Expired", hint: "The customer's last message is more than 24 hours old" },
  { key: "favorite", label: "Favorites" },
  { key: "campaign", label: "Campaigns", hint: "The last thing they got was a broadcast and they have not replied" },
  { key: "mentioned", label: "Mentioned", hint: "A teammate mentioned you in a note" },
  { key: "active", label: "Active", hint: "The 24-hour reply window is open" },
  { key: "blocked", label: "Blocked" },
];

export const FILTER_KEYS: readonly FilterKey[] = FILTER_TABS.map((t) => t.key);

export function filterToQuery(filter: FilterKey): Record<string, string> {
  switch (filter) {
    case "mine":
      return { assigned: "me" };
    case "unassigned":
      return { assigned: "unassigned" };
    case "open":
    case "pending":
    case "solved":
    case "blocked":
      return { status: filter };
    case "expired":
      return { expired: "1" };
    case "unread":
      return { unread: "1" };
    case "new":
    case "favorite":
    case "campaign":
    case "mentioned":
    case "active":
      return { view: filter };
    default:
      return {};
  }
}

export function titleWithUnread(base: string, unread: number): string {
  return unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
}

/** Reconnect delay for the live stream: 2s, 4s, 8s ... capped at 60s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2000 * 2 ** Math.max(attempt, 0), 60_000);
}

/** An update with no ids is a resync request and matches everything. */
export function updateMatches(ids: string[], conversationId?: string): boolean {
  return ids.length === 0 || !conversationId || ids.includes(conversationId);
}

/** "connecting" until the live stream has opened once, "sse" while it is open, "polling" only after it failed. */
export type StreamMode = "connecting" | "sse" | "polling";

/** Polls every 2 seconds while the stream is not open; a slow safety poll while it is, for changes the stream does not announce (tags, read marks). */
export const FALLBACK_POLL_MS = 2000;
export const SAFETY_POLL_MS = 30_000;

export function pollIntervalFor(mode: StreamMode): number {
  return mode === "sse" ? SAFETY_POLL_MS : FALLBACK_POLL_MS;
}

/** The small status badge next to the inbox title. Only a real failure is shown in amber. */
export function streamBadge(mode: StreamMode): { label: string; title: string; dot: string } {
  switch (mode) {
    case "sse":
      return { label: "Live", title: "Live updates on", dot: "bg-emerald-500" };
    case "polling":
      return { label: "Polling", title: "Live stream unavailable, refreshing every 2 seconds", dot: "bg-amber-500" };
    default:
      return { label: "Connecting…", title: "Connecting to live updates", dot: "bg-muted" };
  }
}

export function toggleId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

export const BULK_LIMIT = 100;

export function selectAllVisible(ids: string[]): string[] {
  return ids.slice(0, BULK_LIMIT);
}

export const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "solved", label: "Solved" },
] as const;

export function statusDisplay(status: string): string {
  const key = status === "resolved" ? "solved" : status;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "j / k", action: "Move down / up the list" },
  { keys: "Enter", action: "Open the highlighted conversation" },
  { keys: "e", action: "Mark solved" },
  { keys: "a", action: "Assign to me" },
  { keys: "p", action: "Mark pending" },
  { keys: "o", action: "Reopen" },
  { keys: "x", action: "Select or unselect for bulk actions" },
  { keys: "/", action: "Go to the message box" },
  { keys: "f", action: "Search conversations" },
  { keys: "Esc", action: "Clear selection or close a panel" },
  { keys: "?", action: "Show this help" },
];

export const COMPOSER_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Enter", action: "Send (or new line, see the setting under the message box)" },
  { keys: "Shift + Enter", action: "New line" },
  { keys: "Ctrl / Cmd + Enter", action: "Always sends" },
  { keys: "/ at the start", action: "Quick replies and templates" },
  { keys: ":smile:", action: "Emoji shortcodes" },
];

export type ShortcutAction = "next" | "prev" | "enter" | "solve" | "assign" | "pending" | "open" | "select" | "composer" | "search" | "escape" | "help";

const INTERACTIVE = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY", "DIALOG"];

/** Maps a key press to an action; null while typing in a field or when a modifier is held. */
export function shortcutFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetTag?: string; editable?: boolean }): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const typing = e.editable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.targetTag ?? "");
  if (e.key === "Escape") return "escape";
  if (typing) return null;
  if (e.key === "Enter") return INTERACTIVE.includes(e.targetTag ?? "") ? null : "enter";
  switch (e.key) {
    case "j": return "next";
    case "k": return "prev";
    case "e": return "solve";
    case "a": return "assign";
    case "p": return "pending";
    case "o": return "open";
    case "x": return "select";
    case "/": return "composer";
    case "f": return "search";
    case "?": return "help";
    default: return null;
  }
}

/** Index to move to from the current one, clamped; -1 current means first. */
export function stepIndex(current: number, delta: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (current < 0) return 0;
  return Math.min(Math.max(current + delta, 0), length - 1);
}
