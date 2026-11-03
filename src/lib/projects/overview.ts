/**
 * GET /api/projects/overview: every live workspace the person belongs to, with the few numbers that say which one needs them.
 *
 * Fast and bounded:
 * - one query for the memberships (deleted workspaces are never listed, at most MAX_PROJECTS_LISTED, the current one always
 *   among them), then one grouped query per figure for all of them together: WhatsApp numbers, unread chats, new leads and ad
 *   spend. The number of queries does not grow with the number of projects, except for unread chats where the person is an
 *   agent: what an agent may see depends on that workspace's own visibility rules, so those are counted one workspace at a time,
 *   AGENT_SCOPE_CONCURRENCY at once.
 * - a figure that fails to load is null for every card (the card says "Not available") instead of failing the page.
 *
 * Figures, per workspace:
 * - unread chats: the inbox's own count (unreadCount > 0, not blocked) inside what this person may see there;
 * - new leads: leads created in the last LEADS_WINDOW_DAYS days (every member sees leads);
 * - ad spend this month: what the workspace's connected ad accounts spent this month, as Meta reports it to the spend controls
 *   (the SpendDaily account rows with origin "all", docs/SPEND-CONTROLS-SPEC.md 3.2 and 6.1), summed per currency and never
 *   converted. spend.sync.fast writes those rows only for accounts with an ad running through Edwyz or a Meta limit set in
 *   Edwyz (src/lib/spend/sync/fast-insights.ts), so the figure also says how many accounts are tracked: an account is tracked
 *   while its rows were synced in the last SPEND_TRACKED_WITHIN_HOURS hours, and only tracked accounts are summed (a total
 *   that froze when an account stopped being read is not this month's spend). "This month" is each account's own month: the
 *   rows are keyed by the account's time-zone days (MetaAsset meta.timezone, else the workspace's spending time zone, else
 *   Asia/Kolkata), exactly as the sync writes them.
 */
import type { Prisma, Role } from "@/generated/prisma/client";
import { emailVerificationRequired } from "@/lib/auth/verification";
import { prisma } from "@/lib/db";
import { countUnreadConversations } from "@/lib/inbox/stream";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/platform-settings";
import { toMoneyDTO } from "@/lib/spend/money";
import { addDays, dayKey, dayKeyToDate, monthKey, monthStartDay, nextMonthKey, resolveTimeZone } from "@/lib/spend/periods";
import { rulesToWhere, viewerRules } from "@/lib/teams/visibility";
import { billingFactsOf, PROJECT_TENANT_SELECT, type ProjectTenantRow } from "./billing";
import { newProjectAccess, projectBilling } from "./rules";
import {
  LEADS_WINDOW_DAYS,
  MAX_PROJECTS_LISTED,
  SPEND_TRACKED_WITHIN_HOURS,
  type ProjectAdSpend,
  type ProjectBillingState,
  type ProjectRole,
  type ProjectSummary,
  type ProjectWhatsApp,
  type ProjectsOverview,
} from "./types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The most ad accounts read for the spend figure, across all the listed projects. */
export const MAX_AD_ACCOUNTS = 5_000;
/** Rows synced recently are for this month's days (spend.sync.fast reads this_month); this bounds the scan with room to spare. */
const FRESH_ROWS_DAYS_BACK = 40;
/** Agent workspaces whose visibility rules are read at the same time. */
export const AGENT_SCOPE_CONCURRENCY = 4;

type MembershipRow = { role: Role; tenant: ProjectTenantRow };

export type OverviewViewer = { userId: string; tenantId: string };
export type OverviewOptions = { now?: Date };

/** Runs `task` over `items` with at most `limit` running at once, keeping the order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const count = (row: { _count?: { _all?: number } | number | null } | null | undefined): number => {
  const c = row?._count;
  return typeof c === "number" ? c : (c?._all ?? 0);
};

async function whatsappByTenant(ids: string[]): Promise<Map<string, ProjectWhatsApp>> {
  const rows = await prisma.phoneNumber.groupBy({ by: ["tenantId", "status"], where: { tenantId: { in: ids } }, _count: { _all: true }, _min: { displayPhone: true } });
  const out = new Map<string, ProjectWhatsApp>();
  for (const r of rows) {
    const prev = out.get(r.tenantId) ?? { state: "none" as const, numbers: 0, display: null };
    const n = count(r);
    const connected = r.status === "connected";
    out.set(r.tenantId, {
      state: connected || prev.state === "connected" ? "connected" : "setup",
      numbers: prev.numbers + n,
      // The number to show: a connected one when there is one.
      display: connected ? (r._min?.displayPhone ?? prev.display) : (prev.display ?? r._min?.displayPhone ?? null),
    });
  }
  return out;
}

/** Unread chats where the person is owner or admin: nobody restricts what they see, so one grouped count covers them all. */
async function unreadOpen(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  // The same filter as countUnreadConversations (src/lib/inbox/stream.ts), grouped.
  const rows = await prisma.conversation.groupBy({ by: ["tenantId"], where: { tenantId: { in: ids }, unreadCount: { gt: 0 }, status: { not: "blocked" } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.tenantId, count(r)]));
}

