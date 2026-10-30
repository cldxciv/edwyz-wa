/**
 * What a member sees of the notice store (docs/EDDY-SPEC.md 6.7): the "Needs you" strip, the launcher dot and the toasts.
 *
 * - Visible: the workspace's notices that are open (not resolved, not expired), meant for everyone at or above the member's
 *   role (audienceMinRole) or for this member alone (audienceUserId), not dismissed by them, and not of a kind they muted
 *   ("Don't show these", EddyUserPref.mutedNoticeKinds). Team members therefore get their own chats' and sends' notices;
 *   admins and owners get the workspace's; approvals go only to the people who can decide them (the producer writes one
 *   per decider). A Phase 0 row an Eddy notice already covers is hidden (kinds.ts supersededSpendRow).
 * - Toasts: one sticky toast per member per action_needed notice, claimed here once (NoticeReceipt.toastedAt), so two tabs
 *   never both show it.
 * - Receipts: seen, dismissed, and the toast claim, per member.
 * - Display names ({name}, {phone}, {names}) are read from the ids when the member reads the notice, inside their own
 *   workspace, and never stored in the row: template and broadcast names, the business number, a teammate's first name.
 *   Customer data is never needed by any notice text.
 */
import type { NoticeDTO, NoticeSeverity, NoticeSource } from "@/lib/eddy/contract";
import { prisma } from "@/lib/db";
import { ROLE_RANK, type Actor } from "@/lib/tenancy";
import { SEVERITY_RANK, cleanActions, cleanPayload, isSeverity, supersededSpendRow, textKeyFor, type NoticePayload } from "./kinds";

/** At most this many notices go to the strip ("See all" shows them all). */
export const MAX_VISIBLE_NOTICES = 50;

type NoticeRow = {
  id: string;
  tenantId: string;
  kind: string;
  severity: string;
  audienceUserId: string | null;
  audienceMinRole: Actor["role"];
  dedupeKey: string;
  subjectType: string | null;
  subjectId: string | null;
  payload: unknown;
  actions: unknown;
  count: number;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
};
type ReceiptRow = { noticeId: string; seenAt: Date | null; dismissedAt: Date | null; toastedAt: Date | null };

const SELECT = {
  id: true,
  tenantId: true,
  kind: true,
  severity: true,
  audienceUserId: true,
  audienceMinRole: true,
  dedupeKey: true,
  subjectType: true,
  subjectId: true,
  payload: true,
  actions: true,
  count: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  resolvedAt: true,
} as const;

/** The member's muted kinds (EddyUserPref). */
export async function mutedKinds(actor: Pick<Actor, "tenantId" | "userId">): Promise<Set<string>> {
  const pref = (await prisma.eddyUserPref.findFirst({ where: { tenantId: actor.tenantId, userId: actor.userId }, select: { mutedNoticeKinds: true } })) as { mutedNoticeKinds: string[] } | null;
  return new Set(pref?.mutedNoticeKinds ?? []);
}

/** The open notices this member may see, newest first, before mutes and dismissals. */
async function openFor(actor: Actor, now: Date): Promise<NoticeRow[]> {
  const rows = (await prisma.notice.findMany({
    where: { tenantId: actor.tenantId, resolvedAt: null, expiresAt: { gt: now }, OR: [{ audienceUserId: null }, { audienceUserId: actor.userId }] },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: SELECT,
  })) as NoticeRow[];
  // A notice for one member is theirs whatever their role; a workspace notice needs the role floor.
  return rows.filter((n) => n.audienceUserId === actor.userId || ROLE_RANK[actor.role] >= (ROLE_RANK[n.audienceMinRole] ?? ROLE_RANK.agent));
}

export type VisibleNotices = { notices: NoticeDTO[]; needsYou: number };

/** Severity first (action needed, heads-up, for your information), then the most recently changed. */
export function orderForStrip<T extends { severity: string; updatedAt: string | Date }>(list: readonly T[]): T[] {
  const time = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));
  return [...list].sort((a, b) => (SEVERITY_RANK[a.severity as NoticeSeverity] ?? 9) - (SEVERITY_RANK[b.severity as NoticeSeverity] ?? 9) || time(b.updatedAt) - time(a.updatedAt));
}

/** The notices the member sees now (the strip), with the count for the launcher dot. */
export async function listNotices(actor: Actor, opts: { now?: Date } = {}): Promise<VisibleNotices> {
  const now = opts.now ?? new Date();
  const rows = await openFor(actor, now);
  if (rows.length === 0) return { notices: [], needsYou: 0 };
  const [muted, receipts] = await Promise.all([
    mutedKinds(actor),
    prisma.noticeReceipt.findMany({ where: { tenantId: actor.tenantId, userId: actor.userId, noticeId: { in: rows.map((r) => r.id) } }, select: { noticeId: true, seenAt: true, dismissedAt: true, toastedAt: true } }) as Promise<ReceiptRow[]>,
  ]);
  const byId = new Map(receipts.map((r) => [r.noticeId, r]));
  const eddyRows = rows.filter((r) => r.source !== "spend");
  const visible = rows.filter((r) => !muted.has(r.kind) && !byId.get(r.id)?.dismissedAt && !supersededSpendRow(r, eddyRows));
  const names = await displayNames(actor.tenantId, visible);
  const notices = orderForStrip(visible.map((r) => toDTO(r, byId.get(r.id) ?? null, names))).slice(0, MAX_VISIBLE_NOTICES);
  return { notices, needsYou: notices.filter((n) => n.severity === "action_needed" || n.severity === "heads_up").length };
}

