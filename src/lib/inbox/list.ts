import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { campaignConversationIds, flagsFor, markedConversationIds, type ConversationFlags } from "./marks";
import { MIN_TEXT_SEARCH } from "./search";
import { expiredWhere, statusWhere } from "./status";
import { SERVICE_WINDOW_MS } from "./window";

/** List views that are not a plain status: see docs/inbox-statuses.md for how each one is derived. */
export const INBOX_VIEWS = ["new", "campaign", "favorite", "mentioned", "active"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export const isInboxView = (value: unknown): value is InboxView => (INBOX_VIEWS as readonly unknown[]).includes(value);

export type ListConversationsParams = {
  assignedTo?: string | null;
  status?: string;
  unread?: boolean;
  expired?: boolean;
  tag?: string;
  search?: string;
  view?: string;
  /** The signed-in agent. Needed for favourites, mentions, the manual unread flag and the per-agent flags in the result. */
  viewerId?: string;
  cursor?: string;
  limit?: number;
  /** A where fragment ANDed into the query: what the caller may see (teams, view-only-assigned) and the chosen team. */
  scope?: Record<string, unknown>;
};

export type ConversationLabel = "new" | "campaign";

const clampLimit = (limit: number | undefined, fallback = 30) => Math.min(Math.max(Math.trunc(limit ?? fallback), 1), 100);

// Message-text search starts at MIN_TEXT_SEARCH characters (in ./search, which the search box reads too).
export { MIN_TEXT_SEARCH };
export const MESSAGE_HIT_LIMIT = 300;
const NO_MATCH = { id: { in: [] as string[] } };
/** Every list but Blocked leaves blocked chats out, and so does the unread badge (countUnreadConversations in ./stream). */
export const NOT_BLOCKED = { status: { not: "blocked" } };

export function searchDigits(text: string): string | null {
  const stripped = text.replace(/[\s\-().+]/g, "");
  return /^\d{3,15}$/.test(stripped) ? stripped : null;
}

/** A short excerpt around the first match, for the result row. */
export function makeSnippet(body: string, query: string, before = 24, after = 56): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, before + after);
  const start = Math.max(0, at - before);
  const end = Math.min(flat.length, at + query.length + after);
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

/** scope is the viewer's visibility fragment: hits in chats they cannot see must not use up the cap or leak an excerpt. */
async function messageHits(tenantId: string, text: string, scope?: Record<string, unknown>): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (text.length < MIN_TEXT_SEARCH) return hits;
  const rows = await prisma.message.findMany({
    where: { tenantId, body: { contains: text, mode: "insensitive" }, ...(scope && Object.keys(scope).length ? { conversation: scope as Prisma.ConversationWhereInput } : {}) },
    orderBy: { createdAt: "desc" },
    take: MESSAGE_HIT_LIMIT,
    select: { conversationId: true, body: true },
  });
  for (const r of rows) if (r.body && !hits.has(r.conversationId)) hits.set(r.conversationId, makeSnippet(r.body, text));
  return hits;
}

async function viewWhere(tenantId: string, viewerId: string | undefined, view: string, now: Date): Promise<Prisma.ConversationWhereInput | null> {
  if (view === "new") return { firstAgentReplyAt: null, lastInboundAt: { not: null }, status: { in: ["open", "pending"] } };
  if (view === "active") return { lastInboundAt: { gte: new Date(now.getTime() - SERVICE_WINDOW_MS) } };
  if (view === "campaign") return { id: { in: await campaignConversationIds(tenantId, undefined, now) } };
  if (view === "favorite" || view === "mentioned") {
    if (!viewerId) return NO_MATCH;
    return { id: { in: await markedConversationIds(tenantId, viewerId, view === "favorite" ? "favorite" : "mention") } };
  }
  return null;
}

type Labelled = { id: string; status: string; lastInboundAt: Date | null; firstAgentReplyAt?: Date | null };

/** "New": the customer wrote and no agent has replied yet. "Campaign": the last thing they received was a broadcast and they have not answered. */
export function newLabel(c: Labelled): boolean {
  return !c.firstAgentReplyAt && c.lastInboundAt !== null && (c.status === "open" || c.status === "pending");
}

export async function listConversations(tenantId: string, params: ListConversationsParams = {}) {
  const now = new Date();
  const limit = clampLimit(params.limit);
  const cursor = params.cursor && (await prisma.conversation.findFirst({ where: { id: params.cursor, tenantId }, select: { id: true } })) ? params.cursor : undefined;
  const search = params.search?.trim().slice(0, 100);
  const and: Prisma.ConversationWhereInput[] = [];

  let snippets = new Map<string, string>();
  if (search) {
    const digits = searchDigits(search);
    snippets = await messageHits(tenantId, search, params.scope);
    const contactMatch: Prisma.ContactWhereInput[] = [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: digits ?? search } },
      { username: { contains: search.replace(/^@+/, ""), mode: "insensitive" } },
      { bsuid: { contains: search, mode: "insensitive" } },
    ];
    and.push({ OR: [{ contact: { OR: contactMatch } }, ...(snippets.size ? [{ id: { in: [...snippets.keys()] } }] : [])] });
  }
  if (params.unread) {
    const manual = params.viewerId ? await markedConversationIds(tenantId, params.viewerId, "unread") : [];
    and.push({ OR: [{ unreadCount: { gt: 0 } }, ...(manual.length ? [{ id: { in: manual } }] : [])] });
  }
  if (params.scope && Object.keys(params.scope).length > 0) and.push(params.scope as Prisma.ConversationWhereInput);
  if (params.view) {
    const extra = await viewWhere(tenantId, params.viewerId, params.view, now);
    if (extra) and.push(extra);
  }
  // Blocked chats are spam the team chose to silence: they only show when the Blocked status is asked for.
  if (!params.status) and.push(NOT_BLOCKED);

  const rows = await prisma.conversation.findMany({
    where: {
      tenantId,
      ...(params.assignedTo !== undefined ? { assignedToId: params.assignedTo } : {}),
      ...(params.status ? (statusWhere(params.status) as Prisma.ConversationWhereInput) : {}),
      ...(params.expired ? (expiredWhere(now) as Prisma.ConversationWhereInput) : {}),
      ...(params.tag ? { tags: { has: params.tag } } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    include: {
      contact: { select: { id: true, phone: true, bsuid: true, username: true, name: true, optIn: true, optedOutAt: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, direction: true, type: true, body: true, status: true, createdAt: true } },
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null;
  if (!params.viewerId) return { items: page, nextCursor };

  const ids = page.map((c) => c.id);
  const [flags, campaign] = await Promise.all([flagsFor(tenantId, params.viewerId, ids), campaignConversationIds(tenantId, ids, now)]);
  const campaignSet = new Set(campaign);
  const none: ConversationFlags = { favorite: false, unread: false, mention: false };
  const items = page.map((c) => {
    const labels: ConversationLabel[] = [];
    if (newLabel(c)) labels.push("new");
    if (campaignSet.has(c.id)) labels.push("campaign");
    return { ...c, labels, flags: flags.get(c.id) ?? none, matchSnippet: snippets.get(c.id) ?? null };
  });
  return { items, nextCursor };
}
