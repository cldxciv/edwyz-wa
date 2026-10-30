import { getSeams } from "./seams";

/**
 * AI credits a month for a plan that sets none (Eddy 12.1a decision 2: paid plans default to 1,500 credits, adjustable per
 * plan by the platform admin). New and probation workspaces stay under the seeded new-workspace ceiling of 500 credits a
 * month (Phase 0 12.1a decision 3), which the AI gateway applies on top of this.
 */
export const DEFAULT_MONTHLY_CREDITS = 1500;

/** AI_DEFAULT_MONTHLY_CREDITS: the ceiling for workspaces whose plan sets no credit limit. Never unlimited. */
export function defaultMonthlyCreditCeiling(): number {
  const raw = Number(process.env.AI_DEFAULT_MONTHLY_CREDITS);
  return process.env.AI_DEFAULT_MONTHLY_CREDITS?.trim() && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_CREDITS;
}

/** The monthly AI credit limit every caller must enforce: the plan's limit, or the platform ceiling when the plan sets none. */
export async function effectiveCreditLimit(tenantId: string): Promise<number> {
  return (await getSeams().getMonthlyCreditLimit(tenantId)) ?? defaultMonthlyCreditCeiling();
}
