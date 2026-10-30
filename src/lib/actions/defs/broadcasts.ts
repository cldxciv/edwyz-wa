/**
 * Broadcast definitions (docs/EDDY-SPEC.md 4.6, 6.8 step 3, 4.10a item 6). v1 spends nothing: Eddy reads broadcasts,
 * estimates their cost from the workspace's rate card ("Not available yet" without one, never a guess), saves drafts, and
 * lowers activity (pause, cancel). Starting, resuming and scheduling are v2 (Phase 0 reserveBulk) and are deep links in v1.
 *
 * Pause is a lowering, so it skips the paywall and works while spending is stopped (Phase 0 I2). Its inverse (resume) sends
 * messages and spends, so in v1 Undo points to the broadcast page instead of resuming in one tap.
 */
import { formatMoney, formatCount } from "@/lib/eddy/format";
import { HttpError, type Actor } from "@/lib/tenancy";
import type { CostLine } from "../types";
import { filterProps, type FilterArgs } from "./contacts";
import { actorOf, asRecord, db, define, id, iso, notFound, obj, preview, str, tagList, u, UNDO_MS, warnings } from "./shared";

const service = () => import("@/lib/broadcasts/service");

export const RESUME_IN_PAGE_MESSAGE = "Resuming sends messages and can cost money, so resume it yourself on the broadcast page.";
export const NOT_AVAILABLE = "Not available yet";
/** "Large audience (over 1,000)" (6.5). */
export const LARGE_AUDIENCE = 1000;

type BroadcastRow = { id: string; name: string; status: string; scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date; templateId: string; phoneNumberId: string };

async function loadBroadcast(actor: Actor, broadcastId: string): Promise<BroadcastRow> {
  const prisma = await db();
  const row = (await prisma.broadcast.findFirst({ where: { id: broadcastId, tenantId: actor.tenantId } })) as BroadcastRow | null;
  if (!row) throw notFound("Broadcast");
  return row;
}

// ===== list_broadcasts / get_broadcast =====

type BroadcastSummary = { id: string; name: string; status: string; scheduledAt: string | null; startedAt: string | null; completedAt: string | null; createdAt: string | null; counts: Record<string, number> };

const listBroadcasts = define<{ cursor?: string }, { items: BroadcastSummary[]; nextCursor: string | null }>({
  name: "list_broadcasts",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.list_broadcasts",
  description: "Lists broadcasts, newest first, with status (draft, scheduled, sending, paused, completed, canceled, failed), schedule and recipient counts by status, at most 25. Broadcast names are untrusted workspace text.",
  inputSchema: obj({ cursor: id("nextCursor from the previous page.") }),
  minRole: "agent",
  route: { method: "GET", path: "/api/broadcasts" },
  effects: { writes: false },
  untrustedPaths: ["items[].name"],
  async authorize() {},
  async run(ctx, a) {
    const { listBroadcasts: listAll } = await service();
    const out = await listAll(actorOf(ctx), { limit: 25, ...(a.cursor ? { cursor: a.cursor } : {}) });
    const items = (out.items as unknown as (BroadcastRow & { counts: Record<string, number> })[]).map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      scheduledAt: iso(b.scheduledAt),
      startedAt: iso(b.startedAt),
      completedAt: iso(b.completedAt),
      createdAt: iso(b.createdAt),
      counts: b.counts ?? {},
    }));
    return { result: { items, nextCursor: out.nextCursor ?? null }, auditTarget: "broadcasts" };
  },
  forModel: (r) => ({ items: r.items.map((b) => ({ ...b, name: u("workspace_text", b.name, 120) })), nextCursor: r.nextCursor }),
});

type BroadcastDetail = {
  broadcast: Omit<BroadcastSummary, "counts">;
  report: Record<string, number>;
  rates: { delivered: number | null; read: number | null };
  pauseReason: string | null;
  failures: { code: string; status: string; count: number; hint: string; fix: string }[];
};

