import { prisma } from "@/lib/db";
import type { ReportRange } from "./range";
import { median, percentile } from "./stats";

const ROW_CAP = 50_000;
const GROUP_LIMIT = 50;
const MAX_REPLY_DAYS = 7;

export type ResponseRow = { uid: string | null; team: string | null; secs: number; isFirst: boolean };
export type ResponseGroup = { replies: number; medianSeconds: number | null; firstReplies: number; firstMedianSeconds: number | null };
export type ResponseTimes = {
  /** Every time a customer wrote after our last message and a person on the team answered. */
  replies: number;
  medianSeconds: number | null;
  averageSeconds: number | null;
  p90Seconds: number | null;
  /** Only the first answer a customer ever got from a person. */
  firstReplies: number;
  firstMedianSeconds: number | null;
  capped: boolean;
  byAgent: ({ userId: string; name: string } & ResponseGroup)[] | null;
  byTeam: ({ teamId: string | null; name: string } & ResponseGroup)[] | null;
};

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function group(rows: ResponseRow[]): ResponseGroup {
  const first = rows.filter((r) => r.isFirst).map((r) => r.secs);
  return { replies: rows.length, medianSeconds: median(rows.map((r) => r.secs)), firstReplies: first.length, firstMedianSeconds: median(first) };
}

/** Pure. Splits rows by a key and returns the groups, busiest first. */
export function groupBy<K>(rows: ResponseRow[], key: (r: ResponseRow) => K): { key: K; stats: ResponseGroup }[] {
  const map = new Map<K, ResponseRow[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return [...map.entries()].map(([k, v]) => ({ key: k, stats: group(v) })).sort((a, b) => b.stats.replies - a.stats.replies).slice(0, GROUP_LIMIT);
}

export function summarise(rows: ResponseRow[]): Omit<ResponseTimes, "capped" | "byAgent" | "byTeam"> {
  const secs = rows.map((r) => r.secs);
  const g = group(rows);
  return { replies: rows.length, medianSeconds: g.medianSeconds, averageSeconds: mean(secs), p90Seconds: percentile(secs, 90), firstReplies: g.firstReplies, firstMedianSeconds: g.firstMedianSeconds };
}

/**
 * How long customers wait for a person to answer. A wait starts when a customer writes after our last message (or writes first)
 * and ends at the next message sent by a team member within 7 days. Automatic replies do not end a wait.
 */
export async function responseRows(tenantId: string, r: ReportRange): Promise<{ rows: ResponseRow[]; capped: boolean }> {
  const raw = await prisma.$queryRaw<{ uid: string | null; team: string | null; secs: number; is_first: boolean }[]>`
    SELECT o.uid AS uid, c."teamId" AS team, EXTRACT(EPOCH FROM (o.t - i."createdAt"))::float8 AS secs,
      NOT EXISTS (
        SELECT 1 FROM "Message" p
        WHERE p."tenantId" = ${tenantId} AND p."conversationId" = i."conversationId" AND p.direction = 'outbound'
          AND p."sentByUserId" IS NOT NULL AND p."createdAt" < i."createdAt"
      ) AS is_first
    FROM (
      SELECT id, "conversationId", "createdAt", direction,
        lag(direction) OVER (PARTITION BY "conversationId" ORDER BY "createdAt", id) AS prev
      FROM "Message"
      WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
    ) i
    JOIN "Conversation" c ON c.id = i."conversationId" AND c."tenantId" = ${tenantId}
    JOIN LATERAL (
      SELECT m."createdAt" AS t, m."sentByUserId" AS uid FROM "Message" m
      WHERE m."tenantId" = ${tenantId} AND m."conversationId" = i."conversationId" AND m.direction = 'outbound'
        AND m."sentByUserId" IS NOT NULL AND m."createdAt" > i."createdAt" AND m."createdAt" <= i."createdAt" + ${MAX_REPLY_DAYS}::int * interval '1 day'
      ORDER BY m."createdAt" ASC LIMIT 1
    ) o ON true
    WHERE i.direction = 'inbound' AND (i.prev IS NULL OR i.prev = 'outbound')
    LIMIT ${ROW_CAP}`;
  const rows = raw
    .map((x) => ({ uid: x.uid ?? null, team: x.team ?? null, secs: Number(x.secs), isFirst: x.is_first === true }))
    .filter((x) => Number.isFinite(x.secs) && x.secs >= 0);
  return { rows, capped: raw.length >= ROW_CAP };
}

async function agentNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const members = await prisma.membership.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, user: { select: { name: true } } } });
  return new Map(members.map((m) => [m.userId, m.user.name]));
}

async function teamNames(tenantId: string): Promise<{ names: Map<string, string>; defaultId: string | null; defaultName: string }> {
  const teams = await prisma.team.findMany({ where: { tenantId }, select: { id: true, name: true, isDefault: true } });
  const def = teams.find((t) => t.isDefault);
  return { names: new Map(teams.map((t) => [t.id, t.name])), defaultId: def?.id ?? null, defaultName: def?.name ?? "Default team" };
}

export async function responseTimes(tenantId: string, r: ReportRange, withBreakdown: boolean): Promise<ResponseTimes> {
  const { rows, capped } = await responseRows(tenantId, r);
  const base = { ...summarise(rows), capped, byAgent: null, byTeam: null } satisfies ResponseTimes;
  if (!withBreakdown) return base;
  const agents = groupBy(rows, (x) => x.uid);
  const [names, teams] = await Promise.all([agentNames(tenantId, agents.flatMap((a) => (a.key ? [a.key] : []))), teamNames(tenantId)]);
  const byTeam = groupBy(rows, (x) => (x.team && x.team !== teams.defaultId ? x.team : null));
  return {
    ...base,
    byAgent: agents.flatMap((a) => (a.key ? [{ userId: a.key, name: names.get(a.key) ?? "Former member", ...a.stats }] : [])),
    byTeam: byTeam.map((t) => ({ teamId: t.key ?? teams.defaultId, name: t.key ? (teams.names.get(t.key) ?? "Removed team") : teams.defaultName, ...t.stats })),
  };
}
