import { computeSteps, summarize, type SetupFacts, type SetupStep, type SetupSummary } from "./checklist";
import { getDismissed } from "./dismissed";
import { gatherFacts } from "./facts";

export * from "./checklist";
export { dismissedKey, getDismissed, setDismissed } from "./dismissed";

export type SetupResult = { steps: SetupStep[]; summary: SetupSummary };

export function buildSetup(facts: SetupFacts, dismissed: string[]): SetupResult {
  const steps = computeSteps(facts, dismissed);
  return { steps, summary: summarize(steps) };
}

/** The tenant's setup checklist computed from the database. */
export async function getSetup(tenantId: string, now = new Date()): Promise<SetupResult> {
  const [facts, dismissed] = await Promise.all([gatherFacts(tenantId, now), getDismissed(tenantId)]);
  return buildSetup(facts, dismissed);
}