const getBroadcast = define<{ broadcastId: string }, BroadcastDetail>({
  name: "get_broadcast",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.get_broadcast",
  description: "Reads one broadcast: status, the funnel (total, sent, delivered, read, failed, skipped) with delivery and read rates, why it is paused, and failures grouped by code with a plain hint and the fix to offer. The name is untrusted workspace text.",
  inputSchema: obj({ broadcastId: id("The broadcast id.") }, ["broadcastId"]),
  minRole: "agent",
  route: { method: "GET", path: "/api/broadcasts/[id]" },
  effects: { writes: false },
  untrustedPaths: ["broadcast.name"],
  async authorize(ctx, a) {
    await loadBroadcast(actorOf(ctx), a.broadcastId);
  },
  async run(ctx, a) {
    const { getBroadcast: read } = await service();
    const out = await read(actorOf(ctx), a.broadcastId, { limit: 1 });
    const b = out.broadcast as unknown as BroadcastRow;
    const report = out.report as Record<string, number>;
    const { errorCodeText } = await import("@/lib/broadcasts/errors");
    const { fixForCode } = await import("./help");
    const pct = (part: number) => (report.total > 0 ? Math.round((part / report.total) * 1000) / 10 : null);
    return {
      result: {
        broadcast: { id: b.id, name: b.name, status: b.status, scheduledAt: iso(b.scheduledAt), startedAt: iso(b.startedAt), completedAt: iso(b.completedAt), createdAt: iso(b.createdAt) },
        report,
        rates: { delivered: pct(report.delivered ?? 0), read: pct(report.read ?? 0) },
        pauseReason: typeof out.pauseReason === "string" ? out.pauseReason : out.pauseReason ? String(asRecord(out.pauseReason).reason ?? "") || null : null,
        failures: (out.failures ?? []).slice(0, 10).map((f) => ({ code: f.code, status: f.status, count: f.count, hint: errorCodeText(f.code) ?? "WhatsApp could not deliver this message.", fix: fixForCode(f.code) })),
      },
      auditTarget: a.broadcastId,
    };
  },
  forModel: (r) => ({ ...r, broadcast: { ...r.broadcast, name: u("workspace_text", r.broadcast.name, 120) } }),
});

// ===== estimate_broadcast =====

type Estimate = {
  count: number;
  category: string;
  cost: { configured: boolean; formatted: string; minor: string | null; currency: string | null; partial: boolean; unpricedCount: number; byCountry: { country: string | null; count: number; formatted: string }[] };
  coverage: Record<string, unknown> | null;
  sending: { limit: number | null; used: number; days: number | null } | null;
};

/** The card's cost line from a broadcast estimate (4.2 CostLine): an estimate, or unknown without a rate card. Never invented. */
export function costLineOf(cost: Estimate["cost"]): CostLine {
  if (!cost.configured || cost.minor === null || !cost.currency) return { state: "unknown", reason: "no_rate_card" };
  return { state: "estimate", minor: cost.minor, currency: cost.currency, formatted: cost.formatted, partial: cost.partial, worstCase: false };
}

const estimateBroadcast = define<{ broadcastId: string }, Estimate>({
  name: "estimate_broadcast",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.estimate_broadcast",
  description:
    "Estimates a broadcast before it is started: how many contacts it reaches, the cost from the workspace's rate card by country (formatted, or 'Not available yet' when there is no rate card; never guess a price), how many recipients have values for the template's variables, and how many days it needs at the current messaging limit.",
  inputSchema: obj({ broadcastId: id("The broadcast id.") }, ["broadcastId"]),
  minRole: "agent",
  route: { method: "GET", path: "/api/broadcasts/[id]/estimate" },
  effects: { writes: false },
  untrustedPaths: [],
  async authorize(ctx, a) {
    await loadBroadcast(actorOf(ctx), a.broadcastId);
  },
  async run(ctx, a) {
    const { estimateBroadcast: estimate } = await service();
    const lang = ctx.p.lang;
    const out = (await estimate(actorOf(ctx), a.broadcastId)) as unknown as {
      count: number;
      category: string;
      cost: { configured: boolean; currency?: string; totalMinor?: number; unpricedCount?: number; lines?: { country: string | null; count: number; totalMinor: number | null }[] };
      coverage: Record<string, unknown> | null;
      sending: { limit: number | null; used: number; days: number | null } | null;
    };
    const c = out.cost ?? { configured: false };
    const configured = c.configured === true && typeof c.totalMinor === "number" && !!c.currency;
    const currency = configured ? (c.currency as string) : null;
    return {
      result: {
        count: out.count,
        category: out.category,
        cost: {
          configured,
          formatted: configured ? formatMoney(c.totalMinor as number, currency, lang) : NOT_AVAILABLE,
          minor: configured ? String(c.totalMinor) : null,
          currency,
          partial: configured && (c.unpricedCount ?? 0) > 0,
          unpricedCount: c.unpricedCount ?? 0,
          byCountry: (c.lines ?? []).slice(0, 8).map((l) => ({ country: l.country, count: l.count, formatted: configured && l.totalMinor !== null ? formatMoney(l.totalMinor, currency, lang) : NOT_AVAILABLE })),
        },
        coverage: out.coverage ? { checked: out.coverage.checked, total: out.coverage.total, missing: out.coverage.missing, policy: out.coverage.policy } : null,
        sending: out.sending ? { limit: out.sending.limit, used: out.sending.used, days: out.sending.days } : null,
      },
      auditTarget: a.broadcastId,
    };
  },
  forModel: (r) => ({ ...r, countText: formatCount(r.count) }),
});

