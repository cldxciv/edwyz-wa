import { prisma } from "@/lib/db";
import { hasRole, HttpError, type Actor } from "@/lib/tenancy";
import { isInboxView } from "./list";

/**
 * Saved inbox views. A view is a small, validated query: which tab, an optional tag, an optional search text and who the chats are
 * assigned to. SavedInboxFilter only has a userId column, so a view shared with the whole workspace is stored under the
 * pseudo user "*" (an admin creates it, everyone sees it). Views for chosen teammates would need a schema change.
 */
export const SHARED_OWNER = "*";
const MAX_PER_OWNER = 25;
const MAX_NAME = 40;

export const SAVED_TABS = ["all", "open", "pending", "solved", "expired", "blocked", "mine", "unassigned", "unread", "new", "campaign", "favorite", "mentioned", "active"] as const;
export type FilterTab = (typeof SAVED_TABS)[number];

export type SavedQuery = { tab: FilterTab; tag?: string; q?: string };

export function parseSavedQuery(raw: unknown): SavedQuery {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) throw new HttpError(400, "query must be an object.");
  const tab = r.tab ?? "all";
  if (typeof tab !== "string" || !(SAVED_TABS as readonly string[]).includes(tab)) throw new HttpError(400, "That view is not available.");
  const out: SavedQuery = { tab: tab as FilterTab };
  for (const key of ["tag", "q"] as const) {
    const v = r[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 100) throw new HttpError(400, `${key} must be text of up to 100 characters.`);
    out[key] = v.trim();
  }
  return out;
}

/** The list parameters a saved view stands for (the same names GET /api/inbox/conversations takes). */
export function queryToParams(query: SavedQuery): Record<string, string> {
  const p: Record<string, string> = {};
  const { tab } = query;
  if (tab === "mine") p.assigned = "me";
  else if (tab === "unassigned") p.assigned = "unassigned";
  else if (tab === "open" || tab === "pending" || tab === "solved" || tab === "blocked") p.status = tab;
  else if (tab === "expired") p.expired = "1";
  else if (tab === "unread") p.unread = "1";
  else if (isInboxView(tab)) p.view = tab;
  if (query.tag) p.tag = query.tag;
  if (query.q) p.q = query.q;
  return p;
}

export type SavedFilter = { id: string; name: string; query: SavedQuery; shared: boolean; mine: boolean };

export async function listSavedFilters(tenantId: string, userId: string): Promise<SavedFilter[]> {
  const rows = await prisma.savedInboxFilter.findMany({
    where: { tenantId, userId: { in: [userId, SHARED_OWNER] } },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_OWNER * 2,
  });
  return rows.map((r) => ({ id: r.id, name: r.name, query: parseSavedQuery(r.query), shared: r.userId === SHARED_OWNER, mine: r.userId === userId }));
}

export async function createSavedFilter(actor: Actor, input: { name?: unknown; query?: unknown; shared?: unknown }): Promise<SavedFilter> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME) throw new HttpError(400, `Give the view a name of up to ${MAX_NAME} characters.`);
  const query = parseSavedQuery(input.query);
  const shared = input.shared === true;
  if (shared && !hasRole(actor, "admin")) throw new HttpError(403, "Only admins can share a view with the whole team.");
  const owner = shared ? SHARED_OWNER : actor.userId;
  const count = await prisma.savedInboxFilter.count({ where: { tenantId: actor.tenantId, userId: owner } });
  if (count >= MAX_PER_OWNER) throw new HttpError(409, `You can save up to ${MAX_PER_OWNER} views. Delete one first.`);
  const row = await prisma.savedInboxFilter.create({ data: { tenantId: actor.tenantId, userId: owner, name, query } });
  return { id: row.id, name: row.name, query, shared, mine: true };
}

export async function deleteSavedFilter(actor: Actor, id: string): Promise<void> {
  const row = await prisma.savedInboxFilter.findFirst({ where: { id, tenantId: actor.tenantId, userId: { in: [actor.userId, SHARED_OWNER] } }, select: { id: true, userId: true } });
  if (!row) throw new HttpError(404, "View not found.");
  if (row.userId === SHARED_OWNER && !hasRole(actor, "admin")) throw new HttpError(403, "Only admins can delete a shared view.");
  await prisma.savedInboxFilter.deleteMany({ where: { id, tenantId: actor.tenantId } });
}
