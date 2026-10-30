export type KpiId = "messages" | "conversations" | "response" | "open";

export type Kpi = {
  id: KpiId;
  label: string;
  /** Headline number: a count, or seconds for the response-time tile. Null when there is nothing to show yet. */
  value: number | null;
  unit: "count" | "seconds";
  /** One entry per day, oldest first. Null entries are days with no data. Null series means the tile has no history. */
  series: (number | null)[] | null;
  /** Change against the previous period in percent, null when it cannot be worked out. */
  deltaPct: number | null;
  /** Which direction is good news: more messages is good, a slower reply is not. */
  betterWhen: "up" | "down";
  href: string;
  note: string | null;
  unavailable: boolean;
};

export type AttentionSeverity = "urgent" | "warn" | "info";

export type AttentionItem = {
  id: "unassigned" | "waiting" | "failed" | "templates" | "token";
  severity: AttentionSeverity;
  title: string;
  detail: string;
  href: string;
  cta: string;
  count: number;
};

export type QueueItem = { id: string; name: string; waitingSeconds: number; assignedTo: string | null };

export type ConnectionHealth = { status: string; tokenExpiresAt: Date | null };

export const TOKEN_WARN_DAYS = 7;
const DAY_MS = 86_400_000;

export const sum = (values: (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** Percent change from previous to current, rounded. Null when there is no previous figure to compare with. */
export function trendPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function contactLabel(name: string | null | undefined, phone: string | null | undefined, username?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (!phone && username?.trim()) return `@${username.trim().replace(/^@+/, "")}`;
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `Contact ending ${digits.slice(-4)}` : "Unnamed contact";
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(seconds / 86_400);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Worst connection first: expired or revoked beats expiring soon. Null when every connection is healthy. */
export function connectionAlert(connections: ConnectionHealth[], now = new Date()): { kind: "expired" | "expiring"; count: number; days: number | null } | null {
  let expired = 0;
  let soonest: number | null = null;
  let expiring = 0;
  for (const c of connections) {
    const ms = c.tokenExpiresAt ? c.tokenExpiresAt.getTime() - now.getTime() : null;
    if (c.status === "expired" || c.status === "revoked" || c.status === "error" || (ms !== null && ms <= 0)) {
      expired += 1;
    } else if (c.status === "expiring" || (ms !== null && ms <= TOKEN_WARN_DAYS * DAY_MS)) {
      expiring += 1;
      if (ms !== null) soonest = soonest === null ? ms : Math.min(soonest, ms);
    }
  }
  if (expired > 0) return { kind: "expired", count: expired, days: null };
  if (expiring > 0) return { kind: "expiring", count: expiring, days: soonest === null ? null : Math.max(1, Math.ceil(soonest / DAY_MS)) };
  return null;
}

export type AttentionInput = {
  unassigned: number;
  waiting: { count: number; oldest: QueueItem | null };
  failedSends: number;
  rejectedTemplates: { count: number; names: string[] };
  connection: ReturnType<typeof connectionAlert>;
};

const SEVERITY_RANK: Record<AttentionSeverity, number> = { urgent: 0, warn: 1, info: 2 };

/** Turns raw counts into the "needs attention" list. Items with nothing to report are left out; the most urgent come first. */
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { waiting, rejectedTemplates: rejected, connection } = input;

  if (waiting.count > 0 && waiting.oldest) {
    const wait = formatWait(waiting.oldest.waitingSeconds);
    items.push({
      id: "waiting",
      severity: waiting.oldest.waitingSeconds >= 4 * 3600 ? "urgent" : "warn",
      title: `${plural(waiting.count, "customer")} waiting for a reply`,
      detail: `The longest wait is ${wait}.`,
      href: "/app/inbox",
      cta: "Open inbox",
      count: waiting.count,
    });
  }
  if (input.unassigned > 0) {
    items.push({
      id: "unassigned",
      severity: "warn",
      title: `${plural(input.unassigned, "chat")} with nobody assigned`,
      detail: "Give each chat an owner so it does not get missed. Chat routing can do this for you.",
      href: "/app/inbox",
      cta: "Assign chats",
      count: input.unassigned,
    });
  }
  if (input.failedSends > 0) {
    items.push({
      id: "failed",
      severity: "warn",
      title: `${plural(input.failedSends, "message")} could not be delivered today`,
      detail: "These did not reach the customer. Reports shows the reason for each.",
      href: "/app/reports",
      cta: "See why",
      count: input.failedSends,
    });
  }
  if (rejected.count > 0) {
    const names = rejected.names.slice(0, 2).join(", ");
    items.push({
      id: "templates",
      severity: "warn",
      title: rejected.count === 1 ? "A template was turned down by Meta" : `${rejected.count} templates were turned down by Meta`,
      detail: names ? `${names}. Open it to see the reason and send a fixed version.` : "Open it to see the reason and send a fixed version.",
      href: "/app/templates",
      cta: "Review templates",
      count: rejected.count,
    });
  }
  if (connection) {
    items.push({
      id: "token",
      severity: connection.kind === "expired" ? "urgent" : "warn",
      title: connection.kind === "expired" ? "A Facebook connection needs to be reconnected" : "A Facebook connection expires soon",
      detail:
        connection.kind === "expired"
          ? "Ads and Page features are paused for it until you reconnect."
          : `It runs out in ${connection.days === null ? "a few days" : plural(connection.days, "day")}. Reconnect to keep ads and Page features working.`,
      href: "/app/settings/connections",
      cta: "Reconnect",
      count: connection.count,
    });
  }
  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