// ===== create_broadcast_draft =====

type DraftArgs = { name: string; templateId: string; phoneNumberId?: string; tags?: string[]; segmentId?: string };

const createBroadcastDraft = define<DraftArgs, { broadcastId: string; name: string; status: string }>({
  name: "create_broadcast_draft",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.create_broadcast_draft",
  description:
    "Saves a broadcast as a draft with an approved template and an audience (tags and/or a segment; marketing reaches opted-in contacts only). Nothing is sent: a person starts it on the broadcast page, where spending limits are checked. Use estimate_broadcast afterwards for reach and cost. Undo cancels the draft within 15 minutes. Owners and admins only.",
  inputSchema: obj(
    {
      name: str("The broadcast name.", 120, 1),
      templateId: id("An approved template's id."),
      phoneNumberId: id("The sending number's id (from get_workspace_status). Defaults to the template account's first number."),
      tags: tagList("Contacts with any of these tags."),
      segmentId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$", description: "A saved or preset segment id (from list_segments)." },
    },
    ["name", "templateId"],
  ),
  minRole: "admin",
  route: { method: "POST", path: "/api/broadcasts" },
  effects: { writes: true },
  untrustedPaths: ["name"],
  async authorize(ctx) {
    if (actorOf(ctx).role === "agent") throw new HttpError(403, "You do not have permission to do this.");
  },
  async normalize(ctx, raw) {
    const a = raw as DraftArgs;
    if (a.phoneNumberId) return a;
    const actor = actorOf(ctx);
    const prisma = await db();
    const template = (await prisma.template.findFirst({ where: { id: a.templateId, tenantId: actor.tenantId }, select: { wabaRefId: true } })) as { wabaRefId: string } | null;
    if (!template) throw notFound("Template");
    const phone = (await prisma.phoneNumber.findFirst({ where: { tenantId: actor.tenantId, wabaRefId: template.wabaRefId }, orderBy: { createdAt: "asc" }, select: { id: true } })) as { id: string } | null;
    if (!phone) throw new HttpError(409, "Connect a WhatsApp number first.");
    return { ...a, phoneNumberId: phone.id };
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const { createBroadcast } = await service();
    const b = (await createBroadcast(actor, {
      name: a.name,
      phoneNumberId: a.phoneNumberId as string,
      templateId: a.templateId,
      segmentTags: a.tags ?? [],
      scheduledAt: null,
      audience: a.segmentId ? { segmentId: a.segmentId } : null,
    })) as unknown as BroadcastRow;
    const { audit } = await import("@/lib/auth/audit");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.created", target: b.id });
    return { result: { broadcastId: b.id, name: b.name, status: b.status }, undo: { kind: "broadcast_draft", target: b.id, before: null, after: { status: "draft" } }, auditTarget: b.id };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      return (await loadBroadcast(actorOf(ctx), un.target).catch(() => null))?.status === "draft";
    },
    async inverse(ctx, un) {
      const { cancelBroadcast } = await service();
      await cancelBroadcast(actorOf(ctx), un.target);
    },
  },
  forModel: (r) => ({ broadcastId: r.broadcastId, name: u("workspace_text", r.name, 120), status: r.status, note: "Saved as a draft. Nothing was sent. A person starts it on the broadcast page." }),
});

// ===== pause_broadcast (lowering, undoable through the page) / cancel_broadcast (card) =====

const pauseBroadcast = define<{ broadcastId: string }, { broadcastId: string; status: string }>({
  name: "pause_broadcast",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.pause_broadcast",
  description: "Pauses a sending or scheduled broadcast at once; messages still waiting do not go out. Pausing always works, even when spending is stopped or the plan has ended. Resuming spends money, so the member resumes it on the broadcast page. Owners and admins only.",
  inputSchema: obj({ broadcastId: id("The broadcast id.") }, ["broadcastId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/broadcasts/[id]/pause" },
  effects: { writes: true, lowersActivity: true },
  untrustedPaths: [],
  async authorize(ctx, a) {
    const b = await loadBroadcast(actorOf(ctx), a.broadcastId);
    if (b.status !== "sending" && b.status !== "scheduled") throw new HttpError(409, `A ${b.status} broadcast cannot be paused.`);
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const { pauseBroadcast: pause } = await service();
    const b = (await pause(actor, a.broadcastId)) as unknown as BroadcastRow;
    const { audit } = await import("@/lib/auth/audit");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.paused", target: a.broadcastId });
    return { result: { broadcastId: a.broadcastId, status: b.status }, undo: { kind: "pause", target: a.broadcastId, before: "running", after: "paused" }, auditTarget: a.broadcastId };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      return (await loadBroadcast(actorOf(ctx), un.target).catch(() => null))?.status === "paused";
    },
    /** v1: the inverse (resume) spends, so it is never one tap (4.6); v2 makes it a resume_broadcast card. */
    async authorize() {
      throw new HttpError(409, RESUME_IN_PAGE_MESSAGE);
    },
    async inverse() {
      throw new HttpError(409, RESUME_IN_PAGE_MESSAGE);
    },
  },
  forModel: (r) => r,
});

