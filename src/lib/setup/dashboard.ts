import { prisma } from "@/lib/db";
import { firstResponseSeconds, messagesAndConversations } from "@/lib/reports/metrics";
import { addDays, canonicalTimeZone, dayKey, parseRange } from "@/lib/reports/range";
import { hasRole, type Actor } from "@/lib/tenancy";
import {
  buildAttention,
  connectionAlert,
  contactLabel,
  sum,
  trendPct,
  type AttentionItem,
  type Kpi,
  type QueueItem,
} from "./dashboard-logic";

export type DayPoint = { day: string; inbound: number; outbound: number; conversations: number; responseSeconds: number | null };

export type DashboardData = {
  role: Actor["role"];
  userId: string;
  firstName: string;
  workspaceName: string;
  connected: boolean;
  tz: string;
  days: DayPoint[];
  kpis: Kpi[];
  attention: AttentionItem[];
  /** Admins: chats waiting longest. Agents: their own chats waiting longest. */
  queue: { items: QueueItem[]; total: number; unassigned: number; mine: number };
  quiet: boolean;
};

const WINDOW_DAYS = 7;
const QUEUE_SIZE = 5;
const FAILED_WINDOW_MS = 24 * 3_600_000;
const REJECTED_WINDOW_MS = 14 * 86_400_000;

/** Runs a query that may fail without taking the whole dashboard down. */
async function soft<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    console.error("[dashboard] a section could not be loaded");
    return null;
  }
}

const waitingWhere = (tenantId: string, extra: Record<string, unknown> = {}) => ({
  tenantId,
  status: "open",
  lastInboundAt: { not: null },
  lastMessageAt: { lte: prisma.conversation.fields.lastInboundAt },
  ...extra,
});

async function waitingChats(tenantId: string, now: Date, extra: Record<string, unknown> = {}) {
  const where = waitingWhere(tenantId, extra);
  const [count, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { lastInboundAt: "asc" },
      take: QUEUE_SIZE,
      select: { id: true, assignedToId: true, lastInboundAt: true, contact: { select: { name: true, phone: true, username: true } } },
    }),
  ]);
  const ids = [...new Set(rows.map((r) => r.assignedToId).filter((x): x is string => !!x))];
  const members = ids.length ? await prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { name: true } } } }) : [];
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const items: QueueItem[] = rows.map((r) => ({
    id: r.id,
    name: contactLabel(r.contact.name, r.contact.phone, r.contact.username),
    waitingSeconds: Math.max(0, Math.round((now.getTime() - (r.lastInboundAt as Date).getTime()) / 1000)),
    assignedTo: r.assignedToId ? (names.get(r.assignedToId) ?? "Former member") : null,
  }));
  return { count, items };
}

async function attentionInputs(tenantId: string, now: Date) {
  const [failed, rejectedCount, rejected, connections] = await Promise.all([
    soft(() => prisma.message.count({ where: { tenantId, direction: "outbound", status: "failed", createdAt: { gte: new Date(now.getTime() - FAILED_WINDOW_MS) } } })),
    soft(() => prisma.template.count({ where: { tenantId, status: "rejected", updatedAt: { gte: new Date(now.getTime() - REJECTED_WINDOW_MS) } } })),
    soft(() =>
      prisma.template.findMany({ where: { tenantId, status: "rejected", updatedAt: { gte: new Date(now.getTime() - REJECTED_WINDOW_MS) } }, select: { name: true }, orderBy: { updatedAt: "desc" }, take: 2 }),
    ),
    soft(() => prisma.metaConnection.findMany({ where: { tenantId }, select: { status: true, tokenExpiresAt: true } })),
  ]);
  return {
    failedSends: failed ?? 0,
    rejectedTemplates: { count: rejectedCount ?? 0, names: (rejected ?? []).map((t) => t.name) },
    connection: connectionAlert(connections ?? [], now),
  };
}

type MessageSeries = Awaited<ReturnType<typeof messagesAndConversations>>;

function responseKpi(current: number | null, previous: number | null, series: (number | null)[] | null, answered: number, failed: boolean): Kpi {
  return {
    id: "response",
    label: "Time to first reply",
    value: current,
    unit: "seconds",
    series,
    deltaPct: trendPct(current, previous),
    betterWhen: "down",
    href: "/app/reports",
    note: failed ? null : answered > 0 ? `Median over ${answered} ${answered === 1 ? "chat" : "chats"} this week` : "No replies sent this week yet",
    unavailable: failed,
  };
}

