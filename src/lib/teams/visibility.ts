import { prisma } from "@/lib/db";
import { getExtra, inScope } from "@/lib/routing/extra";
import { HttpError, type Actor } from "@/lib/tenancy";
import { ensureDefaultTeam } from "./pool";

type Viewer = Pick<Actor, "tenantId" | "userId" | "role">;
type Where = Record<string, unknown>;

export type ViewerRules = {
  /** Sees only chats assigned to them. */
  onlyAssigned: boolean;
  /** Sees chats of these teams (and their own); null means no team restriction. */
  teamIds: string[] | null;
  /** Also sees chats with no team (the default team's chats). */
  includeUnteamed: boolean;
  maskPhone: boolean;
};

const OPEN: ViewerRules = { onlyAssigned: false, teamIds: null, includeUnteamed: true, maskPhone: false };

/** Owners and admins are never restricted, so they cost no extra query. */
export async function viewerRules(actor: Viewer): Promise<ViewerRules> {
  if (actor.role !== "agent") return OPEN;
  const extra = await getExtra(actor.tenantId);
  const rules: ViewerRules = { ...OPEN, onlyAssigned: inScope(extra.viewOnlyAssigned, actor), maskPhone: inScope(extra.maskPhone, actor) };
  if (!rules.onlyAssigned && extra.teamVisibility) {
    const [mine, def] = await Promise.all([
      prisma.teamMember.findMany({ where: { tenantId: actor.tenantId, userId: actor.userId }, select: { teamId: true } }),
      ensureDefaultTeam(actor.tenantId),
    ]);
    const defaultMembers = await prisma.teamMember.findMany({ where: { tenantId: actor.tenantId, teamId: def.id }, select: { userId: true } });
    const ids = mine.map((m) => m.teamId);
    rules.teamIds = ids;
    rules.includeUnteamed = defaultMembers.length === 0 || ids.includes(def.id);
  }
  return rules;
}

export function rulesToWhere(actor: Viewer, rules: ViewerRules): Where | null {
  if (rules.onlyAssigned) return { assignedToId: actor.userId };
  if (rules.teamIds === null) return null;
  const any: Where[] = [{ assignedToId: actor.userId }];
  if (rules.teamIds.length) any.push({ teamId: { in: rules.teamIds } });
  if (rules.includeUnteamed) any.push({ teamId: null });
  return { OR: any };
}

/** Value of the inbox "team" filter: a team id, or "none" for chats with no team. */
export async function teamFilterWhere(tenantId: string, team: string | null | undefined): Promise<Where | null> {
  if (!team) return null;
  if (team === "none") return { teamId: null };
  if (team.length > 64) throw new HttpError(400, "Unknown team.");
  const row = await prisma.team.findFirst({ where: { id: team, tenantId }, select: { id: true, isDefault: true } });
  if (!row) throw new HttpError(400, "Unknown team.");
  return row.isDefault ? { OR: [{ teamId: row.id }, { teamId: null }] } : { teamId: row.id };
}

/** A where fragment to AND into any conversation query: what this person may see, narrowed to the chosen team. */
export async function inboxScopeWhere(actor: Viewer, opts: { team?: string | null; rules?: ViewerRules; search?: string | null } = {}): Promise<Where> {
  const rules = opts.rules ?? (await viewerRules(actor));
  const parts = [rulesToWhere(actor, rules), await teamFilterWhere(actor.tenantId, opts.team), rules.maskPhone ? maskedSearchWhere(opts.search) : null].filter((p): p is Where => p !== null);
  return parts.length ? { AND: parts } : {};
}

export async function assertConversationVisible(actor: Viewer, conversationId: string): Promise<void> {
  const rules = await viewerRules(actor);
  const scope = rulesToWhere(actor, rules);
  if (!scope) return;
  const found = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: actor.tenantId, ...scope }, select: { id: true } });
  if (!found) throw new HttpError(404, "Conversation not found.");
}

