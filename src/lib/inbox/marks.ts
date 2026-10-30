import { prisma } from "@/lib/db";
import { maskContact, rulesToWhere, viewerRules } from "@/lib/teams/visibility";
import { HttpError, type Actor } from "@/lib/tenancy";
import { extractMentions, type MentionMember } from "./mentions";

/**
 * Personal markers on a conversation, one row per agent (ConversationMark):
 * - favorite: the agent starred the chat.
 * - unread: the agent chose "Mark as unread". It only affects that agent; the shared unread counter is not touched.
 * - mention: another agent @mentioned this agent in a note. It is the in-app notification, cleared when the agent opens the chat.
 */
export const MARK_KINDS = ["favorite", "unread", "mention"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

const MAX_MARKED = 500;
/** Broadcast messages older than this no longer label a chat as a campaign chat. */
export const CAMPAIGN_WINDOW_DAYS = 30;

export const isMarkKind = (value: unknown): value is MarkKind => (MARK_KINDS as readonly unknown[]).includes(value);

async function requireConversationId(tenantId: string, conversationId: string) {
  const found = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { id: true } });
  if (!found) throw new HttpError(404, "Conversation not found.");
}

export async function setMark(tenantId: string, userId: string, conversationId: string, kind: MarkKind, on: boolean): Promise<void> {
  await requireConversationId(tenantId, conversationId);
  if (!on) {
    await prisma.conversationMark.deleteMany({ where: { tenantId, userId, conversationId, kind } });
    return;
  }
  await prisma.conversationMark.upsert({
    where: { conversationId_userId_kind: { conversationId, userId, kind } },
    create: { tenantId, conversationId, userId, kind },
    update: {},
  });
}

/** Called when an agent opens a chat: the manual unread flag and any mention notice are done. */
export async function clearReadMarks(tenantId: string, userId: string, conversationId: string): Promise<void> {
  await prisma.conversationMark.deleteMany({ where: { tenantId, userId, conversationId, kind: { in: ["unread", "mention"] } } });
}

export async function markedConversationIds(tenantId: string, userId: string, kind: MarkKind): Promise<string[]> {
  const rows = await prisma.conversationMark.findMany({
    where: { tenantId, userId, kind },
    orderBy: { createdAt: "desc" },
    take: MAX_MARKED,
    select: { conversationId: true },
  });
  return rows.map((r) => r.conversationId);
}

export type ConversationFlags = { favorite: boolean; unread: boolean; mention: boolean };

/** The viewer's own markers for a page of conversations. */
export async function flagsFor(tenantId: string, userId: string, conversationIds: string[]): Promise<Map<string, ConversationFlags>> {
  const out = new Map<string, ConversationFlags>();
  if (conversationIds.length === 0) return out;
  const rows = await prisma.conversationMark.findMany({
    where: { tenantId, userId, conversationId: { in: conversationIds } },
    select: { conversationId: true, kind: true },
  });
  for (const r of rows) {
    const flags = out.get(r.conversationId) ?? { favorite: false, unread: false, mention: false };
    if (isMarkKind(r.kind)) flags[r.kind] = true;
    out.set(r.conversationId, flags);
  }
  return out;
}

/**
 * Chats whose latest broadcast message (within CAMPAIGN_WINDOW_DAYS) has had no customer reply since: the "Campaign" label.
 * Derived from BroadcastRecipient.messageId, so nothing is stored. Pass conversationIds to label a page, or omit them to list.
 */