function volumeKpis(mc: MessageSeries | null): Kpi[] {
  if (!mc) {
    const gone = { value: null, unit: "count" as const, series: null, deltaPct: null, betterWhen: "up" as const, href: "/app/reports", note: null, unavailable: true };
    return [
      { id: "messages", label: "Messages", ...gone },
      { id: "conversations", label: "New conversations", ...gone },
    ];
  }
  const total = mc.messagesPerDay.map((d) => d.inbound + d.outbound);
  const opened = mc.conversationsOpenedPerDay.map((d) => d.count);
  const make = (id: "messages" | "conversations", label: string, all: number[], note: string): Kpi => ({
    id,
    label,
    value: sum(all.slice(-WINDOW_DAYS)),
    unit: "count",
    series: all.slice(-WINDOW_DAYS),
    deltaPct: trendPct(sum(all.slice(-WINDOW_DAYS)), sum(all.slice(0, -WINDOW_DAYS))),
    betterWhen: "up",
    href: "/app/reports",
    note,
    unavailable: false,
  });
  return [make("messages", "Messages", total, "Sent and received, last 7 days"), make("conversations", "New conversations", opened, "Customers who started a chat, last 7 days")];
}

async function responseTimes(tenantId: string, tz: string, to: string) {
  const range = (from: string, end: string) => parseRange({ from, to: end, tz });
  const [current, previous] = await Promise.all([
    soft(() => firstResponseSeconds(tenantId, range(addDays(to, -(WINDOW_DAYS - 1)), to))),
    soft(() => firstResponseSeconds(tenantId, range(addDays(to, -(2 * WINDOW_DAYS - 1)), addDays(to, -WINDOW_DAYS)))),
  ]);
  const perDay = await Promise.all(
    Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(to, -(WINDOW_DAYS - 1 - i))).map((d) =>
      current ? soft(() => firstResponseSeconds(tenantId, range(d, d))).then((r) => (r && r.conversations > 0 ? r.medianSeconds : null)) : Promise.resolve(null),
    ),
  );
  return { current, previous, perDay };
}

/** Everything the dashboard needs in one call. Sections that fail show as unavailable instead of failing the page. */
export async function buildDashboard(actor: Actor, opts: { tz?: string | null; now?: Date } = {}): Promise<DashboardData> {
  const now = opts.now ?? new Date();
  // Browsers can report old zone names (Asia/Calcutta); the current name is what SQL's AT TIME ZONE must get.
  const tz = canonicalTimeZone(opts.tz) ?? "UTC";
  const { tenantId, userId } = actor;
  const isAdmin = hasRole(actor, "admin");
  const to = dayKey(now, tz);
  const volumeRange = parseRange({ from: addDays(to, -(2 * WINDOW_DAYS - 1)), to, tz });

  const [user, tenant, mc, openTotal, openUnassigned, openMine, waiting, response, attentionRaw] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, onboardingStatus: true } }),
    soft(() => messagesAndConversations(tenantId, volumeRange, now)),
    prisma.conversation.count({ where: { tenantId, status: "open" } }),
    prisma.conversation.count({ where: { tenantId, status: "open", assignedToId: null } }),
    prisma.conversation.count({ where: { tenantId, status: "open", assignedToId: userId } }),
    soft(() => waitingChats(tenantId, now, isAdmin ? {} : { assignedToId: userId })),
    responseTimes(tenantId, tz, to),
    isAdmin ? attentionInputs(tenantId, now) : Promise.resolve(null),
  ]);

  const respSeries = response.current ? response.perDay : null;
  const kpis: Kpi[] = [
    ...volumeKpis(mc),
    responseKpi(response.current?.medianSeconds ?? null, response.previous?.medianSeconds ?? null, respSeries, response.current?.conversations ?? 0, response.current === null),
    {
      id: "open",
      label: "Open chats",
      value: openTotal,
      unit: "count",
      series: null,
      deltaPct: null,
      betterWhen: "down",
      href: "/app/inbox",
      note: `${openUnassigned} unassigned, ${openMine} yours`,
      unavailable: false,
    },
  ];

  const week = (mc?.messagesPerDay ?? []).slice(-WINDOW_DAYS);
  const opened = (mc?.conversationsOpenedPerDay ?? []).slice(-WINDOW_DAYS);
  const days: DayPoint[] = week.map((d, i) => ({
    day: d.day,
    inbound: d.inbound,
    outbound: d.outbound,
    conversations: opened[i]?.count ?? 0,
    responseSeconds: response.perDay[i] ?? null,
  }));

  const queue = { items: waiting?.items ?? [], total: waiting?.count ?? 0, unassigned: openUnassigned, mine: openMine };
  const attention =
    isAdmin && attentionRaw
      ? buildAttention({ unassigned: openUnassigned, waiting: { count: waiting?.count ?? 0, oldest: waiting?.items[0] ?? null }, ...attentionRaw })
      : [];

  return {
    role: actor.role,
    userId,
    firstName: (user?.name ?? "").trim().split(/\s+/)[0] ?? "",
    workspaceName: tenant?.name ?? "",
    connected: tenant?.onboardingStatus === "live",
    tz,
    days,
    kpis,
    attention,
    queue,
    quiet: days.every((d) => d.inbound + d.outbound + d.conversations === 0) && openTotal === 0,
  };
}
