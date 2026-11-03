/**
 * Spending stopped (docs/EDDY-SPEC.md 6.7): Phase 0's copy, with who stopped it, for every member.
 *
 * Reads SpendControl.freeze and the platform stop (PlatformSetting `spend:platform`) read only: the row is read directly so
 * this producer never makes Phase 0 create a SpendControl row. One notice per scope and level
 * (`spending:workspace:all`, `spending:workspace:assistants`, `spending:platform:<level>`); when spending is turned back on
 * it resolves, and a later stop starts it again as a new notice. The payload names who stopped it by id only; the strip
 * shows their first name.
 */
import { prisma } from "@/lib/db";
import { readPlatformFreeze } from "@/lib/spend/kill";
import { act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

type ControlRow = { freeze: string; frozenByKind: string | null; frozenByUserId: string | null };

const level = (v: unknown): "all" | "assistants" | null => (v === "all" || v === "assistants" ? v : null);

export const producer: NoticeProducer = {
  name: "spending",
  kinds: ["spending_stopped"],
  /** Workspaces whose spending is stopped; all of them while the platform stop is on. */
  async due(tenantIds) {
    if (level((await readPlatformFreeze()).freeze)) return tenantIds;
    const rows = (await prisma.spendControl.findMany({ where: { tenantId: { in: [...tenantIds] }, freeze: { in: ["all", "assistants"] } }, select: { tenantId: true } })) as { tenantId: string }[];
    return rows.map((r) => r.tenantId);
  },
  async run(ctx) {
    const [control, platform] = await Promise.all([
      prisma.spendControl.findUnique({ where: { tenantId: ctx.tenantId }, select: { freeze: true, frozenByKind: true, frozenByUserId: true } }) as Promise<ControlRow | null>,
      readPlatformFreeze(),
    ]);
    const keep: string[] = [];
    let published = 0;
    const ws = level(control?.freeze);
    if (ws) {
      const key = dedupe.spending("workspace", ws);
      keep.push(key);
      const r = await ctx.publish({
        kind: "spending_stopped",
        severity: ws === "all" ? "action_needed" : "heads_up",
        dedupeKey: key,
        audience: { minRole: "agent" },
        subjectType: "workspace",
        subjectId: ctx.tenantId,
        payload: { scope: "workspace", level: ws, byKind: control?.frozenByKind ?? null, byUserId: control?.frozenByUserId ?? null },
        actions: [act.go("/app/settings/spending", "btn.spending_limits")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const pf = level(platform.freeze);
    if (pf) {
      const key = dedupe.spending("platform", pf);
      keep.push(key);
      const r = await ctx.publish({
        kind: "spending_stopped",
        severity: pf === "all" ? "action_needed" : "heads_up",
        dedupeKey: key,
        audience: { minRole: "agent" },
        payload: { scope: "platform", level: pf },
        actions: [act.go("/app/settings/spending", "btn.spending_limits")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const resolved = await ctx.resolve({ kinds: ["spending_stopped"], except: keep });
    return { published, resolved };
  },
};
