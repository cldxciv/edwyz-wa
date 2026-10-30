import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/client";
import { hintFor } from "./errors";
import { type ReportRange, addDays } from "./range";
import { responseTimes, type ResponseTimes } from "./response-times";
import { median, percentile, rate } from "./stats";

export type DayRow = { day: string; inbound: number; outbound: number; sent: number; delivered: number; read: number; failed: number };
export type BroadcastRow = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  deliveryRate: number | null;
  readRate: number | null;
};
export type AdminSections = {
  agents: { userId: string; name: string; messages: number }[];
  broadcasts: BroadcastRow[];
  optInsPerDay: { day: string; optIns: number; optOuts: number }[];
  failureCodes: { code: string; count: number; hint: string | null }[];
};
export type Overview = {
  range: { from: string; to: string; tz: string };
  messagesPerDay: DayRow[];
  messagesSource: "live" | "snapshot" | "mixed";
  conversationsOpenedPerDay: { day: string; count: number }[];
  resolution: { available: false; note: string };
  firstResponse: { conversations: number; medianSeconds: number | null; p90Seconds: number | null; capped: boolean };
  /** Reply times for every customer wait, with per-person and per-team breakdowns for admins. Null when it could not be worked out. */
  responseTimes: ResponseTimes | null;
  admin: AdminSections | null;
};

export const SNAPSHOT_AFTER_DAYS = 3;
const FIRST_RESPONSE_CAP = 50_000;
const BROADCAST_LIMIT = 100;

const num = (v: unknown) => Number(v ?? 0);
const emptyRow = (day: string): DayRow => ({ day, inbound: 0, outbound: 0, sent: 0, delivered: 0, read: 0, failed: 0 });

// Timestamps are stored as UTC without a zone, so SQL converts to UTC first and then into the requested zone.

export function foldMessageRows(days: string[], rows: { day: string; direction: string; status: string; c: unknown }[]): Map<string, DayRow> {
  const map = new Map(days.map((d) => [d, emptyRow(d)]));
  for (const row of rows) {
    const target = map.get(row.day);
    if (!target) continue;
    const c = num(row.c);
    if (row.direction === "inbound") {
      target.inbound += c;
      continue;
    }
    target.outbound += c;
    if (["sent", "delivered", "read"].includes(row.status)) target.sent += c;
    if (["delivered", "read"].includes(row.status)) target.delivered += c;
    if (row.status === "read") target.read += c;
    if (row.status === "failed") target.failed += c;
  }
  return map;
}

async function snapshotDays(tenantId: string, days: string[]) {
  const rows = await prisma.dailyMetric.findMany({
    where: { scope: `tenant:${tenantId}`, day: { in: days } },
    select: { day: true, key: true, value: true },
  });
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) byDay.set(row.day, { ...(byDay.get(row.day) ?? {}), [row.key]: row.value });
  return byDay;
}

