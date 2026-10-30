import { prisma } from "@/lib/db";
import { getBillingStatus } from "@/lib/billing/status";

export type AiAgentSeams = {
  /** Monthly ai_credits allowed for the workspace, or null when not configured (the platform default ceiling then applies). */
  getMonthlyCreditLimit(tenantId: string): Promise<number | null>;
};

const defaults: AiAgentSeams = {
  async getMonthlyCreditLimit(tenantId) {
    const status = await getBillingStatus(tenantId);
    if (status.state === "exempt") return null;
    const select = { aiCreditsMonthly: true } as const;
    const plan = status.planId
      ? await prisma.plan.findUnique({ where: { id: status.planId }, select })
      : status.state === "trialing"
        ? await prisma.plan.findUnique({ where: { code: "trial" }, select })
        : null;
    return plan?.aiCreditsMonthly ?? null;
  },
};

let current: AiAgentSeams = defaults;

export const getSeams = (): AiAgentSeams => current;

/** The coordinator can replace plan lookup here without touching this package. */
export function registerAiAgentSeams(overrides: Partial<AiAgentSeams>): void {
  current = { ...current, ...overrides };
}

export function resetAiAgentSeams(): void {
  current = defaults;
}
