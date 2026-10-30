import type { Kpi } from "@/lib/setup/dashboard-logic";

export type Point = { x: number; y: number };
export type SparkGeometry = { line: string; area: string; last: Point | null; points: Point[] };

/** Maps a series to SVG coordinates. Null entries break the line so a quiet day is shown as a gap, not a zero. */
export function sparkGeometry(values: (number | null)[], width: number, height: number, pad = 3): SparkGeometry {
  const real = values.filter((v): v is number => v !== null);
  if (real.length === 0) return { line: "", area: "", last: null, points: [] };
  const max = Math.max(...real);
  const min = Math.min(0, ...real);
  const span = max - min || 1;
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const x = (i: number) => (values.length > 1 ? pad + i * stepX : width / 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const points: Point[] = [];
  const segments: Point[][] = [];
  let current: Point[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    const p = { x: round(x(i)), y: round(y(v)) };
    points.push(p);
    current.push(p);
  });
  if (current.length) segments.push(current);

  const baseline = round(height - pad);
  const line = segments.map((s) => s.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")).join(" ");
  const area = segments
    .filter((s) => s.length > 1)
    .map((s) => `${s.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")} L${s[s.length - 1].x} ${baseline} L${s[0].x} ${baseline} Z`)
    .join(" ");
  return { line, area, last: points[points.length - 1] ?? null, points };
}

const round = (n: number) => Math.round(n * 10) / 10;

export type DeltaTone = "good" | "bad" | "neutral";

/** Plain-words change against last week, with the colour decided by whether up or down is good for this measure. */
export function deltaLabel(kpi: Pick<Kpi, "deltaPct" | "betterWhen">): { text: string; tone: DeltaTone } | null {
  const d = kpi.deltaPct;
  if (d === null) return null;
  if (d === 0) return { text: "Same as last week", tone: "neutral" };
  const up = d > 0;
  const good = kpi.betterWhen === "up" ? up : !up;
  return { text: `${up ? "Up" : "Down"} ${Math.abs(d)}% on last week`, tone: good ? "good" : "bad" };
}

export function formatCount(n: number): string {
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toLocaleString("en-IN");
}

export function formatReplyTime(seconds: number | null): string {
  if (seconds === null) return "No data yet";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function greetingFor(hour: number, firstName: string): string {
  const part = hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 22 ? "Good evening" : "Hello";
  return firstName ? `${part}, ${firstName}` : part;
}

export type QuickAction = { id: string; label: string; hint: string; href: string };

const ADMIN_ACTIONS: QuickAction[] = [
  { id: "inbox", label: "Open inbox", hint: "Reply to customers", href: "/app/inbox" },
  { id: "broadcast", label: "Send a broadcast", hint: "Message many people at once", href: "/app/broadcasts/new" },
  { id: "contacts", label: "Add contacts", hint: "Import or add people", href: "/app/contacts" },
  { id: "template", label: "New template", hint: "Write a message for Meta to approve", href: "/app/templates/new" },
  { id: "team", label: "Invite a teammate", hint: "Share the inbox", href: "/app/settings/team" },
  { id: "reports", label: "See reports", hint: "How your messages are doing", href: "/app/reports" },
];

const AGENT_ACTIONS: QuickAction[] = [
  { id: "inbox", label: "Open my inbox", hint: "Your chats and unassigned ones", href: "/app/inbox" },
  { id: "contacts", label: "Find a contact", hint: "Look up a customer", href: "/app/contacts" },
  { id: "templates", label: "Message templates", hint: "Approved messages you can send", href: "/app/templates" },
  { id: "leads", label: "Leads", hint: "People who asked to hear from you", href: "/app/leads" },
];

/** Agents only get shortcuts to pages they can use. Before a number is connected the list starts with the one thing that matters. */
export function quickActionsFor(role: "owner" | "admin" | "agent", connected: boolean): QuickAction[] {
  if (role === "agent") return AGENT_ACTIONS;
  if (connected) return ADMIN_ACTIONS;
  return [{ id: "connect", label: "Connect WhatsApp", hint: "Link your business number", href: "/app/settings/connect" }, ...ADMIN_ACTIONS.filter((a) => ["contacts", "template", "team"].includes(a.id))];
}

/** "Mon 14" style label for table rows, from a YYYY-MM-DD day key without timezone drift. */
export function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${date.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${d}`;
}

export function describeSeries(label: string, values: (number | null)[], format: (n: number) => string): string {
  const real = values.filter((v): v is number => v !== null);
  if (real.length === 0) return `${label}: no data in the last 7 days.`;
  const peak = Math.max(...real);
  const latest = values[values.length - 1];
  return `${label} over the last 7 days. Highest ${format(peak)}. Latest ${latest === null ? "no data" : format(latest)}.`;
}