/** Unread chats where the person is an agent, inside that workspace's visibility rules (only assigned, team visibility). */
async function unreadAsAgent(userId: string, ids: string[]): Promise<Map<string, number | null>> {
  const pairs = await mapLimit(ids, AGENT_SCOPE_CONCURRENCY, async (tenantId): Promise<[string, number | null]> => {
    try {
      const viewer = { userId, tenantId, role: "agent" as const };
      return [tenantId, await countUnreadConversations(tenantId, rulesToWhere(viewer, await viewerRules(viewer)))];
    } catch (error) {
      log.warn("projects.overview.agent_unread_failed", { err: error, tenantId });
      return [tenantId, null];
    }
  });
  return new Map(pairs);
}

async function newLeads(ids: string[], now: Date): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - LEADS_WINDOW_DAYS * DAY_MS);
  const rows = await prisma.lead.groupBy({ by: ["tenantId"], where: { tenantId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.tenantId, count(r)]));
}

const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : 0n);

/** The zone spend.sync.fast keys an ad account's rows by: the account's own (meta.timezone), else the workspace's. */
export function accountTimeZone(meta: unknown, workspaceZone: string | null | undefined): string {
  const own = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as { timezone?: unknown }).timezone : null;
  return resolveTimeZone(typeof own === "string" ? own : workspaceZone);
}

/** A project with no connected ad account. */
export const noAdSpend = (): ProjectAdSpend => ({ amounts: [], accounts: 0, tracked: 0 });

const ADS_ACCOUNT_ROWS = { pot: "ads", scopeType: "account", origin: "all" } as const;

/**
 * This month's ad spend per workspace and currency, over its tracked ad accounts, plus how many accounts it has and tracks.
 * Queries: the spending zones and the ad accounts, then one grouped freshness query and one grouped sum per distinct month
 * among the accounts (two at most, around the turn of a month). Nothing grows with the number of projects or accounts.
 */
async function adSpend(ids: string[], now: Date): Promise<Map<string, ProjectAdSpend>> {
  const [controls, accounts] = await Promise.all([
    prisma.spendControl.findMany({ where: { tenantId: { in: ids } }, select: { tenantId: true, timezone: true } }),
    prisma.metaAsset.findMany({
      where: { tenantId: { in: ids }, type: "ad_account", status: "active" },
      orderBy: { id: "asc" },
      take: MAX_AD_ACCOUNTS,
      select: { id: true, tenantId: true, meta: true },
    }),
  ]);
  const out = new Map<string, ProjectAdSpend>();
  if (accounts.length === 0) return out;

  const workspaceZone = new Map(controls.map((c) => [c.tenantId, c.timezone]));
  const byMonth = new Map<string, string[]>();
  for (const a of accounts) {
    const month = monthKey(now, accountTimeZone(a.meta, workspaceZone.get(a.tenantId)));
    const list = byMonth.get(month);
    if (list) list.push(a.id);
    else byMonth.set(month, [a.id]);
  }
  const accountIds = accounts.map((a) => a.id);
  const [fresh, sums] = await Promise.all([
    prisma.spendDaily.groupBy({
      by: ["scopeId"],
      where: {
        tenantId: { in: ids },
        ...ADS_ACCOUNT_ROWS,
        scopeId: { in: accountIds },
        syncedAt: { gte: new Date(now.getTime() - SPEND_TRACKED_WITHIN_HOURS * HOUR_MS) },
        day: { gte: dayKeyToDate(addDays(dayKey(now, "UTC"), -FRESH_ROWS_DAYS_BACK)) },
      },
      _max: { syncedAt: true },
    }),
    Promise.all(
      [...byMonth].map(([month, scopeIds]) =>
        prisma.spendDaily.groupBy({
          by: ["tenantId", "scopeId", "currency"],
          where: {
            tenantId: { in: ids },
            ...ADS_ACCOUNT_ROWS,
            scopeId: { in: scopeIds },
            day: { gte: dayKeyToDate(monthStartDay(month)), lt: dayKeyToDate(monthStartDay(nextMonthKey(month))) },
          },
          _sum: { amountMinor: true },
        }),
      ),
    ),
  ]);

  const tracked = new Set(fresh.map((r) => r.scopeId));
  const tenantOf = new Map(accounts.map((a) => [a.id, a.tenantId]));
  const totals = new Map<string, Map<string, bigint>>();
  for (const a of accounts) {
    const entry = out.get(a.tenantId) ?? noAdSpend();
    entry.accounts += 1;
    if (tracked.has(a.id)) entry.tracked += 1;
    out.set(a.tenantId, entry);
  }
  for (const r of sums.flat()) {
    // Only tracked accounts: an untracked one's rows stopped when Edwyz stopped reading it, so they are not this month's total.
    if (!tracked.has(r.scopeId) || tenantOf.get(r.scopeId) !== r.tenantId) continue;
    const amount = toBig(r._sum?.amountMinor);
    if (amount <= 0n || !r.currency) continue;
    const per = totals.get(r.tenantId) ?? new Map<string, bigint>();
    per.set(r.currency, (per.get(r.currency) ?? 0n) + amount);
    totals.set(r.tenantId, per);
  }
  for (const [tenantId, per] of totals) {
    const entry = out.get(tenantId);
    if (!entry) continue;
    entry.amounts = [...per].sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1)).map(([currency, minor]) => toMoneyDTO(minor, currency));
  }
  return out;
}