export async function campaignConversationIds(tenantId: string, conversationIds?: string[], now: Date = new Date()): Promise<string[]> {
  if (conversationIds && conversationIds.length === 0) return [];
  const since = new Date(now.getTime() - CAMPAIGN_WINDOW_DAYS * 86_400_000);
  const rows = conversationIds
    ? await prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT m."conversationId" AS id
        FROM "Message" m
        JOIN "BroadcastRecipient" r ON r."messageId" = m.id AND r."tenantId" = ${tenantId}
        JOIN "Conversation" c ON c.id = m."conversationId" AND c."tenantId" = ${tenantId}
        WHERE m."tenantId" = ${tenantId} AND m."conversationId" = ANY(${conversationIds}) AND m."createdAt" > ${since}
          AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" < m."createdAt")`
    : await prisma.$queryRaw<{ id: string }[]>`
        SELECT m."conversationId" AS id
        FROM "Message" m
        JOIN "BroadcastRecipient" r ON r."messageId" = m.id AND r."tenantId" = ${tenantId}
        JOIN "Conversation" c ON c.id = m."conversationId" AND c."tenantId" = ${tenantId}
        WHERE m."tenantId" = ${tenantId} AND m."createdAt" > ${since}
          AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" < m."createdAt")
        GROUP BY m."conversationId"
        ORDER BY MAX(m."createdAt") DESC
        LIMIT ${MAX_MARKED}`;
  return rows.map((r) => r.id);
}

type Viewer = Pick<Actor, "tenantId" | "userId" | "role">;

export async function listMembers(tenantId: string): Promise<MentionMember[]> {
  const rows = await prisma.membership.findMany({ where: { tenantId }, select: { userId: true, user: { select: { name: true } } } });
  return rows.map((r) => ({ userId: r.userId, name: r.user.name }));
}

/** True when this teammate may open the chat under the workspace's visibility rules (view-only-assigned, team visibility). */
async function memberMaySee(viewer: Viewer, conversationId: string): Promise<boolean> {
  const scope = rulesToWhere(viewer, await viewerRules(viewer));
  if (!scope) return true;
  const found = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: viewer.tenantId, ...scope }, select: { id: true } });
  return found !== null;
}

/**
 * Marks the chat for every @mentioned teammate (never the author). A teammate who cannot see the chat is skipped, so a mention can
 * never reveal a chat to someone the visibility rules keep out of it. Returns the notified user ids.
 */
export async function notifyMentions(tenantId: string, authorId: string, conversationId: string, body: string): Promise<string[]> {
  if (!body.includes("@")) return [];
  const members = await prisma.membership.findMany({ where: { tenantId }, select: { userId: true, role: true, user: { select: { name: true } } } });
  const ids = extractMentions(body, members.map((m) => ({ userId: m.userId, name: m.user.name })), authorId);
  const notified: string[] = [];
  for (const userId of ids) {
    const role = members.find((m) => m.userId === userId)?.role as Actor["role"] | undefined;
    if (!role || !(await memberMaySee({ tenantId, userId, role }, conversationId))) continue;
    await prisma.conversationMark.upsert({
      where: { conversationId_userId_kind: { conversationId, userId, kind: "mention" } },
      create: { tenantId, conversationId, userId, kind: "mention" },
      update: { createdAt: new Date() },
    });
    notified.push(userId);
  }
  return notified;
}

export type MentionNotice = { conversationId: string; contactName: string | null; phone: string | null; bsuid?: string | null; username?: string | null; mentionedAt: Date };

/**
 * The viewer's unread mentions, newest first. Only chats the viewer may see are listed (the same scope as the inbox list, so a
 * mention left over from before a visibility change shows nothing), and the phone is masked when the viewer's number is masked.
 */
export async function listMentions(viewer: Viewer): Promise<MentionNotice[]> {
  const { tenantId, userId } = viewer;
  const marks = await prisma.conversationMark.findMany({
    where: { tenantId, userId, kind: "mention" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { conversationId: true, createdAt: true },
  });
  if (marks.length === 0) return [];
  const rules = await viewerRules(viewer);
  const conversations = await prisma.conversation.findMany({
    where: { tenantId, id: { in: marks.map((m) => m.conversationId) }, ...(rulesToWhere(viewer, rules) ?? {}) },
    select: { id: true, contact: { select: { name: true, phone: true, bsuid: true, username: true } } },
  });
  const byId = new Map(conversations.map((c) => [c.id, maskContact(c.contact, rules.maskPhone)]));
  return marks.flatMap((m) => {
    const contact = byId.get(m.conversationId);
    return contact ? [{ conversationId: m.conversationId, contactName: contact.name, phone: contact.phone, bsuid: contact.bsuid, username: contact.username, mentionedAt: m.createdAt }] : [];
  });
}
