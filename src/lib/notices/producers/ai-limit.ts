/**
 * AI credits at 80% and 100% (docs/EDDY-SPEC.md 6.7; Phase 0 6.4): admins only, matching Phase 0's claimOnce periods.
 *
 * Reads Phase 0's AI counters through the read-only spend bridge (headroom('ai'), src/lib/actions/spend-bridge.ts), for
 * the day and the month in the workspace's time zone. The dedupe key is Phase 0's own (`spend-ai:<tenantId>:<period>:<level>`,
 * aiNoticeKey), so whoever writes first owns the one row: when Phase 0 already wrote it, publishNotice leaves it alone.
 * Reaching 100% resolves that period's 80% notice; a new period, or a raised limit, resolves the old ones.
 *
 * Only workspaces that already have their SpendControl row are read, so this producer never makes Phase 0 create one.
 */
import { prisma } from "@/lib/db";
import { aiHeadroom, type AiHeadroom } from "@/lib/actions/spend-bridge";
import { aiNoticeKey } from "@/lib/spend/exec/ai";
import { dayKey, monthKey } from "@/lib/spend/periods";
import { act } from "../kinds";
import type { NoticeProducer } from "../scan";

export type HeadroomReader = (tenantId: string, now: Date) => Promise<AiHeadroom>;
let read: HeadroomReader = (tenantId, now) => aiHeadroom(tenantId, { now });
/** Test seam. */
export function setAiHeadroomReader(fn: HeadroomReader | null): void {
  read = fn ?? ((tenantId, now) => aiHeadroom(tenantId, { now }));
}

/** 100, 80 or null for used credits against a limit (no limit: null). */
export function aiLevel(used: number, limit: number | null): 80 | 100 | null {
  if (limit === null || limit <= 0) return null;
  if (used >= limit) return 100;
  return used * 100 >= limit * 80 ? 80 : null;
}

export const producer: NoticeProducer = {
  name: "ai-limit",
  kinds: ["ai_limit_80", "ai_limit_100"],
  async run(ctx) {
    const control = await prisma.spendControl.findUnique({ where: { tenantId: ctx.tenantId }, select: { tenantId: true } });
    if (!control) return {};
    const h = await read(ctx.tenantId, ctx.now);
    const periods = [
      { period: "month" as const, key: monthKey(ctx.now, h.timezone), used: h.usedMonth, limit: h.limitMonth },
      { period: "day" as const, key: dayKey(ctx.now, h.timezone), used: h.usedToday, limit: h.limitToday },
    ];
    const keep: string[] = [];
    let published = 0;
    for (const p of periods) {
      const level = aiLevel(p.used, p.limit);
      if (!level) continue;
      const key = aiNoticeKey(ctx.tenantId, p.key, level);
      keep.push(key);
      const r = await ctx.publish({
        kind: level === 100 ? "ai_limit_100" : "ai_limit_80",
        severity: level === 100 ? "action_needed" : "heads_up",
        dedupeKey: key,
        audience: { minRole: "admin" },
        payload: { period: p.period, periodKey: p.key, level, used: p.used, limit: p.limit },
        actions: [act.go("/app/settings/spending", "btn.see_spending_limits")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const resolved = await ctx.resolve({ kinds: ["ai_limit_80", "ai_limit_100"], except: keep });
    return { published, resolved };
  },
};