/** A settled figure, or null for every workspace (logged once) when its query failed. */
function settled<T>(result: PromiseSettledResult<T>, what: string): T | null {
  if (result.status === "fulfilled") return result.value;
  log.warn("projects.overview.figure_failed", { err: result.reason, figure: what });
  return null;
}

/** Current project first, then the rest by name. */
export function orderProjects<T extends { name: string; current: boolean }>(projects: T[]): T[] {
  return [...projects].sort((a, b) => (a.current === b.current ? a.name.localeCompare(b.name, "en", { sensitivity: "base" }) : a.current ? -1 : 1));
}

export async function loadProjectsOverview(viewer: OverviewViewer, options: OverviewOptions = {}): Promise<ProjectsOverview> {
  const now = options.now ?? new Date();
  const live = { userId: viewer.userId, tenant: { deletedAt: null } } satisfies Prisma.MembershipWhereInput;
  const select = { role: true, tenant: { select: PROJECT_TENANT_SELECT } } satisfies Prisma.MembershipSelect;
  const [rows, user, settings] = await Promise.all([
    prisma.membership.findMany({ where: live, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_PROJECTS_LISTED + 1, select }),
    prisma.user.findUnique({ where: { id: viewer.userId }, select: { emailVerifiedAt: true } }),
    getSettings(),
  ]);
  const truncated = rows.length > MAX_PROJECTS_LISTED;
  let memberships: MembershipRow[] = rows.slice(0, MAX_PROJECTS_LISTED);
  if (!memberships.some((m) => m.tenant.id === viewer.tenantId)) {
    // More projects than the list holds and the current one is not among the first: it is always shown.
    const current = await prisma.membership.findFirst({ where: { ...live, tenantId: viewer.tenantId }, select });
    if (current) memberships = [current, ...memberships.slice(0, MAX_PROJECTS_LISTED - 1)];
  }
  const total = truncated ? await prisma.membership.count({ where: live }) : memberships.length;

  const ids = memberships.map((m) => m.tenant.id);
  const openIds = memberships.filter((m) => m.role !== "agent").map((m) => m.tenant.id);
  const agentIds = memberships.filter((m) => m.role === "agent").map((m) => m.tenant.id);
  const empty = ids.length === 0;
  const [phones, unreadA, unreadB, leads, spend] = await Promise.allSettled([
    empty ? Promise.resolve(new Map<string, ProjectWhatsApp>()) : whatsappByTenant(ids),
    unreadOpen(openIds),
    unreadAsAgent(viewer.userId, agentIds),
    empty ? Promise.resolve(new Map<string, number>()) : newLeads(ids, now),
    empty ? Promise.resolve(new Map<string, ProjectAdSpend>()) : adSpend(ids, now),
  ]);
  const whatsapp = settled(phones, "whatsapp");
  const unreadOpenMap = settled(unreadA, "unread");
  const unreadAgentMap = settled(unreadB, "unread_agent");
  const leadMap = settled(leads, "leads");
  const spendMap = settled(spend, "ad_spend");

  const graceDays = settings.graceDays;
  const ownedStates: ProjectBillingState[] = [];
  const projects: ProjectSummary[] = memberships.map((m) => {
    const id = m.tenant.id;
    const facts = billingFactsOf(m.tenant, graceDays, now);
    if (m.role === "owner") ownedStates.push(facts.state);
    const unread = m.role === "agent" ? (unreadAgentMap ? (unreadAgentMap.get(id) ?? null) : null) : unreadOpenMap ? (unreadOpenMap.get(id) ?? 0) : null;
    return {
      id,
      name: m.tenant.name,
      role: m.role as ProjectRole,
      current: id === viewer.tenantId,
      billing: projectBilling(facts),
      whatsapp: whatsapp ? (whatsapp.get(id) ?? { state: "none", numbers: 0, display: null }) : null,
      unreadConversations: unread,
      newLeads: leadMap ? (leadMap.get(id) ?? 0) : null,
      adSpendMonth: spendMap ? (spendMap.get(id) ?? noAdSpend()) : null,
    };
  });

  return {
    projects: orderProjects(projects),
    currentId: viewer.tenantId,
    total,
    truncated: total > projects.length,
    leadsWindowDays: LEADS_WINDOW_DAYS,
    // Counted from the listed projects; the create route counts every owned project again before it creates one.
    newProject: newProjectAccess({ verificationRequired: emailVerificationRequired(), emailVerifiedAt: user ? user.emailVerifiedAt : undefined, ownedStates }),
    generatedAt: now.toISOString(),
  };
}