/** Ids from the list the person may see, in the same order. */
export async function visibleConversationIds(actor: Viewer, ids: string[]): Promise<Set<string>> {
  const scope = rulesToWhere(actor, await viewerRules(actor));
  if (!scope) return new Set(ids);
  const rows = await prisma.conversation.findMany({ where: { tenantId: actor.tenantId, id: { in: ids }, ...scope }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** First three and last four digits stay visible, e.g. +919*****3210. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return `${"*".repeat(Math.max(digits.length - 2, 1))}${digits.slice(-2)}`;
  return `${phone.trim().startsWith("+") ? "+" : ""}${digits.slice(0, 3)}${"*".repeat(digits.length - 7)}${digits.slice(-4)}`;
}

type PhoneFields = { phone?: string | null; waId?: string | null };

export function maskContact<T extends PhoneFields | null | undefined>(contact: T, on: boolean): T {
  if (!on || !contact) return contact;
  const out = { ...contact } as PhoneFields;
  if (typeof out.phone === "string") out.phone = maskPhone(out.phone);
  if (typeof out.waId === "string") out.waId = maskPhone(out.waId);
  return out as T;
}

/** The characters the inbox search strips before it treats a query as a phone number (see searchDigits), so both agree on what a number query is. */
export const DIGIT_QUERY = /^[\d\s+().-]+$/;

/** A masked person who types only digits is searching by the end of the number, so a short run of digits cannot be slid along the number to read its middle. */
export function maskedSearchWhere(search: string | null | undefined): Where | null {
  const text = (search ?? "").trim();
  if (!DIGIT_QUERY.test(text)) return null;
  const digits = text.replace(/\D/g, "");
  return digits ? { contact: { phone: { endsWith: digits } } } : null;
}

/** A masked person may search names and the last four digits, never a longer part of the number. */
export function searchAllowed(query: string | undefined | null, masked: boolean): boolean {
  if (!masked || !query) return true;
  return query.replace(/\D/g, "").length <= 4;
}

export async function shouldMaskFor(actor: Viewer): Promise<boolean> {
  return (await viewerRules(actor)).maskPhone;
}

/** The where fragment that limits conversations for this person, or null when they may see all of them. */
export async function conversationScopeFor(actor: Viewer): Promise<Where | null> {
  return rulesToWhere(actor, await viewerRules(actor));
}

/** Contacts a restricted person may see: those they own, and those with a chat they may see. null means all contacts. */
export function contactScopeWhere(actor: Viewer, rules: ViewerRules): Where | null {
  const scope = rulesToWhere(actor, rules);
  return scope ? { OR: [{ ownerUserId: actor.userId }, { conversations: { some: scope } }] } : null;
}

export async function assertContactVisible(actor: Viewer, contactId: string): Promise<void> {
  const scope = contactScopeWhere(actor, await viewerRules(actor));
  if (!scope) return;
  const found = await prisma.contact.findFirst({ where: { id: contactId, tenantId: actor.tenantId, ...scope }, select: { id: true } });
  if (!found) throw new HttpError(404, "Contact not found.");
}

/**
 * A function that keeps only the conversation ids this person may see, computed from rules read once, or null when they may see all.
 * Used by the live stream, which would otherwise tell a restricted agent that hidden chats are active.
 */
export async function visibleIdsFilter(actor: Viewer): Promise<((ids: string[]) => Promise<string[]>) | null> {
  const scope = rulesToWhere(actor, await viewerRules(actor));
  if (!scope) return null;
  return async (ids) => {
    if (ids.length === 0) return [];
    const rows = await prisma.conversation.findMany({ where: { tenantId: actor.tenantId, id: { in: ids }, ...scope }, select: { id: true } });
    return rows.map((r) => r.id);
  };
}

const PHONE_FIELD = /phone|mobile|whatsapp|contact.?number|\btel(?:ephone)?\b/i;

/** Lead form answers for a masked viewer: phone-like answers (by field name, or a value that is mostly digits) are masked. */
export function maskLeadFields<T extends { label: string; value: string }>(fields: T[], on: boolean): T[] {
  if (!on) return fields;
  return fields.map((f) => {
    const digits = f.value.replace(/\D/g, "");
    const looksLikeNumber = digits.length >= 7 && digits.length >= f.value.replace(/\s/g, "").length * 0.6;
    return PHONE_FIELD.test(f.label) || looksLikeNumber ? { ...f, value: maskPhone(f.value) } : f;
  });
}
