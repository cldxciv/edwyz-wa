/**
 * Inbox operations shared by the app routes and the action layer (docs/EDDY-SPEC.md 4.4, EDDY-04). The logic used to live
 * inline in PUT /api/inbox/conversations/[id]/assign and /tags; both routes now call these functions, and so do the Eddy
 * definitions, so the rules are written once:
 * - assignAsActor: agents may only take an unassigned chat for themselves or release their own; admins and owners may
 *   assign anyone in the chat's team pool. The write is routing's applyAssignment, the same one the routing route and bulk
 *   assign use: a disabled account is refused, round-robin sees the assignment and a routing.assign row is written.
 * - setTagsAsActor: a diff ({add, remove}) applied with a compare-and-set on the stored tags, so an edit made at the same
 *   moment by someone else is kept, never overwritten. `{set}` keeps the route's replace-the-list contract.
 */
import type { Conversation } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { emitTagChanges } from "@/lib/automation/v2/emit";
import { assertCanActOnConversation, canActOn } from "@/lib/inbox/status";
import { applyAssignment } from "@/lib/routing";
import { assertConversationVisible } from "@/lib/teams/visibility";
import { HttpError, type Actor } from "@/lib/tenancy";

export const AGENT_ASSIGN_MESSAGE = "Agents can only take unassigned chats for themselves or release their own.";

/** "me" is the caller, "none" (or null) releases the chat, any other value is a teammate's user id. */
export type AssignTarget = "me" | "none" | string;

export type AssignResult = {
  conversation: Conversation | null;
  /** Who had the chat before, for Undo and stillApplies. */
  previousAssigneeId: string | null;
  assigneeId: string | null;
};

export async function assignAsActor(actor: Actor, conversationId: string, to: AssignTarget | null): Promise<AssignResult> {
  const userId = to === null || to === "none" ? null : to === "me" ? actor.userId : to;
  if (userId !== null && (typeof userId !== "string" || !userId)) throw new HttpError(400, "userId must be a string or null.");
  await assertConversationVisible(actor, conversationId);
  const current = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { id: true, assignedToId: true, teamId: true } });
  if (!current) throw new HttpError(404, "Conversation not found.");
  if (actor.role === "agent" && (!canActOn(actor, current.assignedToId) || (userId !== null && userId !== actor.userId))) {
    throw new HttpError(403, AGENT_ASSIGN_MESSAGE);
  }
  await applyAssignment(actor, current, userId);
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId } });
  return { conversation, previousAssigneeId: current.assignedToId ?? null, assigneeId: userId };
}

export const MAX_TAG_LENGTH = 40;
/** The most tags one chat carries through these operations (the route's limit). */
export const MAX_CHAT_TAGS = 20;
const MAX_ATTEMPTS = 5;

export type TagChange = { add?: readonly string[]; remove?: readonly string[] } | { set: readonly string[] };

export type TagsResult = {
  conversation: Conversation | null;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
};

function cleanList(value: readonly string[] | undefined, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list of tags.`);
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new HttpError(400, `${field} must be a list of tags.`);
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new HttpError(400, `Each tag must be at most ${MAX_TAG_LENGTH} characters.`);
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** The tags after the change: removals first, then additions appended in order (exact, case-sensitive, like the bulk tag action). */
export function nextTags(current: readonly string[], change: TagChange): string[] {
  if ("set" in change) return cleanList(change.set, "tags");
  const add = cleanList(change.add, "add");
  const remove = new Set(cleanList(change.remove, "remove"));
  const kept = current.filter((t) => !remove.has(t));
  for (const tag of add) if (!kept.includes(tag)) kept.push(tag);
  return kept;
}

export async function setTagsAsActor(actor: Actor, conversationId: string, change: TagChange): Promise<TagsResult> {
  if (!("set" in change)) {
    const add = cleanList(change.add, "add");
    const remove = cleanList(change.remove, "remove");
    if (add.some((t) => remove.includes(t))) throw new HttpError(400, "A tag cannot be added and removed in the same change.");
  } else {
    cleanList(change.set, "tags");
  }
  await assertConversationVisible(actor, conversationId);
  await assertCanActOnConversation(actor, conversationId);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { contactId: true, tags: true } });
    if (!row) throw new HttpError(404, "Conversation not found.");
    const before = [...(row.tags ?? [])];
    const after = nextTags(before, change);
    const added = after.filter((t) => !before.includes(t));
    const removed = before.filter((t) => !after.includes(t));
    if (added.length > 0 && after.length > MAX_CHAT_TAGS) throw new HttpError(400, `A chat can have at most ${MAX_CHAT_TAGS} tags. Remove one first.`);
    if (sameList(before, after)) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId } });
      return { conversation, before, after, added, removed };
    }
    // Compare-and-set: the write applies only if nobody changed the tags since they were read; otherwise read and retry.
    const { count } = await prisma.conversation.updateMany({ where: { id: conversationId, tenantId: actor.tenantId, tags: { equals: before } }, data: { tags: after } });
    if (count === 0) continue;
    void emitTagChanges({ tenantId: actor.tenantId, contactId: row.contactId, conversationId }, before, after);
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId } });
    return { conversation, before, after, added, removed };
  }
  throw new HttpError(409, "The tags changed several times while saving. Try again.");
}