/** The NoticeDTO of a row: the payload cleaned again on the way out, the display vars added, the buttons re-checked. */
export function toDTO(r: NoticeRow, receipt: ReceiptRow | null, names: DisplayNames = EMPTY_NAMES): NoticeDTO {
  const source = (r.source === "spend" || r.source === "system" ? r.source : "eddy") as NoticeSource;
  const stored = cleanPayload(r.payload);
  const payload: NoticePayload = { ...stored, count: r.count, ...displayVars(r, stored, names) };
  // Phase 0's own rows carry its English sentences (src/lib/spend/notify): passed through as they are, for that strip line.
  if (source === "spend") {
    const raw = r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
    if (typeof raw.title === "string") payload.title = raw.title.slice(0, 200);
    if (typeof raw.body === "string") payload.body = raw.body.slice(0, 600);
  }
  return {
    id: r.id,
    kind: r.kind,
    severity: isSeverity(r.severity) ? r.severity : "fyi",
    source,
    // The count lives in its own column; the text key depends on it (one approval, a red rating with paused broadcasts).
    textKey: textKeyFor(r.kind, { ...stored, count: r.count }, source),
    payload,
    actions: cleanActions(r.actions, r.id),
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    count: r.count,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    seenAt: receipt?.seenAt ? receipt.seenAt.toISOString() : null,
    dismissedAt: receipt?.dismissedAt ? receipt.dismissedAt.toISOString() : null,
    toastedAt: receipt?.toastedAt ? receipt.toastedAt.toISOString() : null,
  };
}

// ===== Display names, resolved at read time =====

export type DisplayNames = { templates: Map<string, string>; broadcasts: Map<string, string>; phones: Map<string, string>; users: Map<string, string> };
const EMPTY_NAMES: DisplayNames = { templates: new Map(), broadcasts: new Map(), phones: new Map(), users: new Map() };

const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clip = (s: string, max = 80) => s.replace(CONTROL, "").trim().slice(0, max);
const ids = (v: unknown) => (typeof v === "string" && v ? v.split(",").filter(Boolean) : []);

async function displayNames(tenantId: string, rows: readonly NoticeRow[]): Promise<DisplayNames> {
  const templateIds = new Set<string>();
  const broadcastIds = new Set<string>();
  const phoneIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rows) {
    const p = cleanPayload(r.payload);
    if (typeof p.templateId === "string") templateIds.add(p.templateId);
    for (const id of ids(p.broadcastIds).slice(0, 3)) broadcastIds.add(id);
    if (typeof p.phoneId === "string") phoneIds.add(p.phoneId);
    if (typeof p.byUserId === "string") userIds.add(p.byUserId);
  }
  const none = Promise.resolve([] as Record<string, unknown>[]);
  const [templates, broadcasts, phones, users] = await Promise.all([
    templateIds.size ? (prisma.template.findMany({ where: { tenantId, id: { in: [...templateIds] } }, select: { id: true, name: true } }) as Promise<Record<string, unknown>[]>) : none,
    broadcastIds.size ? (prisma.broadcast.findMany({ where: { tenantId, id: { in: [...broadcastIds] } }, select: { id: true, name: true } }) as Promise<Record<string, unknown>[]>) : none,
    phoneIds.size ? (prisma.phoneNumber.findMany({ where: { tenantId, id: { in: [...phoneIds] } }, select: { id: true, displayPhone: true } }) as Promise<Record<string, unknown>[]>) : none,
    userIds.size ? (prisma.membership.findMany({ where: { tenantId, userId: { in: [...userIds] } }, select: { userId: true, user: { select: { name: true } } } }) as Promise<Record<string, unknown>[]>) : none,
  ]);
  const map = (list: Record<string, unknown>[], key: string, value: (r: Record<string, unknown>) => unknown) =>
    new Map(list.filter((r) => typeof value(r) === "string").map((r) => [String(r[key]), clip(String(value(r)))]));
  return {
    templates: map(templates, "id", (r) => r.name),
    broadcasts: map(broadcasts, "id", (r) => r.name),
    phones: map(phones, "id", (r) => r.displayPhone),
    users: map(users, "userId", (r) => {
      const name = (r.user as { name?: unknown } | null)?.name;
      return typeof name === "string" ? name.trim().split(/\s+/)[0] : undefined;
    }),
  };
}

