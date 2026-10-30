/**
 * The setup checklist's next step (docs/EDDY-SPEC.md 6.7, 6.8): for your information, admins, [Do this with Eddy] (opens
 * Eddy with this notice as the reference; the guide's step cards take it from there) and [Open] (the step's own page).
 * Reads getSetup().summary.nextStepId. One notice per step (`setup:<stepId>`); when the next step changes or setup is
 * complete, the earlier one resolves.
 */
import { getSetup, type SetupResult } from "@/lib/setup";
import { SETUP_STEP_KEYS, act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";

export type SetupReader = (tenantId: string, now: Date) => Promise<SetupResult>;
let read: SetupReader = getSetup;
/** Test seam. */
export function setSetupReader(fn: SetupReader | null): void {
  read = fn ?? getSetup;
}

export const producer: NoticeProducer = {
  name: "setup",
  kinds: ["setup_next_step"],
  async run(ctx) {
    const setup = await read(ctx.tenantId, ctx.now);
    const stepId = setup.summary.nextStepId;
    const keep: string[] = [];
    let published = 0;
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
    }
    const resolved = await ctx.resolve({ kinds: ["setup_next_step"], except: keep });
    return { published, resolved };
  },
};
