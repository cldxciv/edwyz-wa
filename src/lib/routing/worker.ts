import { prisma } from "@/lib/db";
import type { WorkerModule } from "@/worker/registry";
import { assignConversation } from "./index";
import { sweepNoResponse } from "./reassign";

const DAY_MS = 24 * 60 * 60 * 1000;
const PER_TENANT_LIMIT = 50;
const STOP_REASONS = new Set(["no_agent_available", "outside_hours"]);
const ASSIGNED_REASONS = new Set(["assigned", "fallback", "last_assignee", "contact_owner"]);

/**
 * Assigns unassigned open conversations whose customer wrote in the last day, for tenants with auto-assign on, e.g. after agents
 * come back online or working hours start. A chat is kept per number and contact for good, so a returning customer's chat is
 * found by their last message, not by when the chat was first created. The longest-waiting chat goes first.
 */
export async function sweepUnassigned(now = new Date()): Promise<number> {
  const configs = await prisma.routingConfig.findMany({ where: { autoAssign: true }, select: { tenantId: true } });
  let assigned = 0;
  for (const { tenantId } of configs) {
    const waiting = await prisma.conversation.findMany({
      where: { tenantId, assignedToId: null, status: "open", lastInboundAt: { gte: new Date(now.getTime() - DAY_MS) } },
      orderBy: { lastInboundAt: "asc" },
      take: PER_TENANT_LIMIT,
      select: { id: true },
    });
    for (const { id } of waiting) {
      const result = await assignConversation(tenantId, id, { at: now });
      if (ASSIGNED_REASONS.has(result.reason)) assigned += 1;
      else if (STOP_REASONS.has(result.reason)) break;
    }
  }
  return assigned;
}

export const worker: WorkerModule = {
  queues: {},
  periodic: [
    { name: "routing-sweep", everyMs: 60_000, run: () => sweepUnassigned() },
    { name: "routing-auto-reassign", everyMs: 60_000, run: () => sweepNoResponse() },
  ],
};
