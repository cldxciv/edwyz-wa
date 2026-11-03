/**
 * The setup checklist's next step (docs/EDDY-SPEC.md 6.7, 6.8): for your information, admins, [Do this with Eddy] (opens
 * Eddy with this notice as the reference; the guide's step cards take it from there) and [Open] (the step's own page).
 * Reads getSetup().summary.nextStepId. One notice per step (`setup:<stepId>`); when the next step changes or setup is
 * complete, the earlier one resolves.
 *
 * getSetup reads a dozen tables, so the cursor ({step, since, at}: the next step, null when complete, since when it has been
 * that step, and the last check) spaces the checks out: a checklist that changed in the last day (or was never checked) is
 * checked on every scan visit; a settled one (the same step, or complete, for a day: finished and abandoned workspaces) every
 * SETTLED_RECHECK_MS. The Eddy panel's setup guide reads GET /api/setup live, so only this strip line can lag.
 */
import { prisma } from "@/lib/db";
import { getSetup, type SetupResult } from "@/lib/setup";
import { SETUP_STEP_KEYS, act, dedupe } from "../kinds";
import type { Json, NoticeProducer } from "../scan";

/** A checklist whose next step has not changed for this long is settled. */
export const SETTLED_AFTER_MS = 24 * 60 * 60_000;
/** How often a settled checklist is checked again. */
export const SETTLED_RECHECK_MS = 6 * 60 * 60_000;

type SetupCursor = { step: string | null; since: number; at: number };

function asSetupCursor(c: Json | null): SetupCursor | null {
  if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.since !== "string" || typeof c.at !== "string") return null;
  const since = Date.parse(c.since);
  const at = Date.parse(c.at);
  if (Number.isNaN(since) || Number.isNaN(at)) return null;
  return { step: typeof c.step === "string" ? c.step : null, since, at };
}

/** Settled, and checked less than SETTLED_RECHECK_MS ago: nothing to check on this visit. */
export const setupResting = (c: Json | null, now: Date): boolean => {
  const s = asSetupCursor(c);
  return !!s && now.getTime() - s.since >= SETTLED_AFTER_MS && now.getTime() - s.at < SETTLED_RECHECK_MS;
};

export type SetupReader = (tenantId: string, now: Date) => Promise<SetupResult>;
let read: SetupReader = getSetup;
/** Test seam. */
export function setSetupReader(fn: SetupReader | null): void {
  read = fn ?? getSetup;
}

export const producer: NoticeProducer = {
  name: "setup",
  kinds: ["setup_next_step"],
  // The cursor decides alone: an open setup notice of a settled checklist waits for its re-check like the rest.
  dueIsComplete: true,
  /** Every workspace but those whose checklist is resting (above). */
  async due(tenantIds, now) {
    const states = (await prisma.noticeScanState.findMany({ where: { tenantId: { in: [...tenantIds] }, scanner: "setup" }, select: { tenantId: true, cursor: true } })) as { tenantId: string; cursor: Json }[];
    const resting = new Set(states.filter((s) => setupResting(s.cursor, now)).map((s) => s.tenantId));
    return tenantIds.filter((id) => !resting.has(id));
  },
  async run(ctx) {
    const setup = await read(ctx.tenantId, ctx.now);
    const stepId = setup.summary.nextStepId;
    const keep: string[] = [];
    let published = 0;
    let standing: string | null = null;
    if (stepId && SETUP_STEP_KEYS.has(stepId)) {
      const step = setup.steps.find((s) => s.id === stepId);
      const key = dedupe.setup(stepId);
      keep.push(key);
      const r = await ctx.publish({
        kind: "setup_next_step",
        severity: "fyi",
        dedupeKey: key,
        audience: { minRole: "admin" },
        payload: { stepId },
        actions: [act.askEddy("btn.do_with_eddy"), ...(step?.href ? [act.go(step.href, "btn.open")] : [])],
      });
      if (r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated") published++;
      if (r.outcome === "unchanged") standing = r.id;
    }
    const resolved = await ctx.resolve({ kinds: ["setup_next_step"], except: keep });
    // Written when the step changes, and on each check of a settled checklist (its next re-check counts from now).
    const prev = asSetupCursor(ctx.cursor);
    const at = ctx.now.toISOString();
    const current = stepId ?? null;
    let cursor: Json | undefined;
    if (!prev || prev.step !== current) {
      // With no cursor yet, a notice already standing for this step dates it (a checklist abandoned long ago is settled).
      const row = !prev && standing ? ((await prisma.notice.findFirst({ where: { id: standing, tenantId: ctx.tenantId }, select: { createdAt: true } })) as { createdAt: Date } | null) : null;
      cursor = { step: current, since: row && row.createdAt < ctx.now ? row.createdAt.toISOString() : at, at };
    } else if (ctx.now.getTime() - prev.since >= SETTLED_AFTER_MS) {
      cursor = { step: current, since: new Date(prev.since).toISOString(), at };
    }
    return { published, resolved, ...(cursor ? { cursor } : {}) };
  },
};
