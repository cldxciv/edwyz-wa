/**
 * Number quality notice (docs/EDDY-SPEC.md 6.7, D14, 12.1a decision 15: "Phase 0's quality breaker pauses, Eddy reports and
 * explains").
 *
 * Reads, never writes:
 * - Phase 0's open SpendBreaker rows `wa_quality_yellow` / `wa_quality_red` on a phone (src/lib/spend/messaging/quality.ts
 *   opens and clears them);
 * - the broadcasts on that number that Phase 0's safety stop paused, by their stored pause reason
 *   (`number_quality_yellow`, or `number_quality` for a red rating; src/lib/broadcasts/pause.ts).
 * Medium (YELLOW) is a heads-up: "Marketing broadcasts on it are paused until it improves." Low (RED) needs action: "A safety
 * stop paused {count} marketing broadcasts: {names}." with [Review]. Resume is a card, in v2.
 *
 * It lists what the safety stop paused and pauses nothing itself: it never calls the broadcast pause, never writes a
 * broadcast, a breaker or a pause reason. One notice per number and rating (`quality:<phoneId>:<rating>`); it resolves when
 * the breaker clears. Skipped in the demo workspace and when the workspace has no number (scan.ts).
 */
import { pauseReasonKey } from "@/lib/broadcasts/pause";
import { prisma } from "@/lib/db";
import { act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

/** Phase 0's quality breakers (src/lib/spend/messaging/quality.ts QUALITY_KINDS). */
export const QUALITY_BREAKERS = ["wa_quality_yellow", "wa_quality_red"] as const;
/** The pause reasons the safety stop writes for each rating. */
const PAUSED_BY: Record<"YELLOW" | "RED", readonly string[]> = { YELLOW: ["number_quality_yellow"], RED: ["number_quality", "number_quality_yellow"] };
/** Ids kept in the payload (the count is the full number). */
const MAX_LISTED = 10;

type BreakerRow = { id: string; kind: string; scopeId: string };

/** The broadcasts on a number that the quality stop paused, by their stored pause reason (read only). */
export async function broadcastsPausedForQuality(tenantId: string, phoneId: string, rating: "YELLOW" | "RED"): Promise<string[]> {
  const paused = (await prisma.broadcast.findMany({ where: { tenantId, phoneNumberId: phoneId, status: "paused" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 200 })) as { id: string }[];
  if (paused.length === 0) return [];
  const reasons = (await prisma.platformSetting.findMany({ where: { key: { in: paused.map((b) => pauseReasonKey(b.id)) } }, select: { key: true, value: true } })) as { key: string; value: unknown }[];
  const reasonOf = new Map(reasons.map((r) => [r.key, (r.value as { reason?: unknown } | null)?.reason]));
  return paused.filter((b) => PAUSED_BY[rating].includes(String(reasonOf.get(pauseReasonKey(b.id))))).map((b) => b.id);
}

export const producer: NoticeProducer = {
  name: "quality",
  kinds: ["number_quality_dropped"],
  skipDemo: true,
  numberBased: true,
  /** Workspaces with a tripped quality breaker on a number. */
  async due(tenantIds) {
    const rows = await prisma.spendBreaker.groupBy({ by: ["tenantId"], where: { tenantId: { in: [...tenantIds] }, state: "tripped", scopeType: "phone", kind: { in: [...QUALITY_BREAKERS] } } });
    return rows.map((r) => r.tenantId);
  },
  async run(ctx) {
    const breakers = (await prisma.spendBreaker.findMany({
      where: { tenantId: ctx.tenantId, state: "tripped", scopeType: "phone", kind: { in: [...QUALITY_BREAKERS] } },
      select: { id: true, kind: true, scopeId: true },
    })) as BreakerRow[];
    const keep: string[] = [];
    let published = 0;
    // A red breaker on a number outranks a yellow one on the same number.
    const red = new Set(breakers.filter((b) => b.kind === "wa_quality_red").map((b) => b.scopeId));
    for (const b of breakers) {
      const rating = b.kind === "wa_quality_red" ? "RED" : "YELLOW";
      if (rating === "YELLOW" && red.has(b.scopeId)) continue;
      const paused = await broadcastsPausedForQuality(ctx.tenantId, b.scopeId, rating);
      const key = dedupe.quality(b.scopeId, rating);
      keep.push(key);
      const r = await ctx.publish({
        kind: "number_quality_dropped",
        severity: rating === "RED" ? "action_needed" : "heads_up",
        dedupeKey: key,
        audience: { minRole: "admin" },
        subjectType: "phone",
        subjectId: b.scopeId,
        payload: { phoneId: b.scopeId, rating, breakerId: b.id, broadcastIds: paused.slice(0, MAX_LISTED).join(",") },
        count: paused.length,
        actions: [act.go("/app/broadcasts", "btn.review")],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
    }
    const resolved = await ctx.resolve({ kinds: ["number_quality_dropped"], except: keep });
    return { published, resolved };
  },
};
