/**
 * Template notices (docs/EDDY-SPEC.md 6.7): approved [Send it], rejected [Fix with Eddy] [Review], paused [Review].
 *
 * Reads Template.status and updatedAt through a cursor ({at, id}: the last template seen, in updatedAt then id order). The
 * first run in a workspace looks back 24 hours. One notice per template and status (`template:<id>:<status>`); when a
 * template moves to another status, its earlier template notices resolve. The rejection reason is never copied: [Fix with
 * Eddy] opens Eddy with the notice id, and Eddy reads the reason through a tool as UntrustedText (6.7 critic).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { NoticeKind } from "@/lib/eddy/contract";
import { KIND_SPECS, act, dedupe } from "../kinds";
import type { Json, NoticeProducer } from "../scan";

const FIRST_LOOKBACK_MS = 24 * 60 * 60_000;
const PAGE = 200;

const KINDS: readonly NoticeKind[] = ["template_approved", "template_rejected", "template_paused"];

/** The notice kind of a template status, or null for statuses that need no notice (draft, pending). */
export function templateKind(status: string): NoticeKind | null {
  if (status === "approved") return "template_approved";
  if (status === "rejected") return "template_rejected";
  if (status === "paused" || status === "disabled" || status === "flagged") return "template_paused";
  return null;
}

type Cursor = { at: string; id: string };
const asCursor = (c: Json | null): Cursor | null => (c && typeof c === "object" && !Array.isArray(c) && typeof c.at === "string" && typeof c.id === "string" ? { at: c.at, id: c.id } : null);

export const producer: NoticeProducer = {
  name: "templates",
  kinds: KINDS,
  /** Workspaces with a template changed after their cursor (24 hours back before the first run): two queries for the batch. */
  async due(tenantIds, now) {
    const states = (await prisma.noticeScanState.findMany({ where: { tenantId: { in: [...tenantIds] }, scanner: "templates" }, select: { tenantId: true, cursor: true } })) as { tenantId: string; cursor: Json }[];
    const cursors = new Map(states.map((s) => [s.tenantId, asCursor(s.cursor)]));
    const lookback = new Date(now.getTime() - FIRST_LOOKBACK_MS);
    const changed = tenantIds.flatMap((tenantId): Prisma.TemplateWhereInput[] => {
      const c = cursors.get(tenantId);
      if (!c) return [{ tenantId, updatedAt: { gte: lookback } }];
      const since = new Date(c.at);
      return [{ tenantId, updatedAt: { gt: since } }, { tenantId, updatedAt: since, id: { gt: c.id } }];
    });
    const rows = await prisma.template.groupBy({ by: ["tenantId"], where: { OR: changed } });
    return rows.map((r) => r.tenantId);
  },
  async run(ctx) {
    const cursor = asCursor(ctx.cursor) ?? { at: new Date(ctx.now.getTime() - FIRST_LOOKBACK_MS).toISOString(), id: "" };
    const since = new Date(cursor.at);
    const rows = (await prisma.template.findMany({
      where: { tenantId: ctx.tenantId, OR: [{ updatedAt: { gt: since } }, { updatedAt: since, id: { gt: cursor.id } }] },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: PAGE,
      select: { id: true, status: true, updatedAt: true },
    })) as { id: string; status: string; updatedAt: Date }[];
    let published = 0;
    let resolved = 0;
    for (const t of rows) {
      const kind = templateKind(t.status);
      const key = kind ? dedupe.template(t.id, t.status) : null;
      // Whatever the template was before, those notices no longer hold.
      resolved += await ctx.resolve({ kinds: KINDS, prefix: `template:${t.id}:`, except: key ? [key] : [] });
      if (!kind || !key) continue;
      const actions =
        kind === "template_approved"
          ? [act.go("/app/broadcasts/new", "btn.send_it")]
          : kind === "template_rejected"
            ? [act.askEddy("btn.fix_with_eddy"), act.go("/app/templates", "btn.review")]
            : [act.go("/app/templates", "btn.review")];
      const r = await ctx.publish({
        kind,
        severity: KIND_SPECS[kind].severity,
        dedupeKey: key,
        audience: { minRole: KIND_SPECS[kind].minRole },
        subjectType: "template",
        subjectId: t.id,
        payload: { templateId: t.id, status: t.status },
        actions,
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const last = rows[rows.length - 1];
    return { cursor: last ? { at: last.updatedAt.toISOString(), id: last.id } : cursor, published, resolved };
  },
};
