import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { emitAutomationEvent, emitTagChanges } from "@/lib/automation/v2/emit";
import { endBotsOnBlock } from "@/lib/chatbots/human-reply";
import { emitStatusChanged } from "@/lib/integrations/emitters";
import { hasRole, HttpError, type Actor } from "@/lib/tenancy";
import { canTransition, normalizeStatus, SETTABLE_STATUSES } from "./status-rules";
import { SERVICE_WINDOW_MS } from "./window";

export * from "./status-rules";

export const MAX_BULK_IDS = 100;
const MAX_TAGS_PER_OP = 10;
const MAX_TAG_LENGTH = 40;

/** Agents may only touch conversations assigned to them or unassigned. */
export function canActOn(actor: Pick<Actor, "userId" | "role">, assignedToId: string | null): boolean {
  return hasRole(actor as Actor, "admin") || assignedToId === null || assignedToId === actor.userId;
}

/** Throws 403 when an agent tries to write to a chat assigned to a teammate (messages, notes, tags). Use after assertConversationVisible. */
export async function assertCanActOnConversation(actor: Actor, conversationId: string) {
  if (hasRole(actor, "admin")) return;
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId }, select: { assignedToId: true } });
  if (!conv) throw new HttpError(404, "Conversation not found.");
  if (!canActOn(actor, conv.assignedToId)) throw new HttpError(403, "This conversation is assigned to someone else.");
}

export function assertCanSetStatus(actor: Pick<Actor, "role">, to: string) {
  const status = normalizeStatus(to);
  if (!status || !(SETTABLE_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "Invalid status.");
  if (status === "blocked" && !hasRole(actor as Actor, "admin")) throw new HttpError(403, "Only admins can block a conversation.");
  return status;
}

/** Prisma where-fragments for the list filters. lastInboundField is prisma.conversation.fields.lastInboundAt. */
export function statusWhere(status: string): Record<string, unknown> {
  return normalizeStatus(status) === "solved" ? { status: { in: ["solved", "resolved"] } } : { status };
}

/** Open or pending chats whose last customer message is older than the 24-hour window (see deriveStatus). The second argument is kept for older callers. */
export function expiredWhere(now: Date, _lastInboundField?: unknown): Record<string, unknown> {
  return {
    status: { in: ["open", "pending", "expired"] },
    lastInboundAt: { lt: new Date(now.getTime() - SERVICE_WINDOW_MS) },
  };
}

export async function setStatus(actor: Actor, conversationId: string, status: string) {
  const to = assertCanSetStatus(actor, status);
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: actor.tenantId },
    select: { id: true, status: true, assignedToId: true, contactId: true },
  });
  if (!conv) throw new HttpError(404, "Conversation not found.");
  if (!canActOn(actor, conv.assignedToId)) throw new HttpError(403, "This conversation is assigned to someone else.");
  if (!canTransition(conv.status, to)) throw new HttpError(409, `A ${conv.status} conversation cannot become ${to}.`);
  if (normalizeStatus(conv.status) === to) return prisma.conversation.findFirst({ where: { id: conv.id, tenantId: actor.tenantId } });

  await prisma.conversation.updateMany({
    where: { id: conv.id, tenantId: actor.tenantId },
    data: { status: to, statusChangedAt: new Date() },
  });
  if (to === "blocked") await endBotsOnBlock(actor.tenantId, [conv.id]);
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "inbox.status.set", target: conv.id, meta: { from: conv.status, to } });
  if (conv.contactId) void emitAutomationEvent({ type: "status_changed", tenantId: actor.tenantId, contactId: conv.contactId, conversationId: conv.id, from: conv.status, to });
  await emitStatusChanged(actor.tenantId, { conversationId: conv.id, contactId: conv.contactId ?? null, from: normalizeStatus(conv.status) ?? conv.status, to, changedBy: actor.userId, source: "user" });
  return prisma.conversation.findFirst({ where: { id: conv.id, tenantId: actor.tenantId } });
}

/** Called by the webhook processor after storing an inbound message. Returns true when a solved conversation was reopened. */
export async function reopenOnInbound(tenantId: string, conversationId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, tenantId, status: { in: ["solved", "resolved"] } },
    data: { status: "open", statusChangedAt: now },
  });
  if (count > 0) {
    await audit({ tenantId, action: "inbox.status.reopened", target: conversationId, meta: { from: "solved", to: "open" } });
    await emitStatusChanged(tenantId, { conversationId, contactId: null, from: "solved", to: "open", source: "system" });
  }
  return count > 0;
}

export type BulkInput =
  | { ids: string[]; action: "status"; status: string }
  | { ids: string[]; action: "assign"; userId: string | null }
  | { ids: string[]; action: "tag"; add: string[]; remove: string[] };