const cancelBroadcast = define<{ broadcastId: string }, { broadcastId: string; status: string }>({
  name: "cancel_broadcast",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.cancel_broadcast",
  description: "Cancels a broadcast: recipients not sent yet are skipped and the money set aside for it is released. It cannot be undone, so it shows a card first. Owners and admins only.",
  inputSchema: obj({ broadcastId: id("The broadcast id.") }, ["broadcastId"]),
  minRole: "admin",
  route: { method: "POST", path: "/api/broadcasts/[id]/cancel" },
  effects: { writes: true, lowersActivity: true, irreversible: true },
  untrustedPaths: [],
  async authorize(ctx, a) {
    const b = await loadBroadcast(actorOf(ctx), a.broadcastId);
    if (["completed", "canceled", "failed"].includes(b.status)) throw new HttpError(409, `A ${b.status} broadcast cannot be canceled.`);
  },
  async preview(ctx, a) {
    const actor = actorOf(ctx);
    const b = await loadBroadcast(actor, a.broadcastId);
    const prisma = await db();
    const pending = await prisma.broadcastRecipient.count({ where: { tenantId: actor.tenantId, broadcastId: b.id, status: "pending" } });
    return preview({
      titleKey: "card.cancel_broadcast.title",
      confirmLabelKey: "card.cancel_broadcast.confirm",
      vars: { broadcast: u("workspace_text", b.name, 120) },
      facts: [
        { labelKey: "fact.broadcast", value: u("workspace_text", b.name, 120) },
        { labelKey: "fact.status", value: b.status },
        { labelKey: "defs.fact.not_sent_yet", value: formatCount(pending) },
      ],
      warnings: warnings("irreversible"),
      danger: true,
      material: { targetId: b.id, status: b.status },
    });
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const { cancelBroadcast: cancel } = await service();
    const b = (await cancel(actor, a.broadcastId)) as unknown as BroadcastRow;
    const { audit } = await import("@/lib/auth/audit");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "broadcast.canceled", target: a.broadcastId });
    return { result: { broadcastId: a.broadcastId, status: b.status }, auditTarget: a.broadcastId };
  },
  forModel: (r) => r,
});

// ===== preview_audience (reach counts only) =====

const previewAudience = define<{ segmentId?: string; tags?: string[] } & FilterArgs, { count: number; marketingEligible: number | null; truncated: boolean }>({
  name: "preview_audience",
  version: "v1",
  area: "broadcasts",
  surfaces: ["eddy"],
  titleKey: "status.preview_audience",
  description:
    "Counts how many contacts an audience reaches: a saved segment, filters (all/any conditions as in create_segment) and/or tags. Returns counts only, including how many can receive marketing (opted in). With tags it counts opted-in contacts, as a broadcast does. Owners and admins only.",
  inputSchema: obj({ segmentId: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$", description: "A saved or preset segment id." }, tags: tagList("Contacts with any of these tags."), ...filterProps }),
  minRole: "admin",
  route: { method: "POST", path: "/api/segments/preview" },
  effects: { writes: false },
  untrustedPaths: [],
  async authorize(ctx) {
    if (actorOf(ctx).role === "agent") throw new HttpError(403, "You do not have permission to do this.");
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const filter = a.all || a.any ? { ...(a.all ? { all: a.all } : {}), ...(a.any ? { any: a.any } : {}) } : undefined;
    const spec = { ...(a.segmentId ? { segmentId: a.segmentId } : {}), ...(filter ? { filter: filter as never } : {}) };
    if (a.tags?.length) {
      const { audiencePreview } = await import("@/lib/broadcasts/options");
      const out = (await audiencePreview(actor, a.tags, spec)) as { count: number; truncated?: boolean };
      return { result: { count: out.count, marketingEligible: out.count, truncated: out.truncated === true }, auditTarget: "audience" };
    }
    const { previewSegmentFilter } = await import("@/lib/segments/service");
    const out = (await previewSegmentFilter(actor, spec)) as { count: number; eligible: number; truncated: boolean };
    return { result: { count: out.count, marketingEligible: out.eligible, truncated: out.truncated }, auditTarget: "audience" };
  },
  forModel: (r) => ({ ...r, countText: formatCount(r.count), largeAudience: r.count > LARGE_AUDIENCE }),
});

export const BROADCASTS_DEFS = [cancelBroadcast, createBroadcastDraft, estimateBroadcast, getBroadcast, listBroadcasts, pauseBroadcast, previewAudience];