/** The {placeholders} a notice's text needs, from its ids. Missing names fall back to a neutral word, never to an id. */
function displayVars(r: NoticeRow, p: NoticePayload, names: DisplayNames): NoticePayload {
  const out: NoticePayload = {};
  if (typeof p.templateId === "string") out.name = names.templates.get(p.templateId) ?? "";
  if (typeof p.phoneId === "string") out.phone = names.phones.get(p.phoneId) ?? "";
  const listed = ids(p.broadcastIds);
  if (listed.length) {
    const shown = listed.slice(0, 3).map((id) => names.broadcasts.get(id)).filter((n): n is string => !!n);
    const more = Math.max(0, (typeof p.count === "number" ? p.count : r.count) - shown.length);
    out.names = more > 0 && shown.length ? `${shown.join(", ")} +${more}` : shown.join(", ");
  }
  if (typeof p.byUserId === "string") out.name = names.users.get(p.byUserId) ?? "";
  if (typeof p.daysLeft === "number") out.days = p.daysLeft;
  return out;
}

// ===== Receipts, mutes and toasts =====

/** The open notice with this id if the member can see it (ignoring their own mutes and dismissals), else null. */
export async function findVisible(actor: Actor, noticeId: string, now: Date = new Date()): Promise<NoticeRow | null> {
  const row = (await prisma.notice.findFirst({
    where: { id: noticeId, tenantId: actor.tenantId, OR: [{ audienceUserId: null }, { audienceUserId: actor.userId }] },
    select: SELECT,
  })) as NoticeRow | null;
  if (!row) return null;
  if (row.audienceUserId !== actor.userId && ROLE_RANK[actor.role] < (ROLE_RANK[row.audienceMinRole] ?? ROLE_RANK.agent)) return null;
  if (row.resolvedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

type ReceiptField = "seenAt" | "dismissedAt" | "toastedAt";

async function setReceipt(actor: Actor, noticeId: string, field: ReceiptField, now: Date, onlyIfUnset = false): Promise<boolean> {
  const key = { noticeId_userId: { noticeId, userId: actor.userId } };
  if (onlyIfUnset) {
    // The claim: create the receipt if it is missing, then set the field only where it is still empty (one row wins).
    await prisma.noticeReceipt.createMany({ data: [{ noticeId, userId: actor.userId, tenantId: actor.tenantId }], skipDuplicates: true });
    const { count } = await prisma.noticeReceipt.updateMany({ where: { noticeId, userId: actor.userId, tenantId: actor.tenantId, [field]: null }, data: { [field]: now } });
    return count === 1;
  }
  await prisma.noticeReceipt.upsert({ where: key, create: { noticeId, userId: actor.userId, tenantId: actor.tenantId, [field]: now }, update: { [field]: now } });
  return true;
}

export type NoticeUpdate = { seen?: true; dismissed?: true; mute?: true };

/** PATCH /api/notices/[id]: seen, dismissed, or "Don't show these" (mute the notice's kind for this member). */
export async function updateNotice(actor: Actor, noticeId: string, update: NoticeUpdate, now: Date = new Date()): Promise<{ ok: true; kind: string } | null> {
  const row = await findVisible(actor, noticeId, now);
  if (!row) return null;
  if (update.seen) await setReceipt(actor, noticeId, "seenAt", now, true);
  if (update.dismissed) await setReceipt(actor, noticeId, "dismissedAt", now);
  if (update.mute) await muteKind(actor, row.kind, now);
  return { ok: true, kind: row.kind };
}

/** Adds a kind to the member's muted kinds (idempotent; at most 40 kinds kept). */
export async function muteKind(actor: Pick<Actor, "tenantId" | "userId">, kind: string, now: Date = new Date()): Promise<void> {
  const muted = await mutedKinds(actor);
  if (muted.has(kind)) return;
  const next = [...muted, kind].slice(-40);
  await prisma.eddyUserPref.upsert({
    where: { tenantId_userId: { tenantId: actor.tenantId, userId: actor.userId } },
    create: { tenantId: actor.tenantId, userId: actor.userId, mutedNoticeKinds: next, updatedAt: now },
    update: { mutedNoticeKinds: next, updatedAt: now },
  });
}

/**
 * The action_needed notices to toast now, claimed for this member: each is returned once ever (NoticeReceipt.toastedAt),
 * so two tabs, or two polls, never show the same toast twice. Dismissed and muted notices are already out of `notices`.
 */
export async function claimToasts(actor: Actor, notices: readonly NoticeDTO[], now: Date = new Date()): Promise<string[]> {
  const out: string[] = [];
  for (const n of notices) {
    if (n.severity !== "action_needed" || n.toastedAt) continue;
    if (await setReceipt(actor, n.id, "toastedAt", now, true)) out.push(n.id);
  }
  return out;
}

export function isNoticeUpdate(body: Record<string, unknown>): NoticeUpdate | null {
  const keys = Object.keys(body);
  if (keys.length === 0 || !keys.every((k) => k === "seen" || k === "dismissed" || k === "mute")) return null;
  const out: NoticeUpdate = {};
  for (const k of keys) {
    if (body[k] !== true) return null;
    out[k as keyof NoticeUpdate] = true;
  }
  return out;
}