function cleanTags(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_OP) throw new HttpError(400, `${field} must be a list of at most ${MAX_TAGS_PER_OP} tags.`);
  const out = value.map((t) => {
    if (typeof t !== "string" || !t.trim() || t.trim().length > MAX_TAG_LENGTH) throw new HttpError(400, `Each tag must be 1-${MAX_TAG_LENGTH} characters.`);
    return t.trim();
  });
  return [...new Set(out)];
}

/** Validates an untrusted request body. */
export function parseBulkInput(body: Record<string, unknown>): BulkInput {
  const raw = body.ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_IDS) throw new HttpError(400, `ids must contain 1 to ${MAX_BULK_IDS} conversation ids.`);
  if (raw.some((id) => typeof id !== "string" || !id || id.length > 64)) throw new HttpError(400, "ids must be strings.");
  const ids = [...new Set(raw as string[])];

  if (body.action === "status") {
    if (typeof body.status !== "string") throw new HttpError(400, "status is required.");
    return { ids, action: "status", status: body.status };
  }
  if (body.action === "assign") {
    if (body.userId !== null && (typeof body.userId !== "string" || !body.userId)) throw new HttpError(400, "userId must be a string or null.");
    return { ids, action: "assign", userId: body.userId as string | null };
  }
  if (body.action === "tag") {
    const add = cleanTags(body.add, "add");
    const remove = cleanTags(body.remove, "remove");
    if (add.length + remove.length === 0) throw new HttpError(400, "Provide tags to add or remove.");
    return { ids, action: "tag", add, remove };
  }
  throw new HttpError(400, "action must be status, assign or tag.");
}

export type BulkResult = { updated: number; skipped: { id: string; reason: string }[] };

export function applyTagChange(current: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove);
  return [...new Set([...current.filter((t) => !removed.has(t)), ...add])];
}

export async function bulkUpdate(actor: Actor, input: BulkInput): Promise<BulkResult> {
  if (input.action === "assign" && actor.role === "agent" && input.userId !== null && input.userId !== actor.userId) {
    throw new HttpError(403, "Agents can only assign chats to themselves.");
  }
  const to = input.action === "status" ? assertCanSetStatus(actor, input.status) : null;
  if (input.action === "assign" && input.userId) {
    const member = await prisma.membership.findFirst({ where: { tenantId: actor.tenantId, userId: input.userId }, select: { id: true } });
    if (!member) throw new HttpError(400, "That user is not a member of this workspace.");
  }

  const rows = await prisma.conversation.findMany({
    where: { tenantId: actor.tenantId, id: { in: input.ids } },
    select: { id: true, status: true, assignedToId: true, tags: true, contactId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skipped: BulkResult["skipped"] = [];
  const eligible: typeof rows = [];
  for (const id of input.ids) {
    const row = byId.get(id);
    if (!row) skipped.push({ id, reason: "not_found" });
    else if (!canActOn(actor, row.assignedToId)) skipped.push({ id, reason: "assigned_to_other" });
    else if (to && !canTransition(row.status, to)) skipped.push({ id, reason: "invalid_transition" });
    else eligible.push(row);
  }

  const ids = eligible.map((r) => r.id);
  const where = { tenantId: actor.tenantId, id: { in: ids } };
  if (ids.length > 0) {
    const now = new Date();
    if (input.action === "status") {
      await prisma.conversation.updateMany({ where, data: { status: to!, statusChangedAt: now } });
      if (to === "blocked") await endBotsOnBlock(actor.tenantId, ids);
      for (const row of eligible) {
        if (row.contactId && row.status !== to) void emitAutomationEvent({ type: "status_changed", tenantId: actor.tenantId, contactId: row.contactId, conversationId: row.id, from: row.status, to: to! });
        await emitStatusChanged(actor.tenantId, { conversationId: row.id, contactId: row.contactId ?? null, from: normalizeStatus(row.status) ?? row.status, to: to!, changedBy: actor.userId, source: "user" });
      }
    }
    else if (input.action === "assign") await prisma.conversation.updateMany({ where, data: { assignedToId: input.userId, assignedAt: input.userId ? now : null } });
    else {
      for (const row of eligible) {
        const next = applyTagChange(row.tags, input.add, input.remove);
        await prisma.conversation.updateMany({
          where: { id: row.id, tenantId: actor.tenantId },
          data: { tags: next },
        });
        if (row.contactId) void emitTagChanges({ tenantId: actor.tenantId, contactId: row.contactId, conversationId: row.id }, row.tags, next);
      }
    }
  }
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: `inbox.bulk.${input.action}`, meta: { requested: input.ids.length, updated: ids.length } });
  return { updated: ids.length, skipped };
}