/** Messages and conversations per local day. Days older than 3 days come from DailyMetric when finalised (UTC reports only). */
export async function messagesAndConversations(tenantId: string, r: ReportRange, now = new Date()) {
  const cutoff = addDays(now.toISOString().slice(0, 10), -SNAPSHOT_AFTER_DAYS);
  const candidates = r.tz === "UTC" ? r.days.filter((d) => d < cutoff) : [];
  const snaps = candidates.length ? await snapshotDays(tenantId, candidates) : new Map<string, Record<string, number>>();
  const usable = new Set(candidates.filter((d) => snaps.get(d)?._done === 1 && snaps.get(d)?._final === 1));
  const liveDays = r.days.filter((d) => !usable.has(d));

  const rows = new Map<string, DayRow>(r.days.map((d) => [d, emptyRow(d)]));
  const opened = new Map<string, number>(r.days.map((d) => [d, 0]));
  for (const d of usable) {
    const s = snaps.get(d)!;
    rows.set(d, { day: d, inbound: s.messages_in ?? 0, outbound: s.messages_out ?? 0, sent: s.sent ?? 0, delivered: s.delivered ?? 0, read: s.read ?? 0, failed: s.failed ?? 0 });
    opened.set(d, s.conversations_opened ?? 0);
  }
  if (liveDays.length) {
    const [msgRows, convRows] = await Promise.all([
      prisma.$queryRaw<{ day: string; direction: string; status: string; c: bigint }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}::text, 'YYYY-MM-DD') AS day, direction::text AS direction, status::text AS status, count(*) AS c
        FROM "Message"
        WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
        GROUP BY 1, 2, 3`,
      prisma.$queryRaw<{ day: string; c: bigint }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}::text, 'YYYY-MM-DD') AS day, count(*) AS c
        FROM "Conversation"
        WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
        GROUP BY 1`,
    ]);
    const folded = foldMessageRows(r.days, msgRows);
    for (const d of liveDays) rows.set(d, folded.get(d)!);
    for (const c of convRows) if (liveDays.includes(c.day)) opened.set(c.day, num(c.c));
  }
  const source = usable.size === 0 ? "live" : usable.size === r.days.length ? "snapshot" : "mixed";
  return {
    messagesPerDay: r.days.map((d) => rows.get(d)!),
    conversationsOpenedPerDay: r.days.map((d) => ({ day: d, count: opened.get(d) ?? 0 })),
    source: source as "live" | "snapshot" | "mixed",
  };
}

/** Seconds from each conversation's first inbound message in range to the first human outbound reply after it. */
export async function firstResponseSeconds(tenantId: string, r: ReportRange) {
  const rows = await prisma.$queryRaw<{ secs: number }[]>`
    SELECT EXTRACT(EPOCH FROM (min(o."createdAt") - f.t_in))::float8 AS secs
    FROM (
      SELECT "conversationId", min("createdAt") AS t_in FROM "Message"
      WHERE "tenantId" = ${tenantId} AND direction = 'inbound' AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
      GROUP BY "conversationId"
    ) f
    JOIN "Message" o ON o."conversationId" = f."conversationId" AND o."tenantId" = ${tenantId}
      AND o.direction = 'outbound' AND o."sentByUserId" IS NOT NULL AND o."createdAt" > f.t_in
    GROUP BY f."conversationId", f.t_in
    LIMIT ${FIRST_RESPONSE_CAP}`;
  const values = rows.map((x) => Number(x.secs)).filter((v) => Number.isFinite(v) && v >= 0);
  return { conversations: values.length, medianSeconds: median(values), p90Seconds: percentile(values, 90), capped: rows.length >= FIRST_RESPONSE_CAP };
}

export function broadcastRow(b: { id: string; name: string; status: string; createdAt: Date }, counts: Record<string, number>): BroadcastRow {
  const read = counts.read ?? 0;
  const delivered = (counts.delivered ?? 0) + read;
  const sent = (counts.sent ?? 0) + delivered;
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    sent,
    delivered,
    read,
    failed: counts.failed ?? 0,
    deliveryRate: rate(delivered, sent),
    readRate: rate(read, sent),
  };
}

async function broadcastPerformance(tenantId: string, r: ReportRange): Promise<BroadcastRow[]> {
  const broadcasts = await prisma.broadcast.findMany({
    where: { tenantId, createdAt: { gte: r.start, lt: r.end } },
    orderBy: { createdAt: "desc" },
    take: BROADCAST_LIMIT,
    select: { id: true, name: true, status: true, createdAt: true },
  });
  if (broadcasts.length === 0) return [];
  const groups = await prisma.broadcastRecipient.groupBy({
    by: ["broadcastId", "status"],
    where: { tenantId, broadcastId: { in: broadcasts.map((b) => b.id) } },
    _count: { _all: true },
  });
  return broadcasts.map((b) => {
    const counts: Record<string, number> = {};
    for (const g of groups) if (g.broadcastId === b.id) counts[g.status] = g._count._all;
    return broadcastRow(b, counts);
  });
}

async function agentMessages(tenantId: string, r: ReportRange) {
  const groups = await prisma.message.groupBy({
    by: ["sentByUserId"],
    where: { tenantId, direction: "outbound", sentByUserId: { not: null }, createdAt: { gte: r.start, lt: r.end } },
    _count: { _all: true },
    orderBy: { _count: { sentByUserId: "desc" } },
    take: 50,
  });
  const ids = groups.map((g) => g.sentByUserId as string);
  const members = ids.length
    ? await prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { name: true } } } })
    : [];
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  return groups.map((g) => ({ userId: g.sentByUserId as string, name: names.get(g.sentByUserId as string) ?? "Former member", messages: g._count._all }));
}

async function optPerDay(tenantId: string, r: ReportRange) {
  const [ins, outs] = await Promise.all([
    prisma.$queryRaw<{ day: string; c: bigint }[]>`
      SELECT to_char(("optInAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}::text, 'YYYY-MM-DD') AS day, count(*) AS c FROM "Contact"
      WHERE "tenantId" = ${tenantId} AND "optInAt" >= ${r.start} AND "optInAt" < ${r.end} GROUP BY 1`,
    prisma.$queryRaw<{ day: string; c: bigint }[]>`
      SELECT to_char(("optedOutAt" AT TIME ZONE 'UTC') AT TIME ZONE ${r.tz}::text, 'YYYY-MM-DD') AS day, count(*) AS c FROM "Contact"
      WHERE "tenantId" = ${tenantId} AND "optedOutAt" >= ${r.start} AND "optedOutAt" < ${r.end} GROUP BY 1`,
  ]);
  const i = new Map(ins.map((x) => [x.day, num(x.c)]));
  const o = new Map(outs.map((x) => [x.day, num(x.c)]));
  return r.days.map((day) => ({ day, optIns: i.get(day) ?? 0, optOuts: o.get(day) ?? 0 }));
}

async function failureCodes(tenantId: string, r: ReportRange) {
  const groups = await prisma.message.groupBy({
    by: ["errorCode"],
    where: { tenantId, status: "failed", errorCode: { not: null }, createdAt: { gte: r.start, lt: r.end } },
    _count: { _all: true },
    orderBy: { _count: { errorCode: "desc" } },
    take: 10,
  });
  return groups.map((g) => ({ code: g.errorCode as string, count: g._count._all, hint: hintFor(g.errorCode as string) }));
}

export async function buildOverview(tenantId: string, role: Role, r: ReportRange, now = new Date()): Promise<Overview> {
  const isAdmin = role === "owner" || role === "admin";
  const [mc, firstResponse, replyTimes, admin] = await Promise.all([
    messagesAndConversations(tenantId, r, now),
    firstResponseSeconds(tenantId, r),
    responseTimes(tenantId, r, isAdmin).catch(() => {
      console.error("[reports] could not work out reply times");
      return null;
    }),
    isAdmin
      ? Promise.all([agentMessages(tenantId, r), broadcastPerformance(tenantId, r), optPerDay(tenantId, r), failureCodes(tenantId, r)]).then(
          ([agents, broadcasts, optInsPerDay, codes]): AdminSections => ({ agents, broadcasts, optInsPerDay, failureCodes: codes }),
        )
      : Promise.resolve(null),
  ]);
  return {
    range: { from: r.from, to: r.to, tz: r.tz },
    messagesPerDay: mc.messagesPerDay,
    messagesSource: mc.source,
    conversationsOpenedPerDay: mc.conversationsOpenedPerDay,
    resolution: {
      available: false,
      note: "Not available: conversation resolution times are not recorded. Resolving a conversation changes its status but stores no timestamp.",
    },
    firstResponse,
    responseTimes: replyTimes,
    admin,
  };
}
